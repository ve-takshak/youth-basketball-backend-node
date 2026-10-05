const User = require("../../models/User");
const Club = require("../../models/Club");
const ClubAdmin = require("../../models/ClubAdmin");
const { ROLES } = require("../../helpers/constants");
const { isValidId, escapeRegex, getPagination } = require("../../helpers/common");
const { validatePersonInput, findDuplicateUser, applyPersonUpdates } = require("../../helpers/userHelper");

// ClubAdmin + uska User + Club ek flat object mein (frontend ke liye aasaan)
const formatClubAdmin = (record) => ({
    _id: record._id,
    userId: record.userId?._id || record.userId,
    firstname: record.userId?.firstname || "",
    lastname: record.userId?.lastname || "",
    email: record.userId?.email || "",
    countryCode: record.userId?.countryCode || "",
    mobileNumber: record.userId?.mobileNumber || "",
    is_verify: record.userId?.is_verify || false,
    club: record.clubId ? { _id: record.clubId._id, name: record.clubId.name } : null,
    createdAt: record.createdAt,
});

const populateClubAdmin = (query) =>
    query
        .populate("userId", "firstname lastname email countryCode mobileNumber is_verify")
        .populate("clubId", "name");

/**
 * POST /api/user/createClubAdmin   (sirf superAdmin)
 * body: { firstname, lastname, countryCode, mobileNumber, clubId, email? }
 * User (role: clubAdmin) + ClubAdmin record dono banata hai.
 */
const createClubAdmin = async (req, res) => {
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
        const { firstname, lastname, email, countryCode, mobileNumber } = checked.values;

        const clubId = String(req.body.clubId || "").trim();

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
            countryCode,
            mobileNumber,
            role: ROLES.CLUB_ADMIN,
        });

        // 2. ClubAdmin record jo club se juda hai
        const record = await ClubAdmin.create({
            userId: user._id,
            clubId: club._id,
            createdBy: req.user._id,
        });

        const saved = await populateClubAdmin(ClubAdmin.findById(record._id));

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Club admin created successfully.",
            message_desc: "Club admin created successfully.",
            data: formatClubAdmin(saved),
        });
    } catch (e) {
        // ClubAdmin record fail hua toh adhoora user bhi hata do
        if (user) await User.findByIdAndDelete(user._id).catch(() => {});
        console.error("Create club admin error:", e);
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
 * GET /api/user/listClubAdmins?clubId=&search=&page=1&limit=10   (sirf superAdmin)
 * search: naam ya mobile number se
 */
const listClubAdmins = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        const { page, limit, skip } = getPagination(req.query);

        const filter = {};

        if (clubId) {
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
                role: ROLES.CLUB_ADMIN,
                $or: [{ firstname: regex }, { lastname: regex }, { mobileNumber: regex }],
            }).select("_id");
            filter.userId = { $in: users.map((u) => u._id) };
        }

        const [records, total] = await Promise.all([
            populateClubAdmin(ClubAdmin.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
            ClubAdmin.countDocuments(filter),
        ]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Club admins fetched successfully.",
            message_desc: "Club admins fetched successfully.",
            data: {
                clubAdmins: records.map(formatClubAdmin),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        console.error("List club admins error:", e);
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
 * GET /api/user/getClubAdmin/:id   (sirf superAdmin, :id = ClubAdmin ki _id)
 */
const getClubAdmin = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid club admin id.",
                message_desc: "Invalid club admin id.",
                data: {},
            });
        }

        const record = await populateClubAdmin(ClubAdmin.findById(id));
        if (!record) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club admin not found.",
                message_desc: "Club admin not found.",
                data: {},
            });
        }

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Club admin fetched successfully.",
            message_desc: "Club admin fetched successfully.",
            data: formatClubAdmin(record),
        });
    } catch (e) {
        console.error("Get club admin error:", e);
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
 * PUT /api/user/updateClubAdmin/:id   (sirf superAdmin, :id = ClubAdmin ki _id)
 * body: jo badalna hai wahi { firstname?, lastname?, email?, countryCode?, mobileNumber?, clubId? }
 */
const updateClubAdmin = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid club admin id.",
                message_desc: "Invalid club admin id.",
                data: {},
            });
        }

        const record = await ClubAdmin.findById(id);
        if (!record) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club admin not found.",
                message_desc: "Club admin not found.",
                data: {},
            });
        }

        const user = await User.findById(record.userId);
        if (!user) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club admin user not found.",
                message_desc: "Club admin user not found.",
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
        if (clubId !== undefined) {
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

        const saved = await populateClubAdmin(ClubAdmin.findById(record._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Club admin updated successfully.",
            message_desc: "Club admin updated successfully.",
            data: formatClubAdmin(saved),
        });
    } catch (e) {
        console.error("Update club admin error:", e);
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
 * DELETE /api/user/deleteClubAdmin/:id   (sirf superAdmin, :id = ClubAdmin ki _id)
 * ClubAdmin record aur uska User dono hatata hai.
 */
const deleteClubAdmin = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid club admin id.",
                message_desc: "Invalid club admin id.",
                data: {},
            });
        }

        const record = await ClubAdmin.findById(id);
        if (!record) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club admin not found.",
                message_desc: "Club admin not found.",
                data: {},
            });
        }

        await ClubAdmin.findByIdAndDelete(record._id);
        await User.findByIdAndDelete(record.userId);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Club admin deleted successfully.",
            message_desc: "Club admin deleted successfully.",
            data: { _id: record._id },
        });
    } catch (e) {
        console.error("Delete club admin error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = { createClubAdmin, listClubAdmins, getClubAdmin, updateClubAdmin, deleteClubAdmin };
