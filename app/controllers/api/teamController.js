const Team = require("../../models/Team");
const Club = require("../../models/Club");
const Coach = require("../../models/Coach");
const TeamCategory = require("../../models/TeamCategory");
const { ROLES } = require("../../helpers/constants");
const { isValidId, escapeRegex, getPagination } = require("../../helpers/common");

const VALID_GENDERS = ["boys", "girls", "mixed"];
const VALID_TEAM_TYPES = ["league", "non-league"];
const VALID_STATUSES = ["active", "inactive"];

/**
 * Format team object for API response
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
            name: record.coachId.userId ? `${record.coachId.userId.firstname || ""} ${record.coachId.userId.lastname || ""}`.trim() : "",
            userId: record.coachId.userId?._id,
            mobileNumber: record.coachId.userId?.mobileNumber || "",
            email: record.coachId.userId?.email || "",
        } : (record.coachId ? { _id: record.coachId } : null),
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
        .populate({
            path: "coachId",
            select: "userId clubId",
            populate: {
                path: "userId",
                select: "firstname lastname email countryCode mobileNumber",
            },
        });

const canAccess = (req, teamClubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(teamClubId?._id || teamClubId);

/**
 * POST /api/user/teams/create
 * Body: { name, clubId, categoryId, gender?, teamType?, season?, teamCapacity?, coachId? }
 */
const createTeam = async (req, res) => {
    try {
        const { name, categoryId, gender, teamType, season, teamCapacity, coachId, status } = req.body;

        // 1. Validate team name
        if (!name || typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Team name is required.",
                message_desc: "Team name is required.",
                data: {},
            });
        }
        const trimmedName = name.trim();
        if (trimmedName.length < 2) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Team name must be at least 2 characters.",
                message_desc: "Team name must be at least 2 characters.",
                data: {},
            });
        }

        // 2. Resolve & validate club
        const targetClubId = req.user.role === ROLES.CLUB_ADMIN
            ? String(req.clubId)
            : String(req.body.clubId || "").trim();

        if (!isValidId(targetClubId)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Please select a valid club.",
                message_desc: "Please select a valid club.",
                data: {},
            });
        }

        const clubExists = await Club.exists({ _id: targetClubId });
        if (!clubExists) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club not found.",
                message_desc: "Club not found.",
                data: {},
            });
        }

        // 3. Validate category
        const targetCategoryId = String(categoryId || "").trim();
        if (!isValidId(targetCategoryId)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Please select a valid category.",
                message_desc: "Please select a valid category.",
                data: {},
            });
        }

        const categoryExists = await TeamCategory.exists({ _id: targetCategoryId });
        if (!categoryExists) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Category not found.",
                message_desc: "Category not found.",
                data: {},
            });
        }

        // 4. Validate coach (optional)
        let resolvedCoachId = null;
        if (coachId && String(coachId).trim()) {
            const cleanCoachId = String(coachId).trim();
            if (!isValidId(cleanCoachId)) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Invalid coach id.",
                    message_desc: "Invalid coach id.",
                    data: {},
                });
            }

            const coach = await Coach.findById(cleanCoachId);
            if (!coach) {
                return res.status(404).json({
                    error: true,
                    status: 404,
                    message: "Coach not found.",
                    message_desc: "Coach not found.",
                    data: {},
                });
            }

            if (String(coach.clubId) !== String(targetClubId)) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Selected coach does not belong to this club.",
                    message_desc: "Selected coach does not belong to this club.",
                    data: {},
                });
            }

            resolvedCoachId = coach._id;
        }

        // 5. Duplicate check (within same club)
        const duplicate = await Team.findOne({
            clubId: targetClubId,
            name: new RegExp(`^${escapeRegex(trimmedName)}$`, "i"),
        });
        if (duplicate) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "A team with this name already exists in this club.",
                message_desc: "A team with this name already exists in this club.",
                data: {},
            });
        }

        // 6. Validate gender & teamType
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
        console.error("Create team error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * GET /api/user/teams
 * Query params: ?clubId=&categoryId=&coachId=&gender=&teamType=&search=&page=1&limit=10
 */
const listTeams = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        const categoryId = String(req.query.categoryId || "").trim();
        const coachId = String(req.query.coachId || "").trim();
        const gender = String(req.query.gender || "").trim().toLowerCase();
        const teamType = String(req.query.teamType || "").trim().toLowerCase();
        const { page, limit, skip } = getPagination(req.query);

        const filter = {};

        // Club scoping: clubAdmin aur coach sirf apne club ki teams. SuperAdmin sab (ya clubId filter).
        if ([ROLES.CLUB_ADMIN, ROLES.COACH].includes(req.user.role)) {
            if (!req.clubId) {
                return res.status(403).json({
                    error: true,
                    status: 403,
                    message: "Your account is not linked to any club.",
                    message_desc: "Your account is not linked to any club.",
                    data: {},
                });
            }
            filter.clubId = req.clubId;
        } else if (req.user.role !== ROLES.SUPER_ADMIN) {
            return res.status(403).json({
                error: true,
                status: 403,
                message: "Access denied.",
                message_desc: "Access denied.",
                data: {},
            });
        } else if (clubId) {
            if (!isValidId(clubId)) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Invalid club id.",
                    message_desc: "Invalid club id.",
                    data: {},
                });
            }
            filter.clubId = clubId;
        }

        if (categoryId) {
            if (isValidId(categoryId)) filter.categoryId = categoryId;
        }

        if (coachId) {
            if (isValidId(coachId)) filter.coachId = coachId;
        }

        if (gender && VALID_GENDERS.includes(gender)) {
            filter.gender = gender;
        }

        if (teamType && VALID_TEAM_TYPES.includes(teamType)) {
            filter.teamType = teamType;
        }

        const statusFilter = String(req.query.status || "").trim().toLowerCase();
        if (statusFilter && VALID_STATUSES.includes(statusFilter)) {
            filter.status = statusFilter;
        }

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
        console.error("List teams error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * GET /api/user/teams/:id
 */
const getTeam = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid team id.",
                message_desc: "Invalid team id.",
                data: {},
            });
        }

        const team = await populateTeam(Team.findById(id));
        if (!team || !canAccess(req, team.clubId)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Team not found.",
                message_desc: "Team not found.",
                data: {},
            });
        }

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Team fetched successfully.",
            message_desc: "Team fetched successfully.",
            data: formatTeam(team),
        });
    } catch (e) {
        console.error("Get team error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * PUT /api/user/teams/:id/update
 * Body: { name?, clubId?, categoryId?, gender?, teamType?, season?, teamCapacity?, coachId? }
 */
const updateTeam = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid team id.",
                message_desc: "Invalid team id.",
                data: {},
            });
        }

        const team = await Team.findById(id);
        if (!team || !canAccess(req, team.clubId)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Team not found.",
                message_desc: "Team not found.",
                data: {},
            });
        }

        const { name, clubId, categoryId, gender, teamType, season, teamCapacity, coachId, status } = req.body;

        // 1. Club update (superAdmin only)
        let targetClubId = team.clubId;
        if (clubId !== undefined && req.user.role === ROLES.SUPER_ADMIN) {
            const cleanClubId = String(clubId).trim();
            if (!isValidId(cleanClubId) || !(await Club.exists({ _id: cleanClubId }))) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Please select a valid club.",
                    message_desc: "Please select a valid club.",
                    data: {},
                });
            }
            team.clubId = cleanClubId;
            targetClubId = cleanClubId;
        }

        // 2. Name update
        if (name !== undefined) {
            const trimmedName = String(name).trim();
            if (!trimmedName || trimmedName.length < 2) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Team name must be at least 2 characters.",
                    message_desc: "Team name must be at least 2 characters.",
                    data: {},
                });
            }

            const duplicate = await Team.findOne({
                _id: { $ne: team._id },
                clubId: targetClubId,
                name: new RegExp(`^${escapeRegex(trimmedName)}$`, "i"),
            });
            if (duplicate) {
                return res.status(409).json({
                    error: true,
                    status: 409,
                    message: "A team with this name already exists in this club.",
                    message_desc: "A team with this name already exists in this club.",
                    data: {},
                });
            }
            team.name = trimmedName;
        }

        // 3. Category update
        if (categoryId !== undefined) {
            const cleanCatId = String(categoryId).trim();
            if (!isValidId(cleanCatId) || !(await TeamCategory.exists({ _id: cleanCatId }))) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Please select a valid category.",
                    message_desc: "Please select a valid category.",
                    data: {},
                });
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
        if (season !== undefined) {
            team.season = String(season).trim();
        }

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
                if (!isValidId(cleanCoachId)) {
                    return res.status(400).json({
                        error: true,
                        status: 400,
                        message: "Invalid coach id.",
                        message_desc: "Invalid coach id.",
                        data: {},
                    });
                }
                const coach = await Coach.findById(cleanCoachId);
                if (!coach) {
                    return res.status(404).json({
                        error: true,
                        status: 404,
                        message: "Coach not found.",
                        message_desc: "Coach not found.",
                        data: {},
                    });
                }
                if (String(coach.clubId) !== String(targetClubId)) {
                    return res.status(400).json({
                        error: true,
                        status: 400,
                        message: "Selected coach does not belong to this club.",
                        message_desc: "Selected coach does not belong to this club.",
                        data: {},
                    });
                }
                team.coachId = coach._id;
            }
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
        console.error("Update team error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * DELETE /api/user/teams/:id/delete
 */
const deleteTeam = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid team id.",
                message_desc: "Invalid team id.",
                data: {},
            });
        }

        const team = await Team.findById(id);
        if (!team || !canAccess(req, team.clubId)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Team not found.",
                message_desc: "Team not found.",
                data: {},
            });
        }

        await Team.findByIdAndDelete(team._id);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Team deleted successfully.",
            message_desc: "Team deleted successfully.",
            data: { _id: team._id },
        });
    } catch (e) {
        console.error("Delete team error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = {
    createTeam,
    listTeams,
    getTeam,
    updateTeam,
    deleteTeam,
};
