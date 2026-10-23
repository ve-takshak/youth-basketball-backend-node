const User = require("../../../models/User");
const Parent = require("../../../models/Parent");
const Player = require("../../../models/Player");
const { PARENT_RELATIONS } = require("../../../models/Player");
const { ROLES } = require("../../../helpers/constants");
const { isValidId, escapeRegex, getPagination } = require("../../../helpers/common");
const { validatePersonInput } = require("../../../helpers/userHelper");
const { populatePlayer, formatPlayer } = require("../Playercontroller");

// Admin panel (superAdmin / clubAdmin) ki parent APIs:
//   GET    /user/parents                                  -> parents ki list (bachchon ke saath)
//   PUT    /user/parents/:id/update                       -> parent ki details edit
//   DELETE /user/parents/:id/delete                       -> parent delete (sirf jab koi bachcha linked na ho)
//   POST   /user/players/:id/parents/link                 -> youth player se parent jodna
//   DELETE /user/players/:id/parents/:parentId/unlink     -> youth player se parent hatana
// clubAdmin sirf apne club ke parents / players. superAdmin sab.

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

const isAdmin = (req) => [ROLES.SUPER_ADMIN, ROLES.CLUB_ADMIN].includes(req.user.role);

// clubAdmin sirf apne club ka record chhu sakta hai. superAdmin sab.
const canAccess = (req, clubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(clubId?._id || clubId);

const PARENT_USER_FIELDS = "firstname lastname email countryCode mobileNumber is_verify profile_image";

// Parent + uske bachche ek flat object mein (frontend ke liye)
const formatParent = (parent, children = []) => {
    const user = parent.userId || {};
    return {
        _id: parent._id,
        userId: user._id || null,
        firstname: user.firstname || "",
        lastname: user.lastname || "",
        email: user.email || "",
        countryCode: user.mobileNumber ? user.countryCode : "",
        mobileNumber: user.mobileNumber || "",
        profile_image: user.profile_image || "",
        is_verify: user.is_verify || false,
        club: parent.clubId && parent.clubId._id ? { _id: parent.clubId._id, name: parent.clubId.name } : null,
        children,
        createdAt: parent.createdAt,
    };
};

// Parents ke bachche ek query mein: { parentId: [child, ...] }
const childrenByParent = async (parentIds) => {
    const map = {};
    if (!parentIds.length) return map;

    const players = await Player.find({ "parents.parentId": { $in: parentIds } })
        .select("parents userId teamId status playerType")
        .populate("userId", "firstname lastname profile_image")
        .populate("teamId", "name");

    players.forEach((player) => {
        (player.parents || []).forEach((link) => {
            const key = String(link.parentId);
            if (!parentIds.some((id) => String(id) === key)) return;
            if (!map[key]) map[key] = [];
            map[key].push({
                playerId: player._id,
                firstname: player.userId?.firstname || "",
                lastname: player.userId?.lastname || "",
                profile_image: player.userId?.profile_image || "",
                status: player.status,
                team: player.teamId && player.teamId._id ? { _id: player.teamId._id, name: player.teamId.name } : null,
                relation: link.relation,
                isPrimary: link.isPrimary,
            });
        });
    });
    return map;
};

/**
 * GET /api/user/parents?clubId=&search=&page=1&limit=20   (superAdmin ya clubAdmin)
 * search: parent ka naam, mobile ya email
 */
const listParents = async (req, res) => {
    try {
        if (!isAdmin(req)) return sendError(res, 403, "Only admins can view parents.");

        const search = String(req.query.search || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        const { page, limit, skip } = getPagination(req.query);

        const filter = {};
        if (req.user.role === ROLES.CLUB_ADMIN) {
            if (!req.clubId) return sendError(res, 403, "Your account is not linked to any club.");
            filter.clubId = req.clubId;
        } else if (clubId) {
            if (!isValidId(clubId)) return sendError(res, 400, "Invalid club id.");
            filter.clubId = clubId;
        }

        // Naam / mobile / email User mein hain
        if (search) {
            const rx = new RegExp(escapeRegex(search), "i");
            const users = await User.find({
                role: ROLES.PARENT,
                $or: [{ firstname: rx }, { lastname: rx }, { mobileNumber: rx }, { email: rx }],
            }).select("_id");
            filter.userId = { $in: users.map((u) => u._id) };
        }

        const [parents, total] = await Promise.all([
            Parent.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate("userId", PARENT_USER_FIELDS)
                .populate("clubId", "name"),
            Parent.countDocuments(filter),
        ]);

        const childMap = await childrenByParent(parents.map((p) => p._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Parents fetched successfully.",
            message_desc: "Parents fetched successfully.",
            data: {
                parents: parents.map((p) => formatParent(p, childMap[String(p._id)] || [])),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        return sendServerError(res, "List parents", e);
    }
};

// Parent id valid + access. Galti ho toh { status, message }
const findParentForAdmin = async (req, id) => {
    if (!isAdmin(req)) return { status: 403, message: "Only admins can manage parents." };
    if (!isValidId(id)) return { status: 400, message: "Invalid parent id." };
    const parent = await Parent.findById(id);
    if (!parent || !canAccess(req, parent.clubId)) return { status: 404, message: "Parent not found." };
    return { parent };
};

/**
 * PUT /api/user/parents/:id/update   (superAdmin ya clubAdmin, :id = Parent ki _id)
 * body: { firstname, lastname, countryCode, mobileNumber, email? }
 */
const updateParent = async (req, res) => {
    try {
        const found = await findParentForAdmin(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { parent } = found;

        const user = await User.findById(parent.userId);
        if (!user) return sendError(res, 404, "Parent user not found.");

        const checked = validatePersonInput(req.body || {});
        if (checked.message) return sendError(res, checked.status || 400, checked.message);
        const person = checked.values;

        // Mobile / email kisi aur ka toh nahi
        if (await User.exists({ countryCode: person.countryCode, mobileNumber: person.mobileNumber, _id: { $ne: user._id } })) {
            return sendError(res, 409, "This mobile number is already registered.");
        }
        if (person.email && (await User.exists({ email: person.email, _id: { $ne: user._id } }))) {
            return sendError(res, 409, "This email is already registered.");
        }

        user.firstname = person.firstname;
        user.lastname = person.lastname;
        user.countryCode = person.countryCode;
        user.mobileNumber = person.mobileNumber;
        user.email = person.email || undefined; // khaali email save nahi karna
        await user.save();

        const saved = await Parent.findById(parent._id).populate("userId", PARENT_USER_FIELDS).populate("clubId", "name");
        const childMap = await childrenByParent([saved._id]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Parent updated successfully.",
            message_desc: "Parent updated successfully.",
            data: formatParent(saved, childMap[String(saved._id)] || []),
        });
    } catch (e) {
        if (e.code === 11000) return sendError(res, 409, "This mobile number or email is already registered.");
        return sendServerError(res, "Update parent", e);
    }
};

/**
 * DELETE /api/user/parents/:id/delete   (superAdmin ya clubAdmin, :id = Parent ki _id)
 * Parent + uska User hatta hai. Koi bachcha abhi bhi linked hai toh delete NAHI hota
 * (pehle Players page se "unlink" karo), taaki koi youth player bina parent ke na bache.
 */
const deleteParent = async (req, res) => {
    try {
        const found = await findParentForAdmin(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { parent } = found;

        const linkedCount = await Player.countDocuments({ "parents.parentId": parent._id });
        if (linkedCount > 0) {
            return sendError(
                res,
                400,
                `This parent is linked to ${linkedCount} player(s). Unlink them from the players first.`
            );
        }

        await Parent.findByIdAndDelete(parent._id);
        await User.findByIdAndDelete(parent.userId);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Parent deleted successfully.",
            message_desc: "Parent deleted successfully.",
            data: { _id: parent._id },
        });
    } catch (e) {
        return sendServerError(res, "Delete parent", e);
    }
};

// Youth player id valid + access. Galti ho toh { status, message }
const findYouthPlayerForAdmin = async (req, id) => {
    if (!isAdmin(req)) return { status: 403, message: "Only admins can manage parents." };
    if (!isValidId(id)) return { status: 400, message: "Invalid player id." };
    const player = await Player.findById(id);
    if (!player || !canAccess(req, player.clubId)) return { status: 404, message: "Player not found." };
    if (player.playerType !== "youth") return { status: 400, message: "Only youth players have parents." };
    return { player };
};

/**
 * POST /api/user/players/:id/parents/link   (superAdmin ya clubAdmin, :id = Player ki _id)
 * body: { firstname, lastname, countryCode, mobileNumber, email?, relation?, isPrimary? }
 * Mobile se parent pehle se hai (isi club ka) toh wahi link hota hai, warna naya parent banta hai.
 */
const linkParentToPlayer = async (req, res) => {
    let createdUserId = null;
    let createdParentId = null;
    try {
        const found = await findYouthPlayerForAdmin(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { player } = found;

        const body = req.body || {};
        const checked = validatePersonInput(body);
        if (checked.message) return sendError(res, checked.status || 400, checked.message);
        const person = checked.values;

        const relation = String(body.relation || "guardian").toLowerCase();
        if (!PARENT_RELATIONS.includes(relation)) {
            return sendError(res, 400, `Relation must be one of ${PARENT_RELATIONS.join(", ")}.`);
        }

        // 1. Is mobile ka User
        let user = await User.findOne({ countryCode: person.countryCode, mobileNumber: person.mobileNumber });
        if (user && user.role !== ROLES.PARENT) {
            return sendError(res, 409, `This mobile number belongs to a ${user.role} account.`);
        }
        if (!user) {
            if (person.email && (await User.exists({ email: person.email }))) {
                return sendError(res, 409, "This email is already registered.");
            }
            user = await User.create({
                firstname: person.firstname,
                lastname: person.lastname,
                email: person.email || undefined,
                countryCode: person.countryCode,
                mobileNumber: person.mobileNumber,
                role: ROLES.PARENT,
            });
            createdUserId = user._id;
        }

        // 2. Parent record (ek parent ka ek hi club)
        let parent = await Parent.findOne({ userId: user._id });
        if (parent && String(parent.clubId) !== String(player.clubId)) {
            return sendError(res, 409, "This parent belongs to another club.");
        }
        if (!parent) {
            parent = await Parent.create({ userId: user._id, clubId: player.clubId, createdBy: req.user._id });
            createdParentId = parent._id;
        }

        // 3. Pehle se linked?
        if (player.parents.some((link) => String(link.parentId) === String(parent._id))) {
            return sendError(res, 409, "This parent is already linked to the player.");
        }

        // 4. Link. Pehla parent ya "primary" chuna toh primary (baaki ka primary hat jayega)
        const makePrimary = String(body.isPrimary) === "true" || body.isPrimary === true || player.parents.length === 0;
        if (makePrimary) player.parents.forEach((link) => (link.isPrimary = false));
        player.parents.push({ parentId: parent._id, relation, isPrimary: makePrimary });
        await player.save();

        const saved = await populatePlayer(Player.findById(player._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Parent linked successfully.",
            message_desc: "Parent linked successfully.",
            data: formatPlayer(saved),
        });
    } catch (e) {
        // Is request mein bane naye records hata do
        if (createdParentId) await Parent.findByIdAndDelete(createdParentId).catch(() => {});
        if (createdUserId) await User.findByIdAndDelete(createdUserId).catch(() => {});
        if (e.code === 11000) return sendError(res, 409, "This mobile number or email is already registered.");
        return sendServerError(res, "Link parent", e);
    }
};

/**
 * DELETE /api/user/players/:id/parents/:parentId/unlink   (superAdmin ya clubAdmin)
 * :id = Player ki _id, :parentId = Parent ki _id
 * Sirf link hatta hai, parent ka account rehta hai. Youth ka aakhri parent nahi hat sakta.
 */
const unlinkParentFromPlayer = async (req, res) => {
    try {
        const found = await findYouthPlayerForAdmin(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { player } = found;

        const parentId = String(req.params.parentId || "").trim();
        if (!isValidId(parentId)) return sendError(res, 400, "Invalid parent id.");

        const index = player.parents.findIndex((link) => String(link.parentId) === parentId);
        if (index === -1) return sendError(res, 404, "This parent is not linked to the player.");

        if (player.parents.length === 1) {
            return sendError(res, 400, "A youth player must have at least one parent. Link another parent first.");
        }

        const wasPrimary = player.parents[index].isPrimary;
        player.parents.splice(index, 1);
        if (wasPrimary && player.parents.length) player.parents[0].isPrimary = true;
        await player.save();

        const saved = await populatePlayer(Player.findById(player._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Parent unlinked successfully.",
            message_desc: "Parent unlinked successfully.",
            data: formatPlayer(saved),
        });
    } catch (e) {
        return sendServerError(res, "Unlink parent", e);
    }
};

module.exports = {
    listParents,
    updateParent,
    deleteParent,
    linkParentToPlayer,
    unlinkParentFromPlayer,
};