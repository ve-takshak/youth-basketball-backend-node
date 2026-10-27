const Team = require("../../models/Team");
const { WEEK_DAYS } = require("../../models/Team");
const Club = require("../../models/Club");
const Coach = require("../../models/Coach");
const Facility = require("../../models/Facility");
const TeamCategory = require("../../models/TeamCategory");
const { ROLES } = require("../../helpers/constants");
const { isValidId, escapeRegex, getPagination } = require("../../helpers/common");

const VALID_GENDERS = ["boys", "girls", "mixed"];
const VALID_TEAM_TYPES = ["league", "non-league"];
const VALID_STATUSES = ["active", "inactive"];

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

/**
 * Format team object for API response
 * (create, list, get, update sab isi se response banate hain)
 */
const formatTeam = (record) => {
    if (!record) return null;
    return {
        _id: record._id,
        name: record.name,
        club: record.clubId && typeof record.clubId === "object" ? {
            _id: record.clubId._id,
            name: record.clubId.name,
        } : (record.clubId ? { _id: record.clubId } : null),
        category: record.categoryId && typeof record.categoryId === "object" ? {
            _id: record.categoryId._id,
            name: record.categoryId.name,
        } : (record.categoryId ? { _id: record.categoryId } : null),
        coach: record.coachId && typeof record.coachId === "object" ? {
            _id: record.coachId._id,
            firstname: record.coachId.userId?.firstname || "",
            lastname: record.coachId.userId?.lastname || "",
            userId: record.coachId.userId?._id,
            // Coach ki profile photo (User se)
            profile_image: record.coachId.userId?.profile_image || "",
            mobileNumber: record.coachId.userId?.mobileNumber || "",
            email: record.coachId.userId?.email || "",
        } : (record.coachId ? { _id: record.coachId } : null),
        // Home venue (Facility). Facility delete ho gayi ho toh null
        homeVenue: record.homeVenueId && typeof record.homeVenueId === "object" && record.homeVenueId._id ? {
            _id: record.homeVenueId._id,
            name: record.homeVenueId.name,
            address: record.homeVenueId.address || "",
            type: record.homeVenueId.type,
        } : null,
        preferredTrainingDays: record.preferredTrainingDays || [],
        gender: record.gender || "mixed",
        teamType: record.teamType || "league",
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
        .populate("homeVenueId", "name address type")
        .populate({
            path: "coachId",
            select: "userId clubId",
            populate: {
                path: "userId",
                // profile_image bhi chahiye (formatTeam mein coach ke saath bhejte hain)
                select: "firstname lastname email countryCode mobileNumber profile_image",
            },
        });

const canAccess = (req, teamClubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(teamClubId?._id || teamClubId);

/**
 * Preferred training days check.
 * Chalega: ["sun","tue"] (JSON) ya '["sun","tue"]' / "sun,tue" (form-data). "" / [] = koi din nahi.
 * Duplicate hat jaate hain, order hamesha Sun → Sat.
 * Galti ho toh { message }, warna { days }
 */
const parseTrainingDays = (raw) => {
    let list = raw;
    if (raw === null || raw === "") list = [];
    if (typeof raw === "string" && raw.trim()) {
        const text = raw.trim();
        if (text.startsWith("[")) {
            try {
                list = JSON.parse(text);
            } catch (e) {
                return { message: "Preferred training days must be a valid list." };
            }
        } else {
            list = text.split(",");
        }
    }
    if (!Array.isArray(list)) return { message: "Preferred training days must be a list." };

    const days = [...new Set(list.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean))];
    const invalid = days.find((d) => !WEEK_DAYS.includes(d));
    if (invalid) return { message: `Invalid training day "${invalid}". Use: ${WEEK_DAYS.join(", ")}.` };

    days.sort((a, b) => WEEK_DAYS.indexOf(a) - WEEK_DAYS.indexOf(b));
    return { days };
};

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

/**
 * POST /api/user/teams/create
 * Body: { name, clubId, categoryId, gender?, teamType?, season?, teamCapacity?, coachId?, status?,
 *         homeVenueId?, preferredTrainingDays? }
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

        const capacityNum = teamCapacity !== undefined && teamCapacity !== "" ? Number(teamCapacity) : 20;

        const newTeam = await Team.create({
            name: trimmedName,
            clubId: targetClubId,
            categoryId: targetCategoryId,
            gender: cleanGender,
            teamType: cleanTeamType,
            season: season ? String(season).trim() : "",
            teamCapacity: isNaN(capacityNum) || capacityNum < 1 ? 20 : capacityNum,
            coachId: resolvedCoachId,
            homeVenueId: venue.venueId,
            preferredTrainingDays: days.days,
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
 *         homeVenueId?, preferredTrainingDays? }
 * homeVenueId: "" = venue hatana.  preferredTrainingDays: [] = saare din hatana.
 */
const updateTeam = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid team id.");

        const team = await Team.findById(id);
        if (!team || !canAccess(req, team.clubId)) return sendError(res, 404, "Team not found.");

        const body = req.body || {};
        const { name, clubId, categoryId, gender, teamType, season, teamCapacity, coachId, status } = body;

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

module.exports = {
    createTeam,
    listTeams,
    getTeam,
    updateTeam,
    deleteTeam,
};