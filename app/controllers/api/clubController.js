const User = require("../../models/User");
const Club = require("../../models/Club");
const Coach = require("../../models/Coach");
const ClubAdmin = require("../../models/ClubAdmin");
const { ROLES } = require("../../helpers/constants");
const { isValidId, escapeRegex, getPagination } = require("../../helpers/common");
const { validatePersonInput, findDuplicateUser } = require("../../helpers/userHelper");

const isHexColor = (color) => /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color);

// theme object se sirf valid colors nikalna, galat ho toh error
const pickTheme = (theme = {}) => {
    const result = {};
    for (const key of ["primary", "secondary", "background"]) {
        if (theme[key] === undefined || theme[key] === "") continue;
        if (!isHexColor(theme[key])) return { error: `Invalid ${key} color. Use format like #1E40AF.` };
        result[key] = theme[key];
    }
    return { theme: result };
};

// Same naam ka club (capital/small ignore)
const findClubByName = (name, excludeId = null) =>
    Club.findOne({
        name: new RegExp(`^${escapeRegex(name)}$`, "i"),
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });

/**
 * POST /api/user/createClub   (sirf superAdmin)
 * Ek hi call mein 3 cheezein banti hain: Club + User (role: clubAdmin) + ClubAdmin record.
 * body: {
 *   name, logo?, theme?: { primary, secondary, background },
 *   clubAdmin: { firstname, lastname, countryCode, mobileNumber, email? }
 * }
 */
const createClub = async (req, res) => {
    // Beech mein fail ho toh jo bana hai use hatane ke liye
    let club = null;
    let user = null;

    try {
        let { name = "", logo = "", theme = {}, clubAdmin = {} } = req.body;
        name = String(name).trim();

        // ---- 1. Pehle saari checking, kuch bhi banne se pehle ----
        if (!name) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Club name is required.",
                message_desc: "Club name is required.",
                data: {},
            });
        }

        if (await findClubByName(name)) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "A club with this name already exists.",
                message_desc: "A club with this name already exists.",
                data: {},
            });
        }

        const picked = pickTheme(theme);
        if (picked.error) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: picked.error,
                message_desc: picked.error,
                data: {},
            });
        }

        const checked = validatePersonInput(clubAdmin || {});
        if (checked.message) {
            const message = `Club admin: ${checked.message}`;
            return res.status(checked.status).json({
                error: true,
                status: checked.status,
                message,
                message_desc: message,
                data: {},
            });
        }
        const admin = checked.values;

        const duplicate = await findDuplicateUser({
            countryCode: admin.countryCode,
            mobileNumber: admin.mobileNumber,
            email: admin.email,
        });
        if (duplicate) {
            const message = `Club admin: ${duplicate.message}`;
            return res.status(duplicate.status).json({
                error: true,
                status: duplicate.status,
                message,
                message_desc: message,
                data: {},
            });
        }

        // ---- 2. Club ----
        club = await Club.create({
            name,
            logo: String(logo).trim(),
            theme: picked.theme,
            createdBy: req.user._id,
        });

        // ---- 3. Club admin ka login account (role backend set karta hai) ----
        user = await User.create({
            firstname: admin.firstname,
            lastname: admin.lastname,
            email: admin.email || undefined,
            countryCode: admin.countryCode,
            mobileNumber: admin.mobileNumber,
            role: ROLES.CLUB_ADMIN,
        });

        // ---- 4. Club aur admin ko jodna ----
        const clubAdminRecord = await ClubAdmin.create({
            userId: user._id,
            clubId: club._id,
            createdBy: req.user._id,
        });

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Club and club admin created successfully.",
            message_desc: "Club and club admin created successfully.",
            data: {
                club,
                clubAdmin: {
                    _id: clubAdminRecord._id,
                    userId: user._id,
                    firstname: user.firstname,
                    lastname: user.lastname,
                    email: user.email || "",
                    countryCode: user.countryCode,
                    mobileNumber: user.mobileNumber,
                    role: user.role,
                },
            },
        });
    } catch (e) {
        // Adhoora data na bache: jo bana tha wo hata do
        if (user) await User.findByIdAndDelete(user._id).catch(() => {});
        if (club) await Club.findByIdAndDelete(club._id).catch(() => {});

        console.error("Create club error:", e);
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
 * GET /api/user/listClubs?search=&page=1&limit=10   (superAdmin ya clubAdmin)
 * superAdmin: saare clubs. clubAdmin: sirf apna club.
 */
const listClubs = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const { page, limit, skip } = getPagination(req.query);

        const filter = {};
        if (req.user.role === ROLES.CLUB_ADMIN) filter._id = req.clubId;
        if (search) filter.name = new RegExp(escapeRegex(search), "i");

        const [clubs, total] = await Promise.all([
            Club.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate("createdBy", "firstname lastname mobileNumber"),
            Club.countDocuments(filter),
        ]);

        // Har club ke saath uske club admins (naam + mobile) bhi bhejna, list table ke liye
        const admins = await ClubAdmin.find({ clubId: { $in: clubs.map((club) => club._id) } })
            .populate("userId", "firstname lastname countryCode mobileNumber")
            .sort({ createdAt: 1 });

        const clubsWithAdmins = clubs.map((club) => ({
            ...club.toObject(),
            clubAdmins: admins
                .filter((admin) => String(admin.clubId) === String(club._id))
                .map((admin) => ({
                    _id: admin._id,
                    firstname: admin.userId?.firstname || "",
                    lastname: admin.userId?.lastname || "",
                    countryCode: admin.userId?.countryCode || "",
                    mobileNumber: admin.userId?.mobileNumber || "",
                })),
        }));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Clubs fetched successfully.",
            message_desc: "Clubs fetched successfully.",
            data: {
                clubs: clubsWithAdmins,
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        console.error("List clubs error:", e);
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
 * GET /api/user/getClub/:id   (superAdmin ya clubAdmin)
 * Club + uske club admins aur coaches. clubAdmin sirf apna club dekh sakta hai.
 */
const getClub = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid club id.",
                message_desc: "Invalid club id.",
                data: {},
            });
        }

        if (req.user.role === ROLES.CLUB_ADMIN && String(req.clubId) !== String(id)) {
            return res.status(403).json({
                error: true,
                status: 403,
                message: "You can only view your own club.",
                message_desc: "You can only view your own club.",
                data: {},
            });
        }

        const club = await Club.findById(id).populate("createdBy", "firstname lastname mobileNumber");
        if (!club) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club not found.",
                message_desc: "Club not found.",
                data: {},
            });
        }

        const personFields = "firstname lastname email countryCode mobileNumber is_verify";
        const [clubAdmins, coaches] = await Promise.all([
            ClubAdmin.find({ clubId: id }).populate("userId", personFields).sort({ createdAt: -1 }),
            Coach.find({ clubId: id }).populate("userId", personFields).sort({ createdAt: -1 }),
        ]);

        const flatten = (record) => ({
            _id: record._id,
            userId: record.userId?._id || null,
            firstname: record.userId?.firstname || "",
            lastname: record.userId?.lastname || "",
            email: record.userId?.email || "",
            countryCode: record.userId?.countryCode || "",
            mobileNumber: record.userId?.mobileNumber || "",
            is_verify: record.userId?.is_verify || false,
            createdAt: record.createdAt,
        });

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Club fetched successfully.",
            message_desc: "Club fetched successfully.",
            data: {
                club,
                clubAdmins: clubAdmins.map(flatten),
                coaches: coaches.map(flatten),
            },
        });
    } catch (e) {
        console.error("Get club error:", e);
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
 * PUT /api/user/updateClub/:id   (sirf superAdmin)
 * body: jo badalna hai wahi { name?, logo?, theme? }
 */
const updateClub = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid club id.",
                message_desc: "Invalid club id.",
                data: {},
            });
        }

        const club = await Club.findById(id);
        if (!club) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club not found.",
                message_desc: "Club not found.",
                data: {},
            });
        }

        const { name, logo, theme } = req.body;

        if (name !== undefined) {
            const newName = String(name).trim();

            if (!newName) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Club name cannot be empty.",
                    message_desc: "Club name cannot be empty.",
                    data: {},
                });
            }

            if (await findClubByName(newName, id)) {
                return res.status(409).json({
                    error: true,
                    status: 409,
                    message: "A club with this name already exists.",
                    message_desc: "A club with this name already exists.",
                    data: {},
                });
            }

            club.name = newName;
        }

        if (logo !== undefined) club.logo = String(logo).trim();

        if (theme !== undefined) {
            const picked = pickTheme(theme);
            if (picked.error) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: picked.error,
                    message_desc: picked.error,
                    data: {},
                });
            }
            Object.assign(club.theme, picked.theme); // sirf bheje gaye colors badlenge
        }

        await club.save();

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Club updated successfully.",
            message_desc: "Club updated successfully.",
            data: club,
        });
    } catch (e) {
        console.error("Update club error:", e);
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
 * DELETE /api/user/deleteClub/:id   (sirf superAdmin)
 * Club ke coaches hain toh delete nahi hoga.
 * Club ke club admins (unke login account samet) club ke saath hi delete ho jayenge.
 */
const deleteClub = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid club id.",
                message_desc: "Invalid club id.",
                data: {},
            });
        }

        const club = await Club.findById(id);
        if (!club) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club not found.",
                message_desc: "Club not found.",
                data: {},
            });
        }

        const coachCount = await Coach.countDocuments({ clubId: id });
        if (coachCount > 0) {
            const message = `This club has ${coachCount} coach(es). Remove them first.`;
            return res.status(409).json({
                error: true,
                status: 409,
                message,
                message_desc: message,
                data: {},
            });
        }

        // Club admins + unke User accounts
        const clubAdmins = await ClubAdmin.find({ clubId: id });
        const adminUserIds = clubAdmins.map((record) => record.userId);
        await ClubAdmin.deleteMany({ clubId: id });
        if (adminUserIds.length > 0) await User.deleteMany({ _id: { $in: adminUserIds } });

        await Club.findByIdAndDelete(id);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Club deleted successfully.",
            message_desc: "Club deleted successfully.",
            data: { _id: club._id, deletedClubAdmins: clubAdmins.length },
        });
    } catch (e) {
        console.error("Delete club error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = { createClub, listClubs, getClub, updateClub, deleteClub };
