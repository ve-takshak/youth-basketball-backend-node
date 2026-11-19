const Coach = require("../../models/Coach");
const Team = require("../../models/Team");
const { WEEK_DAYS } = require("../../models/Team");
const Player = require("../../models/Player");
const { ROLES } = require("../../helpers/constants");

// Coach app ka Home (dashboard).
//   1. header (coach + club)          7. parents jo app mein nahi aaye
//   2. my teams                       8. birthdays (agle 7 din)
//   3. is hafte ka calendar            9. team full / almost full
//   4. aaj ki trainings               10. quick status (dummy for now)
//   5. players summary
//   6. health alerts
//
// NOTE: Session / Attendance models abhi nahi hain.
//       quickStatus abhi team ke active players se build hota hai,
//       present/absent 0 aayega jab tak attendance model na bane.

const TIME_ZONE = "Asia/Jerusalem";
const LIST_LIMIT = 10;
const ALMOST_FULL_RATIO = 0.9;

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

const fileUrlOf = (value) => {
    if (!value) return "";
    if (value.startsWith("http")) return value;
    const appUrl = process.env.APP_URL || "http://localhost:5000";
    return `${appUrl}/${value.replace(/\\/g, "/")}`;
};

// ---------------------------------------------------------------------------
// Date helpers (sab "YYYY-MM-DD" string mein, Israel time)
// ---------------------------------------------------------------------------

const nowInClubTime = () => {
    const now = new Date();
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short" }).format(now);
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" }).format(now));
    return { date, day: weekday.slice(0, 3).toLowerCase(), hour };
};

const addDays = (dateStr, n) => {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

const greetingFor = (hour) => (hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening");

const nextTrainingFrom = (days, today) => {
    if (!Array.isArray(days) || days.length === 0) return null;
    const todayIndex = WEEK_DAYS.indexOf(today.day);
    for (let offset = 0; offset < 7; offset += 1) {
        const day = WEEK_DAYS[(todayIndex + offset) % 7];
        if (days.includes(day)) {
            return { day, date: addDays(today.date, offset), isToday: offset === 0, isTomorrow: offset === 1 };
        }
    }
    return null;
};

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

const formatVenue = (venue) => {
    if (!venue || !venue._id) return null;
    return { _id: venue._id, name: venue.name, address: venue.address || "", type: venue.type };
};

const fullName = (u) => `${u?.firstname || ""} ${u?.lastname || ""}`.trim();

const playerBrief = (player, teamName) => ({
    playerId: player._id,
    firstname: player.userId?.firstname || "",
    lastname: player.userId?.lastname || "",
    profile_image: player.userId?.profile_image || "",
    team: player.teamId ? { _id: player.teamId, name: teamName || "" } : null,
});

// ---------------------------------------------------------------------------
// Dashboard builder (DB-free)
// ---------------------------------------------------------------------------

const buildDashboard = ({ teams, players, today, now = new Date() }) => {
    const teamNameOf = Object.fromEntries(teams.map((t) => [String(t._id), t.name]));
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // ---- Har team ke counts ----
    const teamCounts = {};
    players.forEach((p) => {
        const key = String(p.teamId);
        if (!teamCounts[key]) teamCounts[key] = { active: 0, waitlisted: 0, pending: 0, inactive: 0 };
        if (teamCounts[key][p.status] !== undefined) teamCounts[key][p.status] += 1;
    });
    const countsOf = (teamId) => teamCounts[String(teamId)] || { active: 0, waitlisted: 0, pending: 0, inactive: 0 };

    // 2. My teams
    const teamList = teams.map((team) => {
        const c = countsOf(team._id);
        const capacity = team.teamCapacity ?? 20;
        return {
            _id: team._id,
            name: team.name,
            category: team.categoryId && team.categoryId._id ? { _id: team.categoryId._id, name: team.categoryId.name } : null,
            gender: team.gender || "mixed",
            teamCapacity: capacity,
            playersRegistered: c.active + c.waitlisted + c.pending + c.inactive,
            activePlayers: c.active,
            waitlistedPlayers: c.waitlisted,
            inactivePlayers: c.inactive,
            fillPercent: capacity ? Math.min(100, Math.round((c.active / capacity) * 100)) : 0,
            homeVenue: formatVenue(team.homeVenueId),
            preferredTrainingDays: team.preferredTrainingDays || [],
            nextTraining: nextTrainingFrom(team.preferredTrainingDays, today),
        };
    });

    // 3. Week calendar
    const weekStart = addDays(today.date, -WEEK_DAYS.indexOf(today.day));
    const weekCalendar = WEEK_DAYS.map((day, index) => ({
        day,
        date: addDays(weekStart, index),
        isToday: day === today.day,
        teams: teamList
            .filter((t) => t.preferredTrainingDays.includes(day))
            .map((t) => ({ _id: t._id, name: t.name, venue: t.homeVenue ? t.homeVenue.name : "" })),
    }));

    // 4. Aaj ki trainings (count ke saath)
    const todaySessions = teams
        .filter((team) => (team.preferredTrainingDays || []).includes(today.day))
        .map((team) => {
            const c = countsOf(team._id);
            return {
                team: { _id: team._id, name: team.name },
                category: team.categoryId && team.categoryId._id ? { _id: team.categoryId._id, name: team.categoryId.name } : null,
                venue: formatVenue(team.homeVenueId),
                date: today.date,
                day: today.day,
                startTime: null,
                endTime: null,
                totalPlayers: c.active + c.waitlisted + c.inactive, // team ke saare players
                activePlayers: c.active,       // session mein expected
                waitlistedPlayers: c.waitlisted,
                inactivePlayers: c.inactive,
                playersExpected: c.active,
            };
        });

    // 5. Players summary
    const sumTeams = (key) => teamList.reduce((total, t) => total + t[key], 0);
    const playersSummary = {
        totalPlayers: sumTeams("playersRegistered"),
        activePlayers: sumTeams("activePlayers"),
        waitlistedPlayers: sumTeams("waitlistedPlayers"),
        inactivePlayers: sumTeams("inactivePlayers"),
        newThisWeek: players.filter((p) => p.createdAt && new Date(p.createdAt) >= weekAgo).length,
    };

    // 6. Health alerts
    const withNotes = players.filter((p) => p.medicalNotes && ["active", "waitlisted"].includes(p.status));
    const healthAlerts = {
        count: withNotes.length,
        list: withNotes.slice(0, LIST_LIMIT).map((p) => ({
            ...playerBrief(p, teamNameOf[String(p.teamId)]),
            medicalNotes: p.medicalNotes,
        })),
    };

    // 7. Parents not on app
    const parentMap = {};
    players.forEach((p) => {
        (p.parents || []).forEach((link) => {
            const parentUser = link.parentId?.userId;
            if (!parentUser || parentUser.is_verify) return;
            const key = String(link.parentId._id);
            if (!parentMap[key]) {
                parentMap[key] = {
                    parentId: link.parentId._id,
                    firstname: parentUser.firstname || "",
                    lastname: parentUser.lastname || "",
                    countryCode: parentUser.mobileNumber ? parentUser.countryCode : "",
                    mobileNumber: parentUser.mobileNumber || "",
                    children: [],
                };
            }
            parentMap[key].children.push({ playerId: p._id, name: fullName(p.userId) });
        });
    });
    const pendingParents = Object.values(parentMap);
    const parentsNotOnApp = { count: pendingParents.length, list: pendingParents.slice(0, LIST_LIMIT) };

    // 8. Birthdays
    const nextSevenDays = Array.from({ length: 7 }, (_, i) => addDays(today.date, i));
    const birthdays = [];
    players.forEach((p) => {
        const dob = p.userId?.birthDate;
        if (!dob) return;
        const dobStr = new Date(dob).toISOString().slice(0, 10);
        const date = nextSevenDays.find((d) => d.slice(5) === dobStr.slice(5));
        if (!date) return;
        birthdays.push({
            ...playerBrief(p, teamNameOf[String(p.teamId)]),
            date,
            isToday: date === today.date,
            turningAge: Number(date.slice(0, 4)) - Number(dobStr.slice(0, 4)),
        });
    });
    birthdays.sort((a, b) => a.date.localeCompare(b.date));

    // 9. Capacity alerts
    const capacityAlerts = teamList
        .filter((t) => t.teamCapacity && t.activePlayers >= Math.ceil(t.teamCapacity * ALMOST_FULL_RATIO))
        .map((t) => ({
            team: { _id: t._id, name: t.name },
            activePlayers: t.activePlayers,
            teamCapacity: t.teamCapacity,
            waitlistedPlayers: t.waitlistedPlayers,
            status: t.activePlayers >= t.teamCapacity ? "full" : "almost_full",
        }));

    return {
        greeting: greetingFor(today.hour),
        today: { date: today.date, day: today.day },
        teams: { assignedCount: teamList.length, list: teamList },
        weekCalendar,
        todaySessions,
        playersSummary,
        healthAlerts,
        parentsNotOnApp,
        birthdays,
        capacityAlerts,
    };
};

// ---------------------------------------------------------------------------
// Quick status (DUMMY for now — Session/Attendance model pending)
// Har session mein:
//   totalPlayers   = team ke saare players (active + waitlisted + inactive)
//   activePlayers  = session ke liye expected
//   present/absent = abhi 0 (attendance model banne tak)
//   notMarked      = active players jo abhi mark nahi hue
//   players[]      = per-player status
// ---------------------------------------------------------------------------

const buildQuickStatus = ({ teams, players, today }) => {
    const teamNameOf = Object.fromEntries(teams.map((t) => [String(t._id), t.name]));

    const byTeam = {};
    players.forEach((p) => {
        const key = String(p.teamId);
        if (!byTeam[key]) byTeam[key] = { active: [], waitlisted: [], inactive: [] };
        if (byTeam[key][p.status]) byTeam[key][p.status].push(p);
    });

    const sessions = teams
        .filter((team) => (team.preferredTrainingDays || []).includes(today.day))
        .map((team) => {
            const bucket = byTeam[String(team._id)] || { active: [], waitlisted: [], inactive: [] };
            const activeList = bucket.active;

            const playerList = activeList.map((p) => ({
                playerId: p._id,
                firstname: p.userId?.firstname || "",
                lastname: p.userId?.lastname || "",
                profile_image: p.userId?.profile_image || "",
                status: "not_marked", // attendance model banne tak
            }));

            const totalPlayers = activeList.length + bucket.waitlisted.length + bucket.inactive.length;

            return {
                sessionId: null, // Session model banne ke baad real id aayegi
                team: { _id: team._id, name: teamNameOf[String(team._id)] || team.name },
                date: today.date,
                day: today.day,
                startTime: null,
                endTime: null,
                totalPlayers,                       // team ke saare players
                activePlayers: activeList.length,   // session ke liye expected
                waitlistedPlayers: bucket.waitlisted.length,
                inactivePlayers: bucket.inactive.length,
                present: 0,
                absent: 0,
                notMarked: activeList.length,
                players: playerList,
            };
        });

    return { date: today.date, day: today.day, sessions };
};

// ---------------------------------------------------------------------------
// GET /api/user/coach/dashboard   (logged-in coach)
// ---------------------------------------------------------------------------

const getCoachDashboard = async (req, res) => {
    try {
        if (req.user.role !== ROLES.COACH) return sendError(res, 403, "Only coaches can view this dashboard.");

        // ---- Coach + club ----
        const coach = await Coach.findOne({ userId: req.user._id })
            .populate("userId", "firstname lastname profile_image")
            .populate("clubId", "name clubCode logo theme");
        if (!coach) return sendError(res, 404, "Coach profile not found.");

        // ---- Coach ki active teams ----
        const teams = await Team.find({ coachId: coach._id, status: "active" })
            .populate("categoryId", "name")
            .populate("homeVenueId", "name address type")
            .sort({ name: 1 });

        // ---- In teams ke players ----
        const teamIds = teams.map((t) => t._id);
        const players = teamIds.length
            ? await Player.find({ teamId: { $in: teamIds }, status: { $ne: "left" } })
                .select("userId teamId status medicalNotes parents createdAt")
                .populate("userId", "firstname lastname profile_image birthDate")
                .populate({
                    path: "parents.parentId",
                    select: "userId",
                    populate: { path: "userId", select: "firstname lastname countryCode mobileNumber is_verify" },
                })
            : [];

        const today = nowInClubTime();

        // Sections 1-9
        const dashboard = buildDashboard({ teams, players, today });

        // Section 10: quick status (abhi dummy/not_marked)
        const quickStatus = buildQuickStatus({ teams, players, today });

        const user = coach.userId || {};
        const club = coach.clubId && coach.clubId._id ? coach.clubId : null;

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Dashboard fetched successfully.",
            message_desc: "Dashboard fetched successfully.",
            data: {
                coach: {
                    _id: coach._id,
                    userId: user._id || null,
                    firstname: user.firstname || "",
                    lastname: user.lastname || "",
                    profile_image: user.profile_image || "",
                },
                club: club
                    ? {
                        _id: club._id,
                        name: club.name,
                        clubCode: club.clubCode || "",
                        logoUrl: fileUrlOf(club.logo),
                        theme: club.theme || {},
                    }
                    : null,
                ...dashboard,
                quickStatus,
            },
        });
    } catch (e) {
        console.error("Coach dashboard error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = { getCoachDashboard, buildDashboard, buildQuickStatus };