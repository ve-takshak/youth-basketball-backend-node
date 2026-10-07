const User = require("../../models/User");
const Club = require("../../models/Club");
const Coach = require("../../models/Coach");
const Team = require("../../models/Team");
const { ROLES } = require("../../helpers/constants");
const { isValidId, escapeRegex, getPagination } = require("../../helpers/common");
const { validatePersonInput, findDuplicateUser, applyPersonUpdates } = require("../../helpers/userHelper");

// Coach + uska User + Club ek flat object mein (frontend ke liye aasaan)
const formatCoach = (record, assignedTeams = null) => ({
    _id: record._id,
    userId: record.userId?._id || record.userId,
    firstname: record.userId?.firstname || "",
    lastname: record.userId?.lastname || "",
    email: record.userId?.email || "",
    countryCode: record.userId?.countryCode || "",
    mobileNumber: record.userId?.mobileNumber || "",
    birthDate: record.userId?.birthDate ? new Date(record.userId.birthDate).toISOString().split("T")[0] : null,
    is_verify: record.userId?.is_verify || false,
    club: record.clubId ? { _id: record.clubId._id, name: record.clubId.name } : null,
    teams: assignedTeams || record.teams || [],
    createdAt: record.createdAt,
});

const populateCoach = (query) =>
    query
        .populate("userId", "firstname lastname email countryCode mobileNumber birthDate is_verify")
        .populate("clubId", "name");

// clubAdmin sirf apne club ke coach ko chhu sakta hai. SuperAdmin sab ko.
const canAccess = (req, coachClubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(coachClubId?._id || coachClubId);

/**
 * POST /api/user/createCoach   (superAdmin ya clubAdmin)
 * body: { firstname, lastname, countryCode, mobileNumber, clubId (clubAdmin ke liye ignore), email? }
 * User (role: coach) + Coach record dono banata hai.
 */
const createCoach = async (req, res) => {
    let user = null;
    try {
        const checked = validatePersonInput(req.body);
        if (checked.message) {
            return res.status(checked.status).json({
                error: true,
                status: checked.status,
                message: checked.message,
                message_desc: checked.message,
                data: {},
            });
        }
        const { firstname, lastname, email, countryCode, mobileNumber, birthDate } = checked.values;

        // clubAdmin apne hi club mein coach banayega, superAdmin body se club chunega
        const clubId = req.user.role === ROLES.CLUB_ADMIN ? String(req.clubId) : String(req.body.clubId || "").trim();

        if (!isValidId(clubId)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Please select a valid club.",
                message_desc: "Please select a valid club.",
                data: {},
            });
        }

        const club = await Club.findById(clubId);
        if (!club) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club not found.",
                message_desc: "Club not found.",
                data: {},
            });
        }

        const duplicate = await findDuplicateUser({ countryCode, mobileNumber, email });
        if (duplicate) {
            return res.status(duplicate.status).json({
                error: true,
                status: duplicate.status,
                message: duplicate.message,
                message_desc: duplicate.message,
                data: {},
            });
        }

        // 1. Login wala user. Ye apne number + OTP 0000 se login karega.
        user = await User.create({
            firstname,
            lastname,
            email: email || undefined,
            birthDate: birthDate || undefined,
            countryCode,
            mobileNumber,
            role: ROLES.COACH,
        });

        // 2. Coach record jo club se juda hai
        const record = await Coach.create({
            userId: user._id,
            clubId: club._id,
            createdBy: req.user._id,
        });

        const saved = await populateCoach(Coach.findById(record._id));

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Coach created successfully.",
            message_desc: "Coach created successfully.",
            data: formatCoach(saved),
        });
    } catch (e) {
        // Coach record fail hua toh adhoora user bhi hata do
        if (user) await User.findByIdAndDelete(user._id).catch(() => {});
        console.error("Create coach error:", e);
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
 * GET /api/user/listCoaches?clubId=&search=&page=1&limit=10   (superAdmin ya clubAdmin)
 * search: naam ya mobile number se
 */
const listCoaches = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        const { page, limit, skip } = getPagination(req.query);

        const filter = {};

        if (req.user.role === ROLES.CLUB_ADMIN) {
            // clubAdmin sirf apne club ke coaches dekhega
            filter.clubId = req.clubId;
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

        // Naam/mobile User mein hai, isliye pehle matching users dhundo
        if (search) {
            const regex = new RegExp(escapeRegex(search), "i");
            const users = await User.find({
                role: ROLES.COACH,
                $or: [{ firstname: regex }, { lastname: regex }, { mobileNumber: regex }],
            }).select("_id");
            filter.userId = { $in: users.map((u) => u._id) };
        }

        const [records, total] = await Promise.all([
            populateCoach(Coach.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
            Coach.countDocuments(filter),
        ]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coaches fetched successfully.",
            message_desc: "Coaches fetched successfully.",
            data: {
                coaches: records.map(formatCoach),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        console.error("List coaches error:", e);
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
 * GET /api/user/getCoach/:id   (superAdmin ya clubAdmin, :id = Coach ki _id)
 */
const getCoach = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid coach id.",
                message_desc: "Invalid coach id.",
                data: {},
            });
        }

        const record = await populateCoach(Coach.findById(id));
        if (!record || !canAccess(req, record.clubId)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Coach not found.",
                message_desc: "Coach not found.",
                data: {},
            });
        }

        // Fetch any teams assigned to this coach
        const assignedTeams = await Team.find({ coachId: record._id })
            .populate("categoryId", "name")
            .select("name season gender teamType categoryId");

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coach fetched successfully.",
            message_desc: "Coach fetched successfully.",
            data: formatCoach(record, assignedTeams),
        });
    } catch (e) {
        console.error("Get coach error:", e);
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
 * PUT /api/user/updateCoach/:id   (superAdmin ya clubAdmin, :id = Coach ki _id)
 * body: jo badalna hai wahi { firstname?, lastname?, email?, countryCode?, mobileNumber?, clubId? (clubAdmin ke liye ignore) }
 */
const updateCoach = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid coach id.",
                message_desc: "Invalid coach id.",
                data: {},
            });
        }

        const record = await Coach.findById(id);
        if (!record || !canAccess(req, record.clubId)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Coach not found.",
                message_desc: "Coach not found.",
                data: {},
            });
        }

        const user = await User.findById(record.userId);
        if (!user) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Coach user not found.",
                message_desc: "Coach user not found.",
                data: {},
            });
        }

        const updateError = await applyPersonUpdates(user, req.body);
        if (updateError) {
            return res.status(updateError.status).json({
                error: true,
                status: updateError.status,
                message: updateError.message,
                message_desc: updateError.message,
                data: {},
            });
        }

        const { clubId } = req.body;
        if (clubId !== undefined && req.user.role === ROLES.SUPER_ADMIN) {
            if (!isValidId(clubId) || !(await Club.exists({ _id: clubId }))) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Please select a valid club.",
                    message_desc: "Please select a valid club.",
                    data: {},
                });
            }
            record.clubId = clubId;
        }

        await user.save();
        await record.save();

        const saved = await populateCoach(Coach.findById(record._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coach updated successfully.",
            message_desc: "Coach updated successfully.",
            data: formatCoach(saved),
        });
    } catch (e) {
        console.error("Update coach error:", e);
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
 * DELETE /api/user/deleteCoach/:id   (superAdmin ya clubAdmin, :id = Coach ki _id)
 * Coach record aur uska User dono hatata hai.
 */
const deleteCoach = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid coach id.",
                message_desc: "Invalid coach id.",
                data: {},
            });
        }

        const record = await Coach.findById(id);
        if (!record || !canAccess(req, record.clubId)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Coach not found.",
                message_desc: "Coach not found.",
                data: {},
            });
        }

        await Coach.findByIdAndDelete(record._id);
        await User.findByIdAndDelete(record.userId);
        // Nullify coach assignment on any teams assigned to this coach
        await Team.updateMany({ coachId: record._id }, { $set: { coachId: null } });

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coach deleted successfully.",
            message_desc: "Coach deleted successfully.",
            data: { _id: record._id },
        });
    } catch (e) {
        console.error("Delete coach error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = { createCoach, listCoaches, getCoach, updateCoach, deleteCoach };
