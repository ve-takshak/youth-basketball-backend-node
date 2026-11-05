const moment = require("moment");
const Schedule = require("../../models/Schedule");
const Team = require("../../models/Team");
const Coach = require("../../models/Coach");
const Facility = require("../../models/Facility");
const Player = require("../../models/Player");
const Parent = require("../../models/Parent");
const { SCHEDULE_TYPES, GAME_TYPES, REPEAT_FREQUENCIES, DATE_RX } = require("../../models/Schedule");
const { ROLES } = require("../../helpers/constants");
const { TIME_RX } = require("../../helpers/scheduleHelper");
const { isValidId, getPagination } = require("../../helpers/common");

// Schedule (calendar). superAdmin sab clubs, clubAdmin sirf apna club.
// Coach / player / parent ki apni alag list / get APIs, sirf bheje gaye (published) schedules.
// Repeat wala schedule EK hi document hai (date = pehli date, repeat.until = aakhri).
// List API range ki har date ke liye ek entry banati hai. Update / delete hamesha poore schedule par.
//   POST   /user/schedules/create
//   GET    /user/schedules                 calendar range + filters
//   GET    /user/schedules/:id             ?date= (repeat ki ek date)
//   PUT    /user/schedules/:id/update
//   DELETE /user/schedules/:id/delete
//   POST   /user/schedules/send            "Send schedule": drafts + badlav portal par
//   GET    /user/schedules/sent            bheje gaye schedules (admin)
//   GET    /user/coach/schedules(/:id)     coach
//   GET    /user/player/schedules(/:id)    senior / youth player
//   GET    /user/parent/schedules(/:id)    parent (?playerId= ek bachcha)

const MAX_OCCURRENCES = 200; // ek repeat mein zyada se zyada itni dates
const MAX_REPEAT_DAYS = 366;
const MAX_RANGE_DAYS = 186; // list mein from-to ka max gap
const MAX_CONFLICTS_SHOWN = 50;
const REPEAT_STEP = { daily: 1, weekly: 7, biweekly: 14 };

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

const sendServerError = (res, label, e) => {
    console.error(`${label} error:`, e);
    return res.status(500).json({
        error: true,
        status: 500,
        message: "Something went wrong.",
        message_desc: e.message,
        data: {},
    });
};

const sendOk = (res, status, message, data) =>
    res.status(status).json({ error: false, status, message, message_desc: message, data });

const canAccess = (req, clubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(clubId?._id || clubId);

// ---------------------------------------------------------------------------
// Date / time helpers ("YYYY-MM-DD", "HH:MM")
// ---------------------------------------------------------------------------

// Asli date hai? (2026-02-30 nahi chalega)
const isValidDate = (d) => DATE_RX.test(d) && moment(d, "YYYY-MM-DD", true).isValid();
const addDays = (d, n) => moment(d, "YYYY-MM-DD").add(n, "days").format("YYYY-MM-DD");
const daysBetween = (a, b) => moment(b, "YYYY-MM-DD").diff(moment(a, "YYYY-MM-DD"), "days");

// Dono "HH:MM" zero-padded hain, isliye string compare = time compare
const overlaps = (a, b) => a.startTime < b.endTime && b.startTime < a.endTime;

// Kisi ek samay par zyada se zyada kitne intervals saath chal rahe hain
const maxConcurrent = (intervals) => {
    const points = [];
    intervals.forEach((i) => {
        points.push([i.startTime, 1]);
        points.push([i.endTime, -1]);
    });
    // Same time par pehle khatam (-1), phir shuru: 10:00 khatam + 10:00 shuru overlap nahi
    points.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
    let current = 0;
    let max = 0;
    points.forEach(([, delta]) => {
        current += delta;
        max = Math.max(max, current);
    });
    return max;
};

// ---------------------------------------------------------------------------
// Repeat: document se dates
// ---------------------------------------------------------------------------

const isRecurring = (s) => Boolean(REPEAT_STEP[s.repeat?.frequency]);
const lastDate = (s) => (isRecurring(s) ? s.repeat.until : s.date);

// Schedule ki dates [from, to] ke beech
const occurrenceDates = (s, from, to) => {
    const step = REPEAT_STEP[s.repeat?.frequency];
    if (!step) return s.date >= from && s.date <= to ? [s.date] : [];

    const end = s.repeat.until < to ? s.repeat.until : to;
    let d = s.date;
    if (d < from) d = addDays(d, Math.ceil(daysBetween(d, from) / step) * step);
    const dates = [];
    for (; d <= end; d = addDays(d, step)) dates.push(d);
    return dates;
};

const allDates = (s) => occurrenceDates(s, s.date, lastDate(s));

// Mongo filter: jo schedules [from, to] mein kahin bhi padte hain
const rangeFilter = (from, to) => ({
    date: { $lte: to },
    $or: [{ date: { $gte: from } }, { "repeat.until": { $gte: from } }],
});

// ---------------------------------------------------------------------------
// Format / populate
// ---------------------------------------------------------------------------

const populateSchedule = (query) =>
    query
        .populate("clubId", "name")
        .populate({
            path: "teamId",
            select: "name categoryId coachId gender teamType season status",
            populate: { path: "categoryId", select: "name" },
        })
        .populate({ path: "coachId", select: "userId", populate: { path: "userId", select: "firstname lastname profile_image" } })
        .populate("facilityId", "name address type parallelUnits");

const populated = (ref) => (ref && typeof ref === "object" && ref._id ? ref : null);

// date = kis din ki entry (repeat mein har din alag). Na do toh pehli date.
const formatSchedule = (s, date = s.date) => {
    const team = populated(s.teamId);
    const coach = populated(s.coachId);
    const facility = populated(s.facilityId);
    const club = populated(s.clubId);
    return {
        _id: s._id,
        type: s.type,
        isGame: GAME_TYPES.includes(s.type),
        date,
        startTime: s.startTime,
        endTime: s.endTime,
        team: team
            ? {
                _id: team._id,
                name: team.name,
                category: populated(team.categoryId) ? { _id: team.categoryId._id, name: team.categoryId.name } : null,
                gender: team.gender || "mixed",
                teamType: team.teamType || "league",
                season: team.season || "",
                status: team.status || "active",
            }
            : null,
        coach: coach
            ? {
                _id: coach._id,
                firstname: coach.userId?.firstname || "",
                lastname: coach.userId?.lastname || "",
                profile_image: coach.userId?.profile_image || "",
            }
            : null,
        facility: facility ? { _id: facility._id, name: facility.name, address: facility.address || "", type: facility.type } : null,
        club: club ? { _id: club._id, name: club.name } : null,
        opponent: s.opponent || "",
        description: s.description || "",
        status: s.status,
        hasUnsentChanges: Boolean(s.hasUnsentChanges),
        publishedAt: s.publishedAt,
        isRecurring: isRecurring(s),
        startDate: s.date, // repeat ki pehli date
        repeat: { frequency: s.repeat?.frequency || "none", until: s.repeat?.until || "" },
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const optionalId = (raw) => {
    const id = raw === undefined || raw === null ? "" : String(raw).trim();
    return id || null;
};

/**
 * Body check. partial = update (sirf bheje gaye fields).
 * Time ka start < end check yahan nahi (update mein purane + naye mila ke hota hai).
 * Galti ho toh { message }, warna { values }
 */
const validateSchedule = (body, partial = false) => {
    body = body || {};
    const v = {};
    const has = (key) => body[key] !== undefined;

    if (!partial || has("type")) {
        v.type = String(body.type || "training").trim().toLowerCase();
        if (!SCHEDULE_TYPES.includes(v.type)) return { message: `Schedule type must be one of: ${SCHEDULE_TYPES.join(", ")}.` };
    }

    if (!partial || has("date")) {
        v.date = String(body.date ?? "").trim();
        if (!v.date) return { message: "Date is required." };
        if (!isValidDate(v.date)) return { message: "Date must be a valid date (YYYY-MM-DD)." };
    }

    for (const key of ["startTime", "endTime"]) {
        if (!partial || has(key)) {
            v[key] = String(body[key] ?? "").trim();
            const label = key === "startTime" ? "Start time" : "End time";
            if (!v[key]) return { message: `${label} is required.` };
            if (!TIME_RX.test(v[key])) return { message: `${label} must be in HH:MM format (00:00 - 23:59).` };
        }
    }

    if (!partial || has("teamId")) {
        v.teamId = optionalId(body.teamId);
        if (!v.teamId) return { message: "Team is required." };
        if (!isValidId(v.teamId)) return { message: "Invalid team id." };
    }

    // Coach / facility optional: "" ya null = hatao
    for (const [key, label] of [["coachId", "coach"], ["facilityId", "facility"]]) {
        if (!partial || has(key)) {
            v[key] = optionalId(body[key]);
            if (v[key] && !isValidId(v[key])) return { message: `Invalid ${label} id.` };
        }
    }

    if (!partial || has("opponent")) {
        v.opponent = String(body.opponent ?? "").trim();
        if (v.opponent.length > 150) return { message: "Opponent must be 150 characters or less." };
    }

    if (!partial || has("description")) {
        v.description = String(body.description ?? "").trim();
        if (v.description.length > 1000) return { message: "Description must be 1000 characters or less." };
    }

    // Sirf update: cancel / wapas active
    if (partial && has("status")) {
        const status = String(body.status).trim().toLowerCase();
        if (!["cancelled", "active"].includes(status)) return { message: 'Status must be "cancelled" or "active".' };
        v.status = status;
    }

    return { values: v };
};

const repeatSent = (body) =>
    body?.repeat !== undefined || body?.repeatFrequency !== undefined || body?.repeatUntil !== undefined;

/**
 * Repeat: { frequency: "weekly", until: "2026-12-31" } ya flat repeatFrequency / repeatUntil.
 * Galti ho toh { message }, warna { repeat }
 */
const parseRepeat = (body, startDate) => {
    const raw = typeof body.repeat === "object" && body.repeat !== null ? body.repeat : {};
    const frequency = String(raw.frequency ?? body.repeatFrequency ?? "none").trim().toLowerCase() || "none";
    if (!REPEAT_FREQUENCIES.includes(frequency)) {
        return { message: `Repeat must be one of: ${REPEAT_FREQUENCIES.join(", ")}.` };
    }
    if (frequency === "none") return { repeat: { frequency, until: "" } };

    const until = String(raw.until ?? body.repeatUntil ?? "").trim();
    if (!until) return { message: "Please choose an end date for the repeat." };
    if (!isValidDate(until)) return { message: "Repeat end date must be a valid date (YYYY-MM-DD)." };
    if (until < startDate) return { message: "Repeat end date must be on or after the schedule date." };
    if (daysBetween(startDate, until) > MAX_REPEAT_DAYS) return { message: "A repeat can run for at most one year." };

    const repeat = { frequency, until };
    if (allDates({ date: startDate, repeat }).length > MAX_OCCURRENCES) {
        return { message: `A repeat can have at most ${MAX_OCCURRENCES} dates.` };
    }
    return { repeat };
};

/**
 * Team, coach, facility ek hi club ke hain aur user ka access hai? Club team se aata hai.
 * Galti ho toh { status, message }, warna { clubId }
 */
const checkRefs = async (req, { teamId, coachId, facilityId }) => {
    const team = await Team.findById(teamId).select("clubId");
    if (!team || !canAccess(req, team.clubId)) return { status: 400, message: "Please select a valid team." };

    if (coachId && !(await Coach.exists({ _id: coachId, clubId: team.clubId }))) {
        return { status: 400, message: "Please select a valid coach from this club." };
    }
    if (facilityId && !(await Facility.exists({ _id: facilityId, clubId: team.clubId }))) {
        return { status: 400, message: "Please select a valid facility from this club." };
    }
    return { clubId: team.clubId };
};

// ---------------------------------------------------------------------------
// Conflicts: team / coach ek waqt par do jagah nahi, facility parallelUnits se zyada nahi
// ---------------------------------------------------------------------------

/**
 * candidate: naya / badla hua schedule (plain object), uski har date check hoti hai.
 * Edit mein candidate._id wala DB document khud se nahi takrata.
 * Returns: [{ date, startTime, endTime, reason: "team" | "coach" | "facility", schedule: {...} }]
 */
const findConflicts = async (candidate) => {
    const c = candidate;
    const dates = allDates(c);
    if (c.status === "cancelled" || !dates.length) return [];
    const min = dates[0];
    const max = dates[dates.length - 1];

    const or = [{ teamId: c.teamId }];
    if (c.coachId) or.push({ coachId: c.coachId });
    if (c.facilityId) or.push({ facilityId: c.facilityId });

    const [docs, facility] = await Promise.all([
        Schedule.find({
            ...(c._id ? { _id: { $ne: c._id } } : {}),
            status: { $ne: "cancelled" },
            $and: [rangeFilter(min, max), { $or: or }],
        })
            .select("date startTime endTime teamId coachId facilityId type repeat")
            .populate("teamId", "name"),
        c.facilityId ? Facility.findById(c.facilityId).select("parallelUnits") : null,
    ]);
    const units = facility?.parallelUnits || 1;

    // Har din ke chal rahe schedules
    const byDate = new Map();
    docs.forEach((s) => {
        occurrenceDates(s, min, max).forEach((d) => byDate.set(d, [...(byDate.get(d) || []), s]));
    });

    const same = (a, b) => Boolean(a) && Boolean(b) && String(a?._id || a) === String(b?._id || b);
    const brief = (s, date) => ({
        _id: s._id,
        date,
        startTime: s.startTime,
        endTime: s.endTime,
        type: s.type,
        team: populated(s.teamId) ? { _id: s.teamId._id, name: s.teamId.name } : { _id: s.teamId },
    });

    const conflicts = [];
    dates.forEach((date) => {
        const clashing = (byDate.get(date) || []).filter((s) => overlaps(s, c));
        const add = (reason, s) =>
            conflicts.push({ date, startTime: c.startTime, endTime: c.endTime, reason, schedule: brief(s, date) });

        clashing.filter((s) => same(s.teamId, c.teamId)).forEach((s) => add("team", s));
        clashing.filter((s) => same(s.coachId, c.coachId)).forEach((s) => add("coach", s));

        if (c.facilityId) {
            const atFacility = clashing.filter((s) => same(s.facilityId, c.facilityId));
            // Sirf apne samay ke andar ka hissa gino
            const clipped = atFacility.map((s) => ({
                startTime: s.startTime > c.startTime ? s.startTime : c.startTime,
                endTime: s.endTime < c.endTime ? s.endTime : c.endTime,
            }));
            if (atFacility.length && maxConcurrent(clipped) >= units) {
                atFacility.forEach((s) => add("facility", s));
            }
        }
    });
    return conflicts;
};

const REASON_TEXT = { team: "The team", coach: "The coach", facility: "The facility" };

const sendConflicts = (res, conflicts) => {
    const first = conflicts[0];
    const message =
        `${REASON_TEXT[first.reason]} is already booked on ${first.date} ${first.schedule.startTime}-${first.schedule.endTime}` +
        (conflicts.length > 1 ? ` (and ${conflicts.length - 1} more conflict${conflicts.length > 2 ? "s" : ""}).` : ".") +
        " Send ignoreConflicts: true to save anyway.";
    return sendError(res, 409, message, { conflicts: conflicts.slice(0, MAX_CONFLICTS_SHOWN), total: conflicts.length });
};

const ignoreConflicts = (body) => body?.ignoreConflicts === true || String(body?.ignoreConflicts) === "true";

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

const PLAYER_ROLES = [ROLES.SENIOR_PLAYER, ROLES.YOUTH_PLAYER];
const sentOnly = { publishedAt: { $ne: null }, status: { $ne: "draft" } };
const notLinked = { status: 403, message: "Your account is not linked to any club." };

// Mobile app wale sirf bheje gaye (published) schedules dekhte hain. Har role ka apna scope.
// Galti ho toh { status, message }, warna { filter }

// Coach: jahan wo coach hai ya uski team ka schedule
const coachScope = async (req) => {
    if (req.user.role !== ROLES.COACH) return { status: 403, message: "Access denied. Coach only." };
    const coach = await Coach.findOne({ userId: req.user._id }).select("_id clubId");
    if (!coach) return notLinked;
    const teamIds = await Team.find({ coachId: coach._id }).distinct("_id");
    return { filter: { clubId: coach.clubId, ...sentOnly, $or: [{ coachId: coach._id }, { teamId: { $in: teamIds } }] } };
};

// Player (senior / youth): apni team ka schedule. Team nahi (waitlisted) toh khaali list.
const playerScope = async (req) => {
    if (!PLAYER_ROLES.includes(req.user.role)) return { status: 403, message: "Access denied. Player only." };
    const player = await Player.findOne({ userId: req.user._id }).select("clubId teamId");
    if (!player) return notLinked;
    return { filter: { clubId: player.clubId, ...sentOnly, teamId: player.teamId || null } };
};

// Parent: apne bachchon ki teams ka. ?playerId= do toh sirf us bachche ka.
// children = parent ke saare bachche (tabs ke liye), decorate = har schedule mein kis bachche ka hai
const parentScope = async (req) => {
    if (req.user.role !== ROLES.PARENT) return { status: 403, message: "Access denied. Parent only." };
    const parent = await Parent.findOne({ userId: req.user._id }).select("_id clubId");
    if (!parent) return notLinked;

    const kids = await Player.find({ "parents.parentId": parent._id })
        .select("teamId userId")
        .populate("userId", "firstname lastname profile_image")
        .populate("teamId", "name");
    const children = kids.map((p) => ({
        _id: p._id,
        firstname: p.userId?.firstname || "",
        lastname: p.userId?.lastname || "",
        profile_image: p.userId?.profile_image || "",
        team: populated(p.teamId) ? { _id: p.teamId._id, name: p.teamId.name } : null,
    }));

    const { playerId } = req.query;
    if (playerId && !isValidId(playerId)) return { status: 400, message: "Invalid playerId." };
    const selected = playerId ? children.filter((c) => String(c._id) === String(playerId)) : children;
    if (playerId && !selected.length) return { status: 404, message: "Player not found." };

    const teamIds = [...new Set(selected.filter((c) => c.team).map((c) => String(c.team._id)))];
    const decorate = (entry) => ({
        ...entry,
        children: selected
            .filter((c) => c.team && entry.team && String(c.team._id) === String(entry.team._id))
            .map(({ _id, firstname, lastname, profile_image }) => ({ _id, firstname, lastname, profile_image })),
    });
    return { filter: { clubId: parent.clubId, ...sentOnly, teamId: { $in: teamIds } }, children, decorate };
};

// Schedule id valid + access. Galti ho toh { status, message }
const findSchedule = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid schedule id." };
    const schedule = await Schedule.findById(id);
    if (!schedule || !canAccess(req, schedule.clubId)) return { status: 404, message: "Schedule not found." };
    return { schedule };
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/user/schedules/create   (superAdmin ya clubAdmin)
 * body: { type, date, startTime, endTime, teamId, coachId?, facilityId?, opponent?, description?,
 *         repeat?: { frequency: none|daily|weekly|biweekly, until }, ignoreConflicts? }
 * Repeat ho ya na ho, EK hi document banta hai. Naya schedule hamesha draft.
 */
const createSchedule = async (req, res) => {
    try {
        const body = req.body || {};

        const checked = validateSchedule(body);
        if (checked.message) return sendError(res, 400, checked.message);
        const values = checked.values;
        if (values.startTime >= values.endTime) return sendError(res, 400, "End time must be after start time.");
        if (!GAME_TYPES.includes(values.type)) values.opponent = "";

        const refs = await checkRefs(req, values);
        if (refs.message) return sendError(res, refs.status, refs.message);

        const rep = parseRepeat(body, values.date);
        if (rep.message) return sendError(res, 400, rep.message);

        const doc = { ...values, repeat: rep.repeat, clubId: refs.clubId, status: "draft", createdBy: req.user._id };

        if (!ignoreConflicts(body)) {
            const conflicts = await findConflicts(doc);
            if (conflicts.length) return sendConflicts(res, conflicts);
        }

        const created = await Schedule.create(doc);
        const saved = await populateSchedule(Schedule.findById(created._id));
        const count = allDates(saved).length;

        const message = count > 1 ? `Schedule created as a draft (${count} dates).` : "Schedule created as a draft.";
        return sendOk(res, 201, message, formatSchedule(saved));
    } catch (e) {
        return sendServerError(res, "Create schedule", e);
    }
};

// Calendar list ki query (from / to / type / games / teamId / coachId / facilityId) se filter.
// Galti ho toh { message }, warna { from, to, and }
const parseListQuery = (q) => {
    const from = String(q.from || "").trim() || moment().startOf("week").format("YYYY-MM-DD");
    const to = String(q.to || "").trim() || addDays(from, 6);
    if (!isValidDate(from) || !isValidDate(to)) return { message: "from / to must be valid dates (YYYY-MM-DD)." };
    if (to < from) return { message: '"to" must be on or after "from".' };
    if (daysBetween(from, to) > MAX_RANGE_DAYS) return { message: `Date range can be at most ${MAX_RANGE_DAYS} days.` };

    const and = [rangeFilter(from, to)];

    // Type: "game" = home + away
    let types = null;
    if (q.type) {
        types = new Set();
        for (const t of String(q.type).toLowerCase().split(",").map((x) => x.trim()).filter(Boolean)) {
            if (t === "game") GAME_TYPES.forEach((g) => types.add(g));
            else if (SCHEDULE_TYPES.includes(t)) types.add(t);
            else return { message: `Invalid type "${t}".` };
        }
    }

    // Games dropdown: sirf home / sirf away (trainings bhi chhupa deta hai)
    if (q.games) {
        const games = String(q.games).trim().toLowerCase();
        if (games === "home" || games === "away") {
            const only = `${games}_game`;
            types = new Set(!types || types.has(only) ? [only] : []);
        } else if (games !== "all") {
            return { message: 'games must be "all", "home" or "away".' };
        }
    }
    if (types) and.push({ type: { $in: [...types] } });

    for (const key of ["teamId", "coachId", "facilityId"]) {
        if (q[key]) {
            if (!isValidId(q[key])) return { message: `Invalid ${key}.` };
            and.push({ [key]: q[key] });
        }
    }

    return { from, to, and };
};

// page / limit diya ho toh entries ka ek page + pagination, warna saari (calendar ke liye)
const pageOf = (q, schedules) => {
    if (q.page === undefined && q.limit === undefined) return { schedules };
    const { page, limit, skip } = getPagination(q);
    const total = schedules.length;
    return {
        schedules: schedules.slice(skip, skip + limit),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
};

// Filter ke schedules, range ki har date ki entry, date + time order mein
const expandSchedules = async (and, from, to) => {
    const docs = await populateSchedule(Schedule.find({ $and: and }));
    return docs
        .flatMap((s) => occurrenceDates(s, from, to).map((d) => formatSchedule(s, d)))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
};

/**
 * GET /api/user/schedules?from=2026-11-01&to=2026-11-07&type=training,game&games=home|away
 *                        &teamId=&coachId=&facilityId=&status=&clubId=(sirf superAdmin)&sent=true
 *   (superAdmin ya clubAdmin) draft + published + cancelled, aur unsentCount.
 * from / to na do toh is hafte (Sun-Sat). type: training | game | home_game | away_game | other, comma se kai.
 * Repeat wala schedule range ki har date par ek entry deta hai (same _id, alag date).
 * page / limit do toh 10-10 ki pagination (repeat ki har date ek entry), na do toh range ki saari entries (calendar).
 * unsentIds = draft + bhejne ke baad badle schedules ("Send schedule" button ke liye).
 */
const listSchedules = async (req, res) => {
    try {
        const q = req.query;
        const parsed = parseListQuery(q);
        if (parsed.message) return sendError(res, 400, parsed.message);
        const { from, to, and } = parsed;

        let clubId = null;
        if (req.user.role === ROLES.CLUB_ADMIN) {
            if (!req.clubId) return sendError(res, 403, "Your account is not linked to any club.");
            clubId = req.clubId;
        } else if (q.clubId) {
            if (!isValidId(q.clubId)) return sendError(res, 400, "Invalid club id.");
            clubId = q.clubId;
        }
        if (clubId) and.push({ clubId });

        if (q.status) {
            and.push({ status: { $in: String(q.status).toLowerCase().split(",").map((x) => x.trim()) } });
        }
        // sent=true: sirf bheje gaye (draft nahi), admin calendar ke liye
        if (String(q.sent) === "true") and.push({ publishedAt: { $ne: null } });

        const schedules = await expandSchedules(and, from, to);

        const unsentFilter = { $or: [{ status: "draft" }, { hasUnsentChanges: true }] };
        if (clubId) unsentFilter.clubId = clubId;
        const unsentIds = await Schedule.find(unsentFilter).distinct("_id");

        return sendOk(res, 200, "Schedules fetched successfully.", {
            from,
            to,
            ...pageOf(q, schedules),
            unsentCount: unsentIds.length,
            unsentIds,
        });
    } catch (e) {
        return sendServerError(res, "List schedules", e);
    }
};

// Coach / player / parent ki calendar list: wahi query, scope unke role ka
const listForViewer = (scope, label) => async (req, res) => {
    try {
        const parsed = parseListQuery(req.query);
        if (parsed.message) return sendError(res, 400, parsed.message);
        const { from, to, and } = parsed;

        const own = await scope(req);
        if (own.message) return sendError(res, own.status, own.message);
        and.push(own.filter);

        const all = await expandSchedules(and, from, to);
        const schedules = own.decorate ? all.map(own.decorate) : all;
        return sendOk(res, 200, "Schedules fetched successfully.", {
            from,
            to,
            ...(own.children && { children: own.children }),
            ...pageOf(req.query, schedules),
        });
    } catch (e) {
        return sendServerError(res, label, e);
    }
};

/**
 * GET /api/user/coach/schedules?from=&to=&type=&games=&teamId=&facilityId=     (coach)
 * GET /api/user/player/schedules?from=&to=&type=&games=                        (seniorPlayer / youthPlayer)
 * GET /api/user/parent/schedules?from=&to=&type=&games=&playerId=              (parent)
 * Sirf bheje gaye (published / cancelled) schedules, draft kabhi nahi. Response admin list jaisa, unsentCount nahi.
 * Parent: response mein children (saare bachche + team) aur har schedule mein children (kis bachche ka hai).
 * page / limit do toh pagination, admin list jaisa.
 */
const listCoachSchedules = listForViewer(coachScope, "List coach schedules");
const listPlayerSchedules = listForViewer(playerScope, "List player schedules");
const listParentSchedules = listForViewer(parentScope, "List parent schedules");

/**
 * GET /api/user/schedules/sent?page=1&limit=10&teamId=&coachId=&facilityId=&type=&clubId=(sirf superAdmin)
 *   (superAdmin ya clubAdmin)
 * Jo schedules "Send schedule" se bheje ja chuke hain (publishedAt hai). Har schedule ek baar
 * (repeat ki dates alag nahi), sabse naya bheja hua pehle.
 * hasUnsentChanges: true = bhejne ke baad edit hua, naya badlav abhi bhejna baaki.
 */
const listSentSchedules = async (req, res) => {
    try {
        const q = req.query;
        const { page, limit, skip } = getPagination(q);
        const filter = { publishedAt: { $ne: null } };

        if (req.user.role === ROLES.CLUB_ADMIN) {
            if (!req.clubId) return sendError(res, 403, "Your account is not linked to any club.");
            filter.clubId = req.clubId;
        } else if (q.clubId) {
            if (!isValidId(q.clubId)) return sendError(res, 400, "Invalid club id.");
            filter.clubId = q.clubId;
        }

        for (const key of ["teamId", "coachId", "facilityId"]) {
            if (q[key]) {
                if (!isValidId(q[key])) return sendError(res, 400, `Invalid ${key}.`);
                filter[key] = q[key];
            }
        }

        if (q.type) {
            const type = String(q.type).trim().toLowerCase();
            if (type === "game") filter.type = { $in: GAME_TYPES };
            else if (SCHEDULE_TYPES.includes(type)) filter.type = type;
            else return sendError(res, 400, `Invalid type "${type}".`);
        }

        const [schedules, total] = await Promise.all([
            populateSchedule(Schedule.find(filter).sort({ publishedAt: -1, date: 1 }).skip(skip).limit(limit)),
            Schedule.countDocuments(filter),
        ]);

        return sendOk(res, 200, "Sent schedules fetched successfully.", {
            schedules: schedules.map((s) => formatSchedule(s)),
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (e) {
        return sendServerError(res, "List sent schedules", e);
    }
};

// ?date= repeat ki kaunsi date (na do toh pehli). Galat date par 404.
const sendOneSchedule = (res, schedule, rawDate, decorate = (x) => x) => {
    const date = String(rawDate || "").trim() || schedule.date;
    if (!isValidDate(date) || !occurrenceDates(schedule, date, date).length) {
        return sendError(res, 404, "This date is not part of the schedule.");
    }
    return sendOk(res, 200, "Schedule fetched successfully.", decorate(formatSchedule(schedule, date)));
};

/**
 * GET /api/user/schedules/:id?date=2026-11-09   (superAdmin ya clubAdmin)
 * date = repeat ki kaunsi date (na do toh pehli).
 */
const getSchedule = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid schedule id.");

        const schedule = await populateSchedule(Schedule.findById(id));
        if (!schedule || !canAccess(req, schedule.clubId)) return sendError(res, 404, "Schedule not found.");

        return sendOneSchedule(res, schedule, req.query.date);
    } catch (e) {
        return sendServerError(res, "Get schedule", e);
    }
};

// Coach / player / parent: sirf apne scope ka bheja gaya schedule, warna 404
const getForViewer = (scope, label) => async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid schedule id.");

        const own = await scope(req);
        if (own.message) return sendError(res, own.status, own.message);

        const schedule = await populateSchedule(Schedule.findOne({ $and: [{ _id: id }, own.filter] }));
        if (!schedule) return sendError(res, 404, "Schedule not found.");

        return sendOneSchedule(res, schedule, req.query.date, own.decorate);
    } catch (e) {
        return sendServerError(res, label, e);
    }
};

/**
 * GET /api/user/coach/schedules/:id?date=    (coach)
 * GET /api/user/player/schedules/:id?date=   (seniorPlayer / youthPlayer)
 * GET /api/user/parent/schedules/:id?date=   (parent)
 */
const getCoachSchedule = getForViewer(coachScope, "Get coach schedule");
const getPlayerSchedule = getForViewer(playerScope, "Get player schedule");
const getParentSchedule = getForViewer(parentScope, "Get parent schedule");

/**
 * PUT /api/user/schedules/:id/update   (superAdmin ya clubAdmin)
 * body: jo badalna hai wahi (create jaise fields) + ignoreConflicts?
 *       status: "cancelled" = cancel, "active" = wapas
 *       repeat: { frequency, until }   ("none" = repeat band)
 * Badlav poore schedule (saari dates) par lagta hai.
 * Published schedule badle toh hasUnsentChanges = true, "Send schedule" tak.
 */
const updateSchedule = async (req, res) => {
    try {
        const body = req.body || {};
        const found = await findSchedule(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const doc = found.schedule;

        const checked = validateSchedule(body, true);
        if (checked.message) return sendError(res, 400, checked.message);
        const { status, ...fields } = checked.values;
        const changingRepeat = repeatSent(body);
        if (!Object.keys(checked.values).length && !changingRepeat) return sendError(res, 400, "Nothing to update.");

        // Naya roop: purana + naya
        const next = { ...doc.toObject(), ...fields };
        if (status) next.status = status === "cancelled" ? "cancelled" : doc.publishedAt ? "published" : "draft";
        if (!GAME_TYPES.includes(next.type)) next.opponent = "";
        if (next.startTime >= next.endTime) return sendError(res, 400, "End time must be after start time.");

        // Repeat: naya bheja ho ya date badli ho, dono mein check
        const rep = parseRepeat(changingRepeat ? body : { repeat: next.repeat }, next.date);
        if (rep.message) return sendError(res, 400, rep.message);
        next.repeat = rep.repeat;

        if (["teamId", "coachId", "facilityId"].some((k) => fields[k] !== undefined)) {
            const refs = await checkRefs(req, next);
            if (refs.message) return sendError(res, refs.status, refs.message);
            if (String(refs.clubId) !== String(doc.clubId)) {
                return sendError(res, 400, "A schedule cannot be moved to a team from another club.");
            }
        }

        // Clash sirf tab check jab din / time / team / coach / facility / repeat badle ya schedule wapas active hua
        const timingChanged =
            ["date", "startTime", "endTime", "teamId", "coachId", "facilityId"].some((k) => fields[k] !== undefined) ||
            changingRepeat ||
            status === "active";

        if (timingChanged && !ignoreConflicts(body)) {
            const conflicts = await findConflicts(next);
            if (conflicts.length) return sendConflicts(res, conflicts);
        }

        doc.set({ ...fields, status: next.status, opponent: next.opponent, repeat: next.repeat });
        // Published tha toh portal ko batana baaki
        if (doc.publishedAt) doc.hasUnsentChanges = true;
        await doc.save();

        const saved = await populateSchedule(Schedule.findById(doc._id));
        return sendOk(res, 200, "Schedule updated successfully.", formatSchedule(saved));
    } catch (e) {
        return sendServerError(res, "Update schedule", e);
    }
};

/**
 * DELETE /api/user/schedules/:id/delete   (superAdmin ya clubAdmin)
 * Poora schedule (repeat ki saari dates) delete. Sirf "nahi hoga" dikhana ho toh update mein status: "cancelled".
 */
const deleteSchedule = async (req, res) => {
    try {
        const found = await findSchedule(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);

        await Schedule.deleteOne({ _id: found.schedule._id });
        return sendOk(res, 200, "Schedule deleted successfully.", { _id: found.schedule._id });
    } catch (e) {
        return sendServerError(res, "Delete schedule", e);
    }
};

/**
 * POST /api/user/schedules/send   (superAdmin ya clubAdmin) - "Send schedule" button
 * body: { scheduleIds: ["id1", "id2"] }   (required)
 * Sirf yahi schedules: draft published hota hai, published schedule ke badlav bhi portal par.
 * Baaki schedules jaise the waise (draft hi) rehte hain.
 * NOTE: push notification abhi nahi (draft banner: "with no push notification").
 */
const sendSchedule = async (req, res) => {
    try {
        const raw = req.body?.scheduleIds;
        const ids = Array.isArray(raw) ? [...new Set(raw.map((id) => String(id).trim()))] : [];
        if (!ids.length) return sendError(res, 400, "Please select at least one schedule (scheduleIds).");
        if (ids.some((id) => !isValidId(id))) return sendError(res, 400, "scheduleIds contains an invalid id.");

        // Saare ids mile aur user ke access mein hon (clubAdmin: sirf apna club)
        const found = await Schedule.find({ _id: { $in: ids } }).select("clubId");
        if (found.length !== ids.length || found.some((s) => !canAccess(req, s.clubId))) {
            return sendError(res, 404, "One or more schedules were not found.");
        }
        const filter = { _id: { $in: ids } };

        const now = new Date();
        const [drafts, changed] = await Promise.all([
            Schedule.updateMany({ ...filter, status: "draft" }, { $set: { status: "published", publishedAt: now, hasUnsentChanges: false } }),
            Schedule.updateMany({ ...filter, hasUnsentChanges: true }, { $set: { hasUnsentChanges: false } }),
        ]);

        const sent = drafts.modifiedCount + changed.modifiedCount;
        const message = sent ? `Schedule sent: ${sent} schedule${sent > 1 ? "s" : ""} updated on the portals.` : "Nothing new to send.";
        // Bheje gaye schedules, team / coach / facility ki info ke saath
        const saved = await populateSchedule(Schedule.find(filter).sort({ date: 1, startTime: 1 }));
        return sendOk(res, 200, message, {
            published: drafts.modifiedCount,
            updated: changed.modifiedCount,
            sentAt: now,
            schedules: saved.map((s) => formatSchedule(s)),
        });
    } catch (e) {
        return sendServerError(res, "Send schedule", e);
    }
};

module.exports = {
    createSchedule,
    listSchedules,
    listSentSchedules,
    getSchedule,
    updateSchedule,
    deleteSchedule,
    sendSchedule,
    listCoachSchedules,
    getCoachSchedule,
    listPlayerSchedules,
    getPlayerSchedule,
    listParentSchedules,
    getParentSchedule,
};
