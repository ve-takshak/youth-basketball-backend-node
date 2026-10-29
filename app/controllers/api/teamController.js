const Team = require("../../models/Team");
const Club = require("../../models/Club");
const Coach = require("../../models/Coach");
const Facility = require("../../models/Facility");
const TeamCategory = require("../../models/TeamCategory");
const { ROLES } = require("../../helpers/constants");
const { isValidId, escapeRegex, getPagination } = require("../../helpers/common");
const {
    WEEK_DAYS,
    EMPTY_ATHLETICS,
    parseTrainingDays,
    parseUnavailableHours,
    parseAthleticsTraining,
} = require("../../helpers/scheduleHelper");

const VALID_GENDERS = ["boys", "girls", "mixed"];
const VALID_TEAM_TYPES = ["league", "non-league"];
const VALID_STATUSES = ["active", "inactive"];

// Logo ka poora URL (S3 wala waise hi, local path ho toh APP_URL ke saath)
const fileUrlOf = (value) => {
    if (!value) return "";
    if (value.startsWith("http")) return value;
    const appUrl = process.env.APP_URL || "http://localhost:5000";
    return `${appUrl}/${value.replace(/\\/g, "/")}`;
};

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

// ---------------------------------------------------------------------------
// Coach ↔ Team days match
// ---------------------------------------------------------------------------

/**
 * Team ke training days vs coach ke preferred days + unavailable hours.
 * Coach assign hone se kabhi rokta nahi, sirf batata hai (faisla club admin ka).
 *   level: "full"    -> coach team ke saare din aata hai
 *          "partial" -> kuch din nahi aata
 *          "low"     -> hafte mein 1 ya usse kam din, ya aadhe se kam (club admin ko dekhna chahiye)
 *          "unknown" -> team ya coach ke days set hi nahi, isliye compare nahi ho sakta
 * Unavailable hours abhi sirf batate hain (practice ka time abhi nahi hai, isliye pakka clash nahi bol sakte).
 */
const computeCoachMatch = (teamDays = [], coach = null) => {
    if (!coach) return null;

    const coachDays = coach.preferredTrainingDays || [];
    const blocks = coach.unavailableHours || [];
    const unavailableOnTeamDays = blocks
        .filter((b) => teamDays.includes(b.day))
        .map((b) => ({ day: b.day, from: b.from, to: b.to }));

    if (teamDays.length === 0 || coachDays.length === 0) {
        return {
            level: "unknown",
            matchPercent: null,
            teamDays,
            coachDays,
            matchingDays: [],
            missingDays: [],
            unavailableOnTeamDays,
            warning: teamDays.length === 0
                ? "Team has no preferred training days, so the coach's days can't be compared."
                : "Coach has no preferred training days, so the days can't be compared.",
        };
    }

    const matchingDays = teamDays.filter((d) => coachDays.includes(d));
    const missingDays = teamDays.filter((d) => !coachDays.includes(d));
    const matchPercent = Math.round((matchingDays.length / teamDays.length) * 100);

    let level = "partial";
    if (missingDays.length === 0) level = "full";
    else if (matchingDays.length <= 1 || matchPercent < 50) level = "low";

    let warning = null;
    if (level === "low") {
        warning = `Coach can attend only ${matchingDays.length} of the team's ${teamDays.length} training days. Please talk to the coach.`;
    } else if (level === "partial") {
        warning = `Coach is not available on ${missingDays.length} of the team's ${teamDays.length} training days (${missingDays.join(", ")}).`;
    }
    if (unavailableOnTeamDays.length) {
        const list = unavailableOnTeamDays.map((b) => `${b.day} ${b.from}-${b.to}`).join(", ");
        const note = `Coach also has unavailable hours on team days: ${list}.`;
        warning = warning ? `${warning} ${note}` : note;
    }

    return { level, matchPercent, teamDays, coachDays, matchingDays, missingDays, unavailableOnTeamDays, warning };
};

// Athletics ka response hamesha poore shape mein
const formatAthletics = (a) =>
    a && a.enabled
        ? { enabled: true, locationName: a.locationName || "", day: a.day || "", from: a.from || "", to: a.to || "" }
        : { ...EMPTY_ATHLETICS };

/**
 * Unavailable hours + athletics (sirf jo bheje gaye). Galti ho toh { message }, warna { values }
 */
const validateTeamSchedule = (body) => {
    const values = {};
    if (body.unavailableHours !== undefined) {
        const hours = parseUnavailableHours(body.unavailableHours);
        if (hours.message) return { message: hours.message.replace("Unavailable", "Team unavailable") };
        values.unavailableHours = hours.blocks;
    }
    if (body.athleticsTraining !== undefined) {
        const athletics = parseAthleticsTraining(body.athleticsTraining);
        if (athletics.message) return { message: athletics.message };
        values.athleticsTraining = athletics.athletics;
    }
    return { values };
};

// Association / league classification number: letters, digits, "-" (max 30). "" / null = khaali
const LEAGUE_NUMBER_RX = /^[A-Za-z0-9-]{1,30}$/;
const LEAGUE_NUMBER_FIELDS = {
    associationNumber: "Association number",
    leagueClassificationNumber: "League classification number",
};

/**
 * League numbers (sirf jo bheje gaye). Galti ho toh { message }, warna { values }
 * Non-league team ke liye ye hamesha null rakhe jaate hain (controller mein).
 */
const parseLeagueNumbers = (body) => {
    const values = {};
    for (const [field, label] of Object.entries(LEAGUE_NUMBER_FIELDS)) {
        if (body[field] === undefined) continue;
        const raw = body[field] === null ? "" : String(body[field]).trim();
        if (raw && !LEAGUE_NUMBER_RX.test(raw)) {
            return { message: `${label} can only have letters, digits and "-" (max 30).` };
        }
        values[field] = raw || null;
    }
    return { values };
};

// Suggestions ke sort ke liye: full > partial > low > unknown
const LEVEL_RANK = { full: 0, partial: 1, low: 2, unknown: 3 };

// ---------------------------------------------------------------------------
// Ek coach sirf EK league (senior) team ka. Youth / non-league par koi rok nahi.
// ---------------------------------------------------------------------------

/**
 * Ye coach kisi aur league team ka coach hai toh wo team lauta do, warna null.
 * excludeTeamId: jis team ko abhi edit kar rahe hain (us par pehle se ho toh chalega)
 */
const findOtherLeagueTeamOfCoach = (coachId, excludeTeamId = null) =>
    Team.findOne({
        coachId,
        teamType: "league",
        ...(excludeTeamId ? { _id: { $ne: excludeTeamId } } : {}),
    }).select("name");

const leagueCoachError = (res, otherTeam) =>
    sendError(
        res,
        409,
        `This coach is already the coach of the league team "${otherTeam.name}". A coach can have only one league team.`,
        { team: { _id: otherTeam._id, name: otherTeam.name } }
    );

// ---------------------------------------------------------------------------
// Format / populate
// ---------------------------------------------------------------------------

/**
 * Format team object for API response
 * (create, list, get, update sab isi se response banate hain)
 */
const formatTeam = (record) => {
    if (!record) return null;
    const coach = record.coachId && typeof record.coachId === "object" && record.coachId._id ? record.coachId : null;
    const teamDays = record.preferredTrainingDays || [];
    const club = record.clubId && typeof record.clubId === "object" && record.clubId._id ? record.clubId : null;
    // Team ka apna logo nahi hota, club ka logo hi team ka logo hai
    const clubLogoUrl = club ? fileUrlOf(club.logo) : "";
    return {
        _id: record._id,
        name: record.name,
        logoUrl: clubLogoUrl,
        club: club ? {
            _id: club._id,
            name: club.name,
            logoUrl: clubLogoUrl,
        } : (record.clubId ? { _id: record.clubId } : null),
        category: record.categoryId && typeof record.categoryId === "object" ? {
            _id: record.categoryId._id,
            name: record.categoryId.name,
        } : (record.categoryId ? { _id: record.categoryId } : null),
        coach: coach ? {
            _id: coach._id,
            firstname: coach.userId?.firstname || "",
            lastname: coach.userId?.lastname || "",
            userId: coach.userId?._id,
            // Coach ki profile photo (User se)
            profile_image: coach.userId?.profile_image || "",
            mobileNumber: coach.userId?.mobileNumber || "",
            email: coach.userId?.email || "",
            preferredTrainingDays: coach.preferredTrainingDays || [],
            unavailableHours: (coach.unavailableHours || []).map((b) => ({ day: b.day, from: b.from, to: b.to })),
        } : (record.coachId ? { _id: record.coachId } : null),
        // Coach ke din team ke din se kitne milte hain (coach nahi toh null)
        coachMatch: coach ? computeCoachMatch(teamDays, coach) : null,
        // Home venue (Facility). Facility delete ho gayi ho toh null
        homeVenue: record.homeVenueId && typeof record.homeVenueId === "object" && record.homeVenueId._id ? {
            _id: record.homeVenueId._id,
            name: record.homeVenueId.name,
            address: record.homeVenueId.address || "",
            type: record.homeVenueId.type,
            parallelUnits: record.homeVenueId.parallelUnits ?? 1,
            // Facility API jaisa hall manager (phone na ho toh countryCode bhi khaali)
            hallManager: {
                name: record.homeVenueId.hallManager?.name || "",
                countryCode: record.homeVenueId.hallManager?.phone ? record.homeVenueId.hallManager.countryCode || "+972" : "",
                phone: record.homeVenueId.hallManager?.phone || "",
                email: record.homeVenueId.hallManager?.email || "",
            },
        } : null,
        preferredTrainingDays: teamDays,
        // Team kab nahi aa sakti (har hafte)
        unavailableHours: (record.unavailableHours || []).map((b) => ({ day: b.day, from: b.from, to: b.to })),
        // Athletics / conditioning session (band ho toh enabled: false aur baaki khaali)
        athleticsTraining: formatAthletics(record.athleticsTraining),
        gender: record.gender || "mixed",
        teamType: record.teamType || "league",
        // Sirf league team ke liye, non-league par null
        associationNumber: record.associationNumber || null,
        leagueClassificationNumber: record.leagueClassificationNumber || null,
        season: record.season || "",
        teamCapacity: record.teamCapacity !== undefined ? record.teamCapacity : 20,
        status: record.status || "active",
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
};

const populateTeam = (query) =>
    query
        .populate("clubId", "name logo theme")
        .populate("categoryId", "name")
        .populate("homeVenueId", "name address type parallelUnits hallManager")
        .populate({
            path: "coachId",
            // Days + hours bhi, coachMatch ke liye
            select: "userId clubId preferredTrainingDays unavailableHours",
            populate: {
                path: "userId",
                // profile_image bhi chahiye (formatTeam mein coach ke saath bhejte hain)
                select: "firstname lastname email countryCode mobileNumber profile_image",
            },
        });

const canAccess = (req, teamClubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(teamClubId?._id || teamClubId);

/**
 * Home venue check: sahi id, aur isi club ki facility. "" / null = koi venue nahi.
 * Galti ho toh { status, message }, warna { venueId }
 */
const resolveHomeVenue = async (raw, clubId) => {
    if (raw === undefined || raw === null || String(raw).trim() === "") return { venueId: null };
    const venueId = String(raw).trim();
    if (!isValidId(venueId)) return { status: 400, message: "Invalid home venue id." };
    const facility = await Facility.findById(venueId).select("clubId");
    if (!facility) return { status: 404, message: "Home venue not found." };
    if (String(facility.clubId) !== String(clubId)) {
        return { status: 400, message: "Selected home venue does not belong to this club." };
    }
    return { venueId: facility._id };
};

// ---------------------------------------------------------------------------
// APIs
// ---------------------------------------------------------------------------

/**
 * POST /api/user/teams/create
 * Body: { name, clubId, categoryId, gender?, teamType?, season?, teamCapacity?, coachId?, status?,
 *         associationNumber?, leagueClassificationNumber?   (sirf league, optional. non-league par null)
 *         homeVenueId?, preferredTrainingDays?,
 *         unavailableHours?: [{ day, from, to }],
 *         athleticsTraining?: { enabled, locationName, day, from, to } }
 * Response ke "coachMatch" mein coach aur team ke din kitne milte hain (warning ke saath).
 * Rule: league team par aisa coach nahi lag sakta jo pehle se doosri league team ka coach hai (409).
 */
const createTeam = async (req, res) => {
    try {
        const body = req.body || {};
        const { name, categoryId, gender, teamType, season, teamCapacity, coachId, status } = body;

        // 1. Validate team name
        if (!name || typeof name !== "string" || !name.trim()) return sendError(res, 400, "Team name is required.");
        const trimmedName = name.trim();
        if (trimmedName.length < 2) return sendError(res, 400, "Team name must be at least 2 characters.");

        // 2. Resolve & validate club
        const targetClubId = req.user.role === ROLES.CLUB_ADMIN
            ? String(req.clubId)
            : String(body.clubId || "").trim();

        if (!isValidId(targetClubId)) return sendError(res, 400, "Please select a valid club.");
        if (!(await Club.exists({ _id: targetClubId }))) return sendError(res, 404, "Club not found.");

        // 3. Validate category
        const targetCategoryId = String(categoryId || "").trim();
        if (!isValidId(targetCategoryId)) return sendError(res, 400, "Please select a valid category.");
        if (!(await TeamCategory.exists({ _id: targetCategoryId }))) return sendError(res, 404, "Category not found.");

        // 4. Validate coach (optional)
        let resolvedCoachId = null;
        if (coachId && String(coachId).trim()) {
            const cleanCoachId = String(coachId).trim();
            if (!isValidId(cleanCoachId)) return sendError(res, 400, "Invalid coach id.");

            const coach = await Coach.findById(cleanCoachId);
            if (!coach) return sendError(res, 404, "Coach not found.");
            if (String(coach.clubId) !== String(targetClubId)) {
                return sendError(res, 400, "Selected coach does not belong to this club.");
            }
            resolvedCoachId = coach._id;
        }

        // 5. Home venue (optional, isi club ki facility)
        const venue = await resolveHomeVenue(body.homeVenueId, targetClubId);
        if (venue.message) return sendError(res, venue.status, venue.message);

        // 6. Preferred training days (optional)
        const days = parseTrainingDays(body.preferredTrainingDays ?? []);
        if (days.message) return sendError(res, 400, days.message);

        // 6b. Unavailable hours + athletics training (optional)
        const schedule = validateTeamSchedule(body);
        if (schedule.message) return sendError(res, 400, schedule.message);

        // 6c. League numbers (optional)
        const leagueNumbers = parseLeagueNumbers(body);
        if (leagueNumbers.message) return sendError(res, 400, leagueNumbers.message);

        // 7. Duplicate check (within same club)
        const duplicate = await Team.findOne({
            clubId: targetClubId,
            name: new RegExp(`^${escapeRegex(trimmedName)}$`, "i"),
        });
        if (duplicate) return sendError(res, 409, "A team with this name already exists in this club.");

        // 8. Validate gender & teamType
        const cleanGender = gender && VALID_GENDERS.includes(String(gender).toLowerCase())
            ? String(gender).toLowerCase()
            : "mixed";

        const cleanTeamType = teamType && VALID_TEAM_TYPES.includes(String(teamType).toLowerCase())
            ? String(teamType).toLowerCase()
            : "league";

        // 8b. Ek coach sirf ek league team ka (youth par rok nahi)
        if (resolvedCoachId && cleanTeamType === "league") {
            const otherTeam = await findOtherLeagueTeamOfCoach(resolvedCoachId);
            if (otherTeam) return leagueCoachError(res, otherTeam);
        }

        const capacityNum = teamCapacity !== undefined && teamCapacity !== "" ? Number(teamCapacity) : 20;

        const newTeam = await Team.create({
            name: trimmedName,
            clubId: targetClubId,
            categoryId: targetCategoryId,
            gender: cleanGender,
            teamType: cleanTeamType,
            // League ho toh jo bheja (ya null), non-league ho toh hamesha null
            associationNumber: cleanTeamType === "league" ? leagueNumbers.values.associationNumber ?? null : null,
            leagueClassificationNumber:
                cleanTeamType === "league" ? leagueNumbers.values.leagueClassificationNumber ?? null : null,
            season: season ? String(season).trim() : "",
            teamCapacity: isNaN(capacityNum) || capacityNum < 1 ? 20 : capacityNum,
            coachId: resolvedCoachId,
            homeVenueId: venue.venueId,
            preferredTrainingDays: days.days,
            ...schedule.values,
            status: status && VALID_STATUSES.includes(String(status).toLowerCase()) ? String(status).toLowerCase() : "active",
            createdBy: req.user._id,
        });

        const saved = await populateTeam(Team.findById(newTeam._id));

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Team created successfully.",
            message_desc: "Team created successfully.",
            data: formatTeam(saved),
        });
    } catch (e) {
        return sendServerError(res, "Create team", e);
    }
};

/**
 * GET /api/user/teams
 * Query params: ?clubId=&categoryId=&coachId=&homeVenueId=&trainingDay=&gender=&teamType=&status=&search=&page=1&limit=10
 */
const listTeams = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        const categoryId = String(req.query.categoryId || "").trim();
        const coachId = String(req.query.coachId || "").trim();
        const homeVenueId = String(req.query.homeVenueId || "").trim();
        const trainingDay = String(req.query.trainingDay || "").trim().toLowerCase();
        const gender = String(req.query.gender || "").trim().toLowerCase();
        const teamType = String(req.query.teamType || "").trim().toLowerCase();
        const { page, limit, skip } = getPagination(req.query);

        const filter = {};

        // Club scoping: clubAdmin aur coach sirf apne club ki teams. SuperAdmin sab (ya clubId filter).
        if ([ROLES.CLUB_ADMIN, ROLES.COACH].includes(req.user.role)) {
            if (!req.clubId) return sendError(res, 403, "Your account is not linked to any club.");
            filter.clubId = req.clubId;
        } else if (req.user.role !== ROLES.SUPER_ADMIN) {
            return sendError(res, 403, "Access denied.");
        } else if (clubId) {
            if (!isValidId(clubId)) return sendError(res, 400, "Invalid club id.");
            filter.clubId = clubId;
        }

        if (categoryId && isValidId(categoryId)) filter.categoryId = categoryId;
        if (coachId && isValidId(coachId)) filter.coachId = coachId;

        // Venue filter: id, ya "none" = jinka home venue nahi
        if (homeVenueId === "none") filter.homeVenueId = null;
        else if (homeVenueId && isValidId(homeVenueId)) filter.homeVenueId = homeVenueId;

        // Is din training wali teams (jaise ?trainingDay=tue)
        if (trainingDay && WEEK_DAYS.includes(trainingDay)) filter.preferredTrainingDays = trainingDay;

        if (gender && VALID_GENDERS.includes(gender)) filter.gender = gender;
        if (teamType && VALID_TEAM_TYPES.includes(teamType)) filter.teamType = teamType;

        const statusFilter = String(req.query.status || "").trim().toLowerCase();
        if (statusFilter && VALID_STATUSES.includes(statusFilter)) filter.status = statusFilter;

        if (search) {
            const rx = new RegExp(escapeRegex(search), "i");
            filter.$or = [{ name: rx }, { season: rx }];
        }

        const [teams, total] = await Promise.all([
            populateTeam(Team.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
            Team.countDocuments(filter),
        ]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Teams fetched successfully.",
            message_desc: "Teams fetched successfully.",
            data: {
                teams: teams.map(formatTeam),
                total,
                page,
                limit,
            },
        });
    } catch (e) {
        return sendServerError(res, "List teams", e);
    }
};

/**
 * GET /api/user/teams/:id
 */
const getTeam = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid team id.");

        const team = await populateTeam(Team.findById(id));
        if (!team || !canAccess(req, team.clubId)) return sendError(res, 404, "Team not found.");

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Team fetched successfully.",
            message_desc: "Team fetched successfully.",
            data: formatTeam(team),
        });
    } catch (e) {
        return sendServerError(res, "Get team", e);
    }
};

/**
 * PUT /api/user/teams/:id/update
 * Body: { name?, clubId?, categoryId?, gender?, teamType?, season?, teamCapacity?, coachId?, status?,
 *         associationNumber?, leagueClassificationNumber?   (sirf league. team non-league bani toh dono null)
 *         homeVenueId?, preferredTrainingDays?, unavailableHours?, athleticsTraining? }
 * homeVenueId: "" = venue hatana.  preferredTrainingDays / unavailableHours: [] = sab hatana (poori list replace).
 * athleticsTraining: { enabled: false } = band karna.
 * Response ke "coachMatch" mein coach aur team ke din kitne milte hain.
 * Rule: league team par aisa coach nahi lag sakta jo pehle se doosri league team ka coach hai (409).
 *       Ye check tab chalta hai jab coach badle ya team league bane. Purane data par baaki edit rukte nahi.
 */
const updateTeam = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid team id.");

        const team = await Team.findById(id);
        if (!team || !canAccess(req, team.clubId)) return sendError(res, 404, "Team not found.");

        const body = req.body || {};
        const { name, clubId, categoryId, gender, teamType, season, teamCapacity, coachId, status } = body;

        // League coach rule ke liye: edit se pehle coach aur type kya the
        const oldCoachId = team.coachId ? String(team.coachId) : null;
        const oldTeamType = team.teamType;

        // Unavailable hours + athletics + league numbers pehle hi check
        const schedule = validateTeamSchedule(body);
        if (schedule.message) return sendError(res, 400, schedule.message);
        const leagueNumbers = parseLeagueNumbers(body);
        if (leagueNumbers.message) return sendError(res, 400, leagueNumbers.message);

        // 1. Club update (superAdmin only)
        let targetClubId = team.clubId;
        let clubChanged = false;
        if (clubId !== undefined && req.user.role === ROLES.SUPER_ADMIN) {
            const cleanClubId = String(clubId).trim();
            if (!isValidId(cleanClubId) || !(await Club.exists({ _id: cleanClubId }))) {
                return sendError(res, 400, "Please select a valid club.");
            }
            clubChanged = String(cleanClubId) !== String(team.clubId);
            team.clubId = cleanClubId;
            targetClubId = cleanClubId;
        }

        // 2. Name update
        if (name !== undefined) {
            const trimmedName = String(name).trim();
            if (!trimmedName || trimmedName.length < 2) {
                return sendError(res, 400, "Team name must be at least 2 characters.");
            }

            const duplicate = await Team.findOne({
                _id: { $ne: team._id },
                clubId: targetClubId,
                name: new RegExp(`^${escapeRegex(trimmedName)}$`, "i"),
            });
            if (duplicate) return sendError(res, 409, "A team with this name already exists in this club.");
            team.name = trimmedName;
        }

        // 3. Category update
        if (categoryId !== undefined) {
            const cleanCatId = String(categoryId).trim();
            if (!isValidId(cleanCatId) || !(await TeamCategory.exists({ _id: cleanCatId }))) {
                return sendError(res, 400, "Please select a valid category.");
            }
            team.categoryId = cleanCatId;
        }

        // 4. Gender update
        if (gender !== undefined) {
            const g = String(gender).toLowerCase();
            if (VALID_GENDERS.includes(g)) team.gender = g;
        }

        // 5. Team type update
        if (teamType !== undefined) {
            const t = String(teamType).toLowerCase();
            if (VALID_TEAM_TYPES.includes(t)) team.teamType = t;
        }

        // 5b. League numbers: league team par jo bheja wahi, non-league par dono null
        if (team.teamType === "league") {
            Object.assign(team, leagueNumbers.values);
        } else {
            team.associationNumber = null;
            team.leagueClassificationNumber = null;
        }

        // 6. Season update
        if (season !== undefined) team.season = String(season).trim();

        // 7. Capacity update
        if (teamCapacity !== undefined) {
            const num = Number(teamCapacity);
            if (!isNaN(num) && num >= 1) team.teamCapacity = num;
        }

        // Status update (active / inactive)
        if (status !== undefined) {
            const st = String(status).toLowerCase();
            if (VALID_STATUSES.includes(st)) team.status = st;
        }

        // 8. Coach update (can be null/empty to unassign)
        if (coachId !== undefined) {
            if (!coachId || String(coachId).trim() === "") {
                team.coachId = null;
            } else {
                const cleanCoachId = String(coachId).trim();
                if (!isValidId(cleanCoachId)) return sendError(res, 400, "Invalid coach id.");
                const coach = await Coach.findById(cleanCoachId);
                if (!coach) return sendError(res, 404, "Coach not found.");
                if (String(coach.clubId) !== String(targetClubId)) {
                    return sendError(res, 400, "Selected coach does not belong to this club.");
                }
                team.coachId = coach._id;
            }
        }

        // 8b. Ek coach sirf ek league team ka (youth par rok nahi).
        //     Sirf tab check: naya coach laga, ya team non-league se league bani.
        const newCoachId = team.coachId ? String(team.coachId) : null;
        const coachChanged = newCoachId !== oldCoachId;
        const becameLeague = oldTeamType !== "league" && team.teamType === "league";
        if (newCoachId && team.teamType === "league" && (coachChanged || becameLeague)) {
            const otherTeam = await findOtherLeagueTeamOfCoach(team.coachId, team._id);
            if (otherTeam) return leagueCoachError(res, otherTeam);
        }

        // 9. Home venue update ("" = hatana). Club badla aur venue nahi bheja toh purana venue hata do
        //    (wo purane club ki facility thi)
        if (body.homeVenueId !== undefined) {
            const venue = await resolveHomeVenue(body.homeVenueId, targetClubId);
            if (venue.message) return sendError(res, venue.status, venue.message);
            team.homeVenueId = venue.venueId;
        } else if (clubChanged) {
            team.homeVenueId = null;
        }

        // 10. Preferred training days update ([] = saare hatana)
        if (body.preferredTrainingDays !== undefined) {
            const days = parseTrainingDays(body.preferredTrainingDays);
            if (days.message) return sendError(res, 400, days.message);
            team.preferredTrainingDays = days.days;
        }

        // 11. Unavailable hours + athletics (sirf jo bheje gaye)
        Object.assign(team, schedule.values);

        await team.save();

        const updated = await populateTeam(Team.findById(team._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Team updated successfully.",
            message_desc: "Team updated successfully.",
            data: formatTeam(updated),
        });
    } catch (e) {
        return sendServerError(res, "Update team", e);
    }
};

/**
 * DELETE /api/user/teams/:id/delete
 */
const deleteTeam = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid team id.");

        const team = await Team.findById(id);
        if (!team || !canAccess(req, team.clubId)) return sendError(res, 404, "Team not found.");

        await Team.findByIdAndDelete(team._id);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Team deleted successfully.",
            message_desc: "Team deleted successfully.",
            data: { _id: team._id },
        });
    } catch (e) {
        return sendServerError(res, "Delete team", e);
    }
};

/**
 * Coach suggestions (club admin coach chunne se pehle dekhe kaun sabse fit hai)
 *   GET /api/user/teams/:id/coach-suggestions?days=sun,tue&teamType=league   -> bani hui team
 *   GET /api/user/teams/coach-suggestions?clubId=&days=sun,tue&teamType=league -> nayi team ka form
 * days / teamType na do toh team ke saved values (nayi team: koi din nahi, type league).
 * Club ke saare coaches, best match pehle. League team par jo coach pehle se doosri league team ka hai,
 * wo "assignedLeagueTeam" ke saath sabse neeche (wo yahan assign nahi ho sakta). Sirf batata hai, assign nahi karta.
 */
const coachSuggestions = async (req, res) => {
    try {
        const { id } = req.params;
        let clubId;
        let teamDays;
        let teamType = "league"; // createTeam ka default bhi league hai
        let currentCoachId = null;

        if (id) {
            if (!isValidId(id)) return sendError(res, 400, "Invalid team id.");
            const team = await Team.findById(id).select("clubId preferredTrainingDays coachId teamType");
            if (!team || !canAccess(req, team.clubId)) return sendError(res, 404, "Team not found.");
            clubId = team.clubId;
            teamDays = team.preferredTrainingDays || [];
            teamType = team.teamType || "league";
            currentCoachId = team.coachId ? String(team.coachId) : null;
        } else {
            clubId = req.user.role === ROLES.CLUB_ADMIN ? req.clubId : String(req.query.clubId || "").trim();
            if (!isValidId(String(clubId || ""))) return sendError(res, 400, "Please select a valid club.");
            teamDays = [];
        }

        // Form mein din / type badle par abhi save nahi kiye: query se unhi par match
        if (req.query.days !== undefined) {
            const parsed = parseTrainingDays(req.query.days);
            if (parsed.message) return sendError(res, 400, parsed.message);
            teamDays = parsed.days;
        }
        if (req.query.teamType !== undefined) {
            const t = String(req.query.teamType).trim().toLowerCase();
            if (!VALID_TEAM_TYPES.includes(t)) return sendError(res, 400, `Team type must be one of: ${VALID_TEAM_TYPES.join(", ")}.`);
            teamType = t;
        }

        const coaches = await Coach.find({ clubId })
            .select("userId preferredTrainingDays unavailableHours")
            .populate("userId", "firstname lastname profile_image");
        const coachIds = coaches.map((c) => c._id);

        // Har coach kitni active teams pehle se sambhal raha hai
        const teamCounts = await Team.aggregate([
            { $match: { coachId: { $in: coachIds }, status: "active" } },
            { $group: { _id: "$coachId", count: { $sum: 1 } } },
        ]);
        const countOf = Object.fromEntries(teamCounts.map((t) => [String(t._id), t.count]));

        // League team ke liye: kaunse coach pehle se kisi (doosri) league team ke coach hain
        const leagueTeams = teamType === "league"
            ? await Team.find({
                coachId: { $in: coachIds },
                teamType: "league",
                ...(id ? { _id: { $ne: id } } : {}),
            }).select("name coachId")
            : [];
        const leagueTeamOf = Object.fromEntries(leagueTeams.map((t) => [String(t.coachId), { _id: t._id, name: t.name }]));

        const suggestions = coaches
            .map((coach) => ({
                coachId: coach._id,
                userId: coach.userId?._id || null,
                firstname: coach.userId?.firstname || "",
                lastname: coach.userId?.lastname || "",
                profile_image: coach.userId?.profile_image || "",
                isCurrentCoach: currentCoachId === String(coach._id),
                activeTeams: countOf[String(coach._id)] || 0,
                // League team par: ye coach doosri league team ka hai toh yahan assign nahi ho sakta
                assignedLeagueTeam: leagueTeamOf[String(coach._id)] || null,
                match: computeCoachMatch(teamDays, coach),
            }))
            .sort((a, b) =>
                Number(Boolean(a.assignedLeagueTeam)) - Number(Boolean(b.assignedLeagueTeam)) ||
                LEVEL_RANK[a.match.level] - LEVEL_RANK[b.match.level] ||
                (b.match.matchPercent ?? -1) - (a.match.matchPercent ?? -1) ||
                a.match.unavailableOnTeamDays.length - b.match.unavailableOnTeamDays.length ||
                a.activeTeams - b.activeTeams ||
                `${a.firstname} ${a.lastname}`.localeCompare(`${b.firstname} ${b.lastname}`)
            );

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coach suggestions fetched successfully.",
            message_desc: "Coach suggestions fetched successfully.",
            data: { teamDays, teamType, suggestions },
        });
    } catch (e) {
        return sendServerError(res, "Coach suggestions", e);
    }
};

module.exports = {
    createTeam,
    listTeams,
    getTeam,
    updateTeam,
    deleteTeam,
    coachSuggestions,
    computeCoachMatch,
};