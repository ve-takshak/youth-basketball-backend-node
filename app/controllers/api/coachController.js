const User = require("../../models/User");
const Club = require("../../models/Club");
const Coach = require("../../models/Coach");
const Team = require("../../models/Team");
const { ROLES } = require("../../helpers/constants");
const { isValidId, escapeRegex, getPagination } = require("../../helpers/common");
const { validatePersonInput, findDuplicateUser, applyPersonUpdates } = require("../../helpers/userHelper");
const { parseTrainingDays, parseUnavailableHours } = require("../../helpers/scheduleHelper");
const { deleteFiles } = require("../../../utils/s3");

// Hamare bucket ka base URL, taaki sirf apni S3 files hi delete hon
const getS3BaseUrl = () =>
    `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/`;

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

// Coach delete pe uski profile image S3 se hatana
const removeS3File = async (url) => {
    if (!url) return;
    try {
        const baseUrl = getS3BaseUrl();
        if (!url.startsWith(baseUrl)) return;
        const key = url.replace(baseUrl, "");
        const slash = key.lastIndexOf("/");
        const result = await deleteFiles(key.slice(0, slash), key.slice(slash + 1));
        if (result !== 1) console.warn("Failed to delete coach profile image from S3:", result);
    } catch (err) {
        console.warn("Failed to delete coach profile image:", err.message);
    }
};

// Coach + uska User + Club ek flat object mein (frontend ke liye aasaan)
const formatCoach = (record, assignedTeams = null) => ({
    _id: record._id,
    userId: record.userId?._id || record.userId,
    firstname: record.userId?.firstname || "",
    lastname: record.userId?.lastname || "",
    profile_image: record.userId?.profile_image || "",
    email: record.userId?.email || "",
    countryCode: record.userId?.countryCode || "",
    mobileNumber: record.userId?.mobileNumber || "",
    birthDate: record.userId?.birthDate ? new Date(record.userId.birthDate).toISOString().split("T")[0] : null,
    is_verify: record.userId?.is_verify || false,
    club: record.clubId ? { _id: record.clubId._id, name: record.clubId.name } : null,
    preferredTrainingDays: record.preferredTrainingDays || [],
    unavailableHours: (record.unavailableHours || []).map((b) => ({ day: b.day, from: b.from, to: b.to })),
    teams: assignedTeams || record.teams || [],
    createdAt: record.createdAt,
});

const populateCoach = (query) =>
    query
        .populate("userId", "firstname lastname email countryCode mobileNumber birthDate is_verify profile_image")
        .populate("clubId", "name");

// clubAdmin sirf apne club ke coach ko chhu sakta hai. SuperAdmin sab ko.
const canAccess = (req, coachClubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(coachClubId?._id || coachClubId);

/**
 * Days + unavailable hours (sirf jo bheje gaye). Galti ho toh { message }, warna { values }
 */
const validateAvailability = (body) => {
    const values = {};
    if (body.preferredTrainingDays !== undefined) {
        const days = parseTrainingDays(body.preferredTrainingDays);
        if (days.message) return { message: days.message };
        values.preferredTrainingDays = days.days;
    }
    if (body.unavailableHours !== undefined) {
        const hours = parseUnavailableHours(body.unavailableHours);
        if (hours.message) return { message: hours.message };
        values.unavailableHours = hours.blocks;
    }
    return { values };
};

/**
 * POST /api/user/coaches/create   (superAdmin ya clubAdmin)
 * body: { firstname, lastname, countryCode, mobileNumber, clubId (clubAdmin ke liye ignore), email?, birthDate?,
 *         preferredTrainingDays?: ["sun","tue"], unavailableHours?: [{ day, from, to }] }
 * User (role: coach) + Coach record dono banata hai.
 */
const createCoach = async (req, res) => {
    let user = null;
    try {
        const body = req.body || {};

        const checked = validatePersonInput(body);
        if (checked.message) return sendError(res, checked.status, checked.message);
        const { firstname, lastname, email, countryCode, mobileNumber, birthDate } = checked.values;

        // Days / hours bhi pehle hi check (User banane se pehle)
        const availability = validateAvailability(body);
        if (availability.message) return sendError(res, 400, availability.message);

        // clubAdmin apne hi club mein coach banayega, superAdmin body se club chunega
        const clubId = req.user.role === ROLES.CLUB_ADMIN ? String(req.clubId) : String(body.clubId || "").trim();
        if (!isValidId(clubId)) return sendError(res, 400, "Please select a valid club.");

        const club = await Club.findById(clubId);
        if (!club) return sendError(res, 404, "Club not found.");

        const duplicate = await findDuplicateUser({ countryCode, mobileNumber, email });
        if (duplicate) return sendError(res, duplicate.status, duplicate.message);

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

        // 2. Coach record jo club se juda hai (+ days / hours)
        const record = await Coach.create({
            userId: user._id,
            clubId: club._id,
            ...availability.values,
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
        return sendServerError(res, "Create coach", e);
    }
};

/**
 * GET /api/user/coaches?clubId=&search=&page=1&limit=10   (superAdmin ya clubAdmin)
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
            if (!isValidId(clubId)) return sendError(res, 400, "Invalid club id.");
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
                coaches: records.map((record) => formatCoach(record)),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        return sendServerError(res, "List coaches", e);
    }
};

/**
 * GET /api/user/coaches/:id   (superAdmin ya clubAdmin, :id = Coach ki _id)
 */
const getCoach = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid coach id.");

        const record = await populateCoach(Coach.findById(id));
        if (!record || !canAccess(req, record.clubId)) return sendError(res, 404, "Coach not found.");

        // Coach ki teams
        const assignedTeams = await Team.find({ coachId: record._id })
            .populate("categoryId", "name")
            .select("name season gender teamType status categoryId");

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coach fetched successfully.",
            message_desc: "Coach fetched successfully.",
            data: formatCoach(record, assignedTeams),
        });
    } catch (e) {
        return sendServerError(res, "Get coach", e);
    }
};

/**
 * PUT /api/user/coaches/:id/update   (superAdmin ya clubAdmin, :id = Coach ki _id)
 * body: jo badalna hai wahi { firstname?, lastname?, email?, countryCode?, mobileNumber?, birthDate?,
 *       clubId? (sirf superAdmin), preferredTrainingDays?, unavailableHours? }
 * preferredTrainingDays / unavailableHours bheje toh POORI list replace hoti hai ([] = sab hatana).
 */
const updateCoach = async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};
        if (!isValidId(id)) return sendError(res, 400, "Invalid coach id.");

        const record = await Coach.findById(id);
        if (!record || !canAccess(req, record.clubId)) return sendError(res, 404, "Coach not found.");

        const user = await User.findById(record.userId);
        if (!user) return sendError(res, 404, "Coach user not found.");

        // Days / hours pehle check (taaki galti par kuch bhi save na ho)
        const availability = validateAvailability(body);
        if (availability.message) return sendError(res, 400, availability.message);

        const updateError = await applyPersonUpdates(user, body);
        if (updateError) return sendError(res, updateError.status, updateError.message);

        const { clubId } = body;
        if (clubId !== undefined && req.user.role === ROLES.SUPER_ADMIN) {
            if (!isValidId(clubId) || !(await Club.exists({ _id: clubId }))) {
                return sendError(res, 400, "Please select a valid club.");
            }
            record.clubId = clubId;
        }

        Object.assign(record, availability.values);

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
        return sendServerError(res, "Update coach", e);
    }
};

/**
 * DELETE /api/user/coaches/:id/delete   (superAdmin ya clubAdmin, :id = Coach ki _id)
 * Coach record, uska User aur uski profile image (S3) hatata hai.
 */
const deleteCoach = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid coach id.");

        const record = await Coach.findById(id);
        if (!record || !canAccess(req, record.clubId)) return sendError(res, 404, "Coach not found.");

        const coachUser = await User.findById(record.userId).select("profile_image");

        await Coach.findByIdAndDelete(record._id);
        await User.findByIdAndDelete(record.userId);
        // Is coach ki teams se coach hata do
        await Team.updateMany({ coachId: record._id }, { $set: { coachId: null } });
        // Profile image bhi S3 se
        if (coachUser?.profile_image) await removeS3File(coachUser.profile_image);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coach deleted successfully.",
            message_desc: "Coach deleted successfully.",
            data: { _id: record._id },
        });
    } catch (e) {
        return sendServerError(res, "Delete coach", e);
    }
};

module.exports = { createCoach, listCoaches, getCoach, updateCoach, deleteCoach };