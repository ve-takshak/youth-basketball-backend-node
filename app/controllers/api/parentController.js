const path = require("path");
const crypto = require("crypto");
const Club = require("../../models/Club");
const User = require("../../models/User");
const Parent = require("../../models/Parent");
const Player = require("../../models/Player");
const { SHIRT_SIZES, PARENT_RELATIONS, PLAYER_STATUSES, AGE_GROUPS } = require("../../models/Player");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { upload_files } = require("../../../utils/s3");
// Ye functions playerController (isi folder) mein pehle se hain, wahin se le rahe hain
const { removeIdDocument, populatePlayer, formatPlayer } = require("./Playercontroller");

// Parent (mobile app) ki APIs:
//   1. selectClub        -> parent ko club se jodna (ek parent ka ek hi club)
//   2. createYouthPlayer -> parent apna EK youth player (bachcha) add karta hai.
//      Player "pending" banta hai, team nahi hoti. ClubAdmin baad mein team assign karke "active" karega.
//      Bachcha hamesha parent wale club mein hi banta hai, isliye pehle selectClub zaroori hai.
//   3. listAgeGroups     -> form ke "Age Group" dropdown ke liye list
//   4. listMyYouthPlayers -> parent ke apne bachchon ki list
//   5. getMyYouthPlayer    -> apne ek bachche ki details
//   6. updateMyYouthPlayer -> apne bachche ki details edit
//   7. deleteMyYouthPlayer -> apna bachcha delete (sirf pending)

// ===========================================================================
// 1. Club select (parent ko club se jodna)
// ===========================================================================

const formatParentClub = (parent, club) => ({
    parentId: parent._id,
    club: {
        _id: club._id,
        clubCode: club.clubCode || "",
        name: club.name,
        theme: club.theme,
    },
    joinedAt: parent.createdAt,
});

/**
 * POST /api/user/parent/selectClub   (logged-in parent)
 * body: { clubId } ya { clubCode }
 * Parent ko club se jodta hai. Ek parent ka ek hi club.
 */
const selectParentClub = async (req, res) => {
    try {
        const user = req.user;

        if (user.role !== ROLES.PARENT) {
            return res.status(403).json({
                error: true,
                status: 403,
                message: "Only parents can select a club.",
                message_desc: "Only parents can select a club.",
                data: {},
            });
        }

        const clubId = String(req.body?.clubId || "").trim();
        const clubCode = String(req.body?.clubCode || "").trim().toUpperCase();

        // ---- 1. Club dhundo (id ya code se) ----
        let club = null;
        if (clubId) {
            if (!isValidId(clubId)) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Please select a valid club.",
                    message_desc: "Please select a valid club.",
                    data: {},
                });
            }
            club = await Club.findById(clubId).select("_id clubCode name theme");
        } else if (clubCode) {
            club = await Club.findOne({ clubCode }).select("_id clubCode name theme");
        } else {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Please select a club.",
                message_desc: "Please select a club.",
                data: {},
            });
        }

        if (!club) {
            const message = clubCode ? "Invalid club code." : "Club not found.";
            return res.status(404).json({
                error: true,
                status: 404,
                message,
                message_desc: message,
                data: {},
            });
        }

        // ---- 2. Pehle se kisi club se juda hai? ----
        const existing = await Parent.findOne({ userId: user._id });
        if (existing) {
            if (String(existing.clubId) === String(club._id)) {
                // Same club dobara: koi problem nahi, wahi wapas bhej do
                return res.status(200).json({
                    error: false,
                    status: 200,
                    message: "You are already linked to this club.",
                    message_desc: "You are already linked to this club.",
                    data: formatParentClub(existing, club),
                });
            }
            return res.status(409).json({
                error: true,
                status: 409,
                message: "You are already linked to another club. Please contact the club admin to change it.",
                message_desc: "You are already linked to another club. Please contact the club admin to change it.",
                data: {},
            });
        }

        // ---- 3. Link banao ----
        const parent = await Parent.create({
            userId: user._id,
            clubId: club._id,
            createdBy: user._id, // self-join
        });

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Club selected successfully.",
            message_desc: "Club selected successfully.",
            data: formatParentClub(parent, club),
        });
    } catch (e) {
        // Do request ek saath aayi (double tap) toh unique index rok dega
        if (e.code === 11000) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "Club is already being linked. Please refresh.",
                message_desc: "Club is already being linked. Please refresh.",
                data: {},
            });
        }
        console.error("Select parent club error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

// ===========================================================================
// 2. Youth player (bachcha) add karna
// ===========================================================================

const PHOTO_TYPES = ["image/png", "image/jpeg", "image/jpg"];
const DOC_TYPES = [...PHOTO_TYPES, "application/pdf"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

// req.files[key] check (express-fileupload)
const getFile = (req, key, allowedTypes, typeLabel, baseName, label) => {
    const file = req.files?.[key];
    if (!file) return { file: null };
    if (Array.isArray(file)) return { error: `Only one ${label} file is allowed.` };
    if (!allowedTypes.includes(file.mimetype)) return { error: `${label} must be ${typeLabel}.` };
    if (file.size > MAX_FILE_SIZE) return { error: `${label} must be 5MB or smaller.` };
    // Naam simple (Hebrew / special characters URL na todein)
    const ext = path.extname(file.name || "").toLowerCase() || (file.mimetype === "application/pdf" ? ".pdf" : ".jpg");
    file.name = `${baseName}${ext}`;
    return { file };
};

// Player registration number: REG + saal + 6 random (A-Z, 0-9), jaise REG2026HDFH54
// DB mein pehle se ho toh naya banao (unique index bhi hai)
const REG_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const generateRegistrationNumber = async () => {
    const year = new Date().getFullYear();
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const bytes = crypto.randomBytes(6);
        let suffix = "";
        for (let i = 0; i < 6; i += 1) suffix += REG_CHARS[bytes[i] % REG_CHARS.length];
        const code = `REG${year}${suffix}`;
        if (!(await Player.exists({ registrationNumber: code }))) return code;
    }
    throw new Error("Could not generate a unique registration number. Please try again.");
};

// Bachche ki fields check. Galti ho toh { message }
// partial = true (edit): sirf bheje gaye fields check aur return honge
const validateChild = (body, partial = false) => {
    body = body || {}; // sirf file bheji ho toh req.body undefined aata hai
    const v = {};
    const has = (key) => body[key] !== undefined;

    if (!partial || has("firstname")) {
        v.firstname = String(body.firstname || "").trim();
        if (!v.firstname) return { message: "Player first name is required." };
    }

    if (!partial || has("lastname")) {
        v.lastname = String(body.lastname || "").trim();
        if (!v.lastname) return { message: "Player last name is required." };
    }

    if (!partial || has("birthDate")) {
        const dob = new Date(body.birthDate);
        if (!body.birthDate || isNaN(dob.getTime())) return { message: "Valid date of birth is required." };
        if (dob > new Date()) return { message: "Date of birth cannot be in the future." };
        v.birthDate = dob;
    }

    // Age group zaroori (parent dropdown se chunta hai, wahi save hota hai)
    if (!partial || has("ageGroup")) {
        v.ageGroup = String(body.ageGroup || "").trim().toLowerCase();
        if (!v.ageGroup) return { message: "Age group is required." };
        if (!AGE_GROUPS.some((g) => g.code === v.ageGroup)) {
            return { message: `Age group must be one of: ${AGE_GROUPS.map((g) => g.code).join(", ")}.` };
        }
    }

    // Form mein gender nahi hai toh optional, admin baad mein bhar sakta hai
    if (!partial || has("gender")) {
        v.gender = String(body.gender || "").toLowerCase();
        if (v.gender && !["boys", "girls"].includes(v.gender)) return { message: "Gender must be boys or girls." };
    }

    // ID / Passport number (ek hi field). Passport mein letters bhi ho sakte hain
    if (!partial || has("idNumber")) {
        v.idNumber = String(body.idNumber || "").replace(/\s/g, "").toUpperCase();
        if (!v.idNumber) return { message: "ID / passport number is required." };
        if (!/^[A-Z0-9]{5,20}$/.test(v.idNumber)) {
            return { message: "ID / passport number must be 5 to 20 letters or digits." };
        }
    }

    if (!partial || has("shirtSize")) {
        v.shirtSize = String(body.shirtSize || "").toUpperCase();
        if (v.shirtSize && !SHIRT_SIZES.includes(v.shirtSize)) {
            return { message: `Shirt size must be one of: ${SHIRT_SIZES.join(", ")}.` };
        }
    }

    if (!partial || has("medicalNotes")) {
        v.medicalNotes = String(body.medicalNotes || "").trim();
        if (v.medicalNotes.length > 500) return { message: "Medical notes must be 500 characters or less." };
    }

    if (!partial || has("relation")) {
        v.relation = String(body.relation || "guardian").toLowerCase();
        if (!PARENT_RELATIONS.includes(v.relation)) {
            return { message: `Relation must be one of ${PARENT_RELATIONS.join(", ")}.` };
        }
    }

    return { values: v };
};

/**
 * POST /api/user/parent/players/create   (logged-in parent)
 * multipart/form-data (file ho toh) ya JSON:
 *   firstname, lastname, birthDate, idNumber, ageGroup (zaroori)
 *   gender?, shirtSize?, medicalNotes?, relation?     (optional)
 *   profile_image (file, optional) JPG / PNG, max 5MB      -> User.profile_image
 *   idDocument  (file, optional) JPG / PNG / PDF, max 5MB  -> Player.idDocument
 * Club parent ke club se aata hai, body se nahi. registrationNumber server khud banata hai.
 */
const createYouthPlayer = async (req, res) => {
    const uploaded = [];
    let childUser = null;
    try {
        if (req.user.role !== ROLES.PARENT) {
            return sendError(res, 403, "Only parents can add their children.");
        }

        // 1. Parent kisi club se juda hona chahiye (selectClub API)
        const parent = await Parent.findOne({ userId: req.user._id });
        if (!parent || !parent.clubId) return sendError(res, 400, "Please select your club first.");

        // 2. Parent ka club abhi bhi exist karta hai?
        const clubId = parent.clubId;
        if (!(await Club.exists({ _id: clubId }))) {
            return sendError(res, 400, "Your club is no longer available. Please contact the club admin.");
        }

        // 3. Fields check
        const checked = validateChild(req.body);
        if (checked.message) return sendError(res, 400, checked.message);
        const child = checked.values;

        // 4. Files check
        const photo = getFile(req, "profile_image", PHOTO_TYPES, "a JPG or PNG file", "photo", "Profile image");
        if (photo.error) return sendError(res, 400, photo.error);
        const doc = getFile(req, "idDocument", DOC_TYPES, "a JPG, PNG or PDF file", "id-document", "ID document");
        if (doc.error) return sendError(res, 400, doc.error);

        // 5. ID number pehle se registered?
        if (await User.exists({ idNumber: child.idNumber })) {
            return sendError(res, 409, "A player with this ID number is already registered. Please contact the club admin.");
        }

        // 6. Files S3 par (saari checking pass hone ke baad)
        let photoUrl = "";
        if (photo.file) {
            photoUrl = await upload_files("players", photo.file);
            if (!photoUrl) throw new Error("Player photo upload failed.");
            uploaded.push(photoUrl);
        }
        let docUrl = "";
        if (doc.file) {
            docUrl = await upload_files("players", doc.file);
            if (!docUrl) throw new Error("ID document upload failed.");
            uploaded.push(docUrl);
        }

        // 7. Bachche ka User (mobile nahi, isliye login nahi kar sakta, parent manage karega)
        childUser = await User.create({
            firstname: child.firstname,
            lastname: child.lastname,
            birthDate: child.birthDate,
            gender: child.gender,
            idNumber: child.idNumber,
            mobileNumber: "",
            profile_image: photoUrl,
            role: ROLES.YOUTH_PLAYER,
        });

        // 8. Player registration number (automatic)
        const registrationNumber = await generateRegistrationNumber();

        // 9. Player record (parent wala hi club, parent link ke saath)
        const player = await Player.create({
            registrationNumber,
            userId: childUser._id,
            clubId,
            teamId: null, // team clubAdmin dega
            season: "",
            playerType: "youth",
            shirtSize: child.shirtSize,
            shirtNumber: null,
            idDocument: docUrl,
            medicalNotes: child.medicalNotes,
            ageGroup: child.ageGroup,
            status: "pending",
            parents: [{ parentId: parent._id, relation: child.relation, isPrimary: true }],
            createdBy: req.user._id,
        });

        const saved = await populatePlayer(Player.findById(player._id));

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Player registered successfully. The club will review the registration.",
            message_desc: "Player registered successfully. The club will review the registration.",
            data: formatPlayer(saved),
        });
    } catch (e) {
        // Adhoora data na bache (User + S3 files)
        if (childUser) await User.findByIdAndDelete(childUser._id).catch(() => {});
        for (const fileUrl of uploaded) await removeIdDocument(fileUrl);

        // Duplicate key: kaunsi field duplicate hai wo batao (sirf ID maan kar mat chalo)
        if (e.code === 11000) {
            const field = Object.keys(e.keyPattern || e.keyValue || {}).join(", ") || "unknown";
            console.error("Parent create player duplicate key:", field, e.keyValue);
            const message = field === "idNumber"
                ? "A player with this ID number is already registered."
                : field === "registrationNumber"
                    ? "Registration number clash. Please try again."
                    : `Duplicate value for: ${field}.`;
            return res.status(409).json({
                error: true,
                status: 409,
                message,
                message_desc: `${e.message}`,
                data: { field, value: e.keyValue || {} },
            });
        }
        console.error("Parent create player error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

// ===========================================================================
// 3. Age groups ki list (form ke dropdown ke liye)
// ===========================================================================

/**
 * GET /api/user/parent/age-groups   (koi bhi logged-in user)
 * Saare age groups (form ke dropdown ke liye). List Player model se aati hai.
 */
const listAgeGroups = async (req, res) => {
    try {
        const ageGroups = AGE_GROUPS.map((group) => ({
            code: group.code,
            label: group.label,
            minAge: group.minAge,
            maxAge: group.maxAge,
        }));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Age groups fetched successfully.",
            message_desc: "Age groups fetched successfully.",
            data: { ageGroups },
        });
    } catch (e) {
        console.error("List age groups error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

// ===========================================================================
// 4. Parent ke apne youth players (bachchon) ki list
// ===========================================================================

/**
 * GET /api/user/parent/players?status=&ageGroup=   (logged-in parent)
 * Sirf wahi players jinke "parents" mein ye parent hai.
 * status (optional): pending | active | waitlisted | inactive | left
 * ageGroup (optional): mini | youth | junior
 */
const listMyYouthPlayers = async (req, res) => {
    try {
        if (req.user.role !== ROLES.PARENT) {
            return sendError(res, 403, "Only parents can view their players.");
        }

        // Parent abhi kisi club se nahi juda toh koi bachcha bhi nahi
        const parent = await Parent.findOne({ userId: req.user._id });
        if (!parent) {
            return res.status(200).json({
                error: false,
                status: 200,
                message: "Players fetched successfully.",
                message_desc: "Players fetched successfully.",
                data: { players: [], total: 0 },
            });
        }

        const filter = { "parents.parentId": parent._id };

        const status = String(req.query.status || "").trim().toLowerCase();
        if (status) {
            if (!PLAYER_STATUSES.includes(status)) {
                return sendError(res, 400, `Status must be one of: ${PLAYER_STATUSES.join(", ")}.`);
            }
            filter.status = status;
        }

        const ageGroup = String(req.query.ageGroup || "").trim().toLowerCase();
        if (ageGroup) {
            if (!AGE_GROUPS.some((g) => g.code === ageGroup)) {
                return sendError(res, 400, `Age group must be one of: ${AGE_GROUPS.map((g) => g.code).join(", ")}.`);
            }
            filter.ageGroup = ageGroup;
        }

        const players = await populatePlayer(Player.find(filter).sort({ createdAt: -1 }));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Players fetched successfully.",
            message_desc: "Players fetched successfully.",
            data: {
                players: players.map(formatPlayer),
                total: players.length,
            },
        });
    } catch (e) {
        console.error("List my youth players error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

// ===========================================================================
// 5-7. Parent ka apna youth player: details / edit / delete
// ===========================================================================

// Player id valid, aur ye player isi parent ka hai? Galti ho toh { status, message }
const findMyPlayer = async (req, id) => {
    if (req.user.role !== ROLES.PARENT) return { status: 403, message: "Only parents can manage their players." };
    if (!isValidId(id)) return { status: 400, message: "Invalid player id." };

    const parent = await Parent.findOne({ userId: req.user._id });
    if (!parent) return { status: 404, message: "Player not found." };

    // Sirf wahi player jiske "parents" mein ye parent hai (doosre ka bachcha 404)
    const player = await Player.findOne({ _id: id, "parents.parentId": parent._id });
    if (!player) return { status: 404, message: "Player not found." };

    return { parent, player };
};

/**
 * GET /api/user/parent/players/:id   (logged-in parent, :id = Player ki _id)
 * Apne ek bachche ki details.
 */
const getMyYouthPlayer = async (req, res) => {
    try {
        const found = await findMyPlayer(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);

        const saved = await populatePlayer(Player.findById(found.player._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player fetched successfully.",
            message_desc: "Player fetched successfully.",
            data: formatPlayer(saved),
        });
    } catch (e) {
        console.error("Get my youth player error:", e);
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
 * PUT /api/user/parent/players/:id/update   (logged-in parent, :id = Player ki _id)
 * multipart/form-data ya JSON. Jo badalna hai sirf wahi bhejo:
 *   firstname?, lastname?, birthDate?, idNumber?, ageGroup?, gender?, shirtSize?, medicalNotes?, relation?
 *   profile_image (file) = nayi photo.       removeProfileImage=true = photo hatana
 *   idDocument (file)  = naya ID document.   removeIdDocument=true  = document hatana
 * Parent team, shirt number, status, playerType, registrationNumber NAHI badal sakta (wo clubAdmin ka kaam).
 */
const updateMyYouthPlayer = async (req, res) => {
    const uploaded = [];
    try {
        // 1. Player isi parent ka hai?
        const found = await findMyPlayer(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { parent, player } = found;

        // 2. Bachche ka User
        const user = await User.findById(player.userId);
        if (!user) return sendError(res, 404, "Player user not found.");

        // 3. Fields check (sirf bheje gaye)
        const checked = validateChild(req.body, true);
        if (checked.message) return sendError(res, 400, checked.message);
        const child = checked.values;

        // 4. Files check
        const photo = getFile(req, "profile_image", PHOTO_TYPES, "a JPG or PNG file", "photo", "Profile image");
        if (photo.error) return sendError(res, 400, photo.error);
        const doc = getFile(req, "idDocument", DOC_TYPES, "a JPG, PNG or PDF file", "id-document", "ID document");
        if (doc.error) return sendError(res, 400, doc.error);

        // 5. ID number badla hai toh kisi aur ke paas toh nahi
        if (child.idNumber && child.idNumber !== user.idNumber) {
            if (await User.exists({ idNumber: child.idNumber, _id: { $ne: user._id } })) {
                return sendError(res, 409, "A player with this ID number is already registered. Please contact the club admin.");
            }
        }

        // 6. Nayi files upload (saari checking ke baad)
        const oldPhoto = user.profile_image || "";
        const oldDoc = player.idDocument || "";
        let photoChanged = false;
        let docChanged = false;

        if (photo.file) {
            const url = await upload_files("players", photo.file);
            if (!url) throw new Error("Player photo upload failed.");
            uploaded.push(url);
            user.profile_image = url;
            photoChanged = true;
        } else if (String(req.body?.removeProfileImage) === "true") {
            user.profile_image = "";
            photoChanged = true;
        }

        if (doc.file) {
            const url = await upload_files("players", doc.file);
            if (!url) throw new Error("ID document upload failed.");
            uploaded.push(url);
            player.idDocument = url;
            docChanged = true;
        } else if (String(req.body?.removeIdDocument) === "true") {
            player.idDocument = "";
            docChanged = true;
        }

        // 7. User update (naam, DOB, gender, ID)
        ["firstname", "lastname", "birthDate", "gender", "idNumber"].forEach((key) => {
            if (child[key] !== undefined) user[key] = child[key];
        });
        await user.save();

        // 8. Player update (age group, shirt size, medical notes)
        ["ageGroup", "shirtSize", "medicalNotes"].forEach((key) => {
            if (child[key] !== undefined) player[key] = child[key];
        });
        // Relation sirf is parent ke link mein badlega
        if (child.relation !== undefined) {
            const link = player.parents.find((l) => String(l.parentId) === String(parent._id));
            if (link) link.relation = child.relation;
        }
        await player.save();

        // 9. Purani files S3 se hatao (save hone ke baad)
        if (photoChanged && oldPhoto) await removeIdDocument(oldPhoto);
        if (docChanged && oldDoc) await removeIdDocument(oldDoc);

        const saved = await populatePlayer(Player.findById(player._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player updated successfully.",
            message_desc: "Player updated successfully.",
            data: formatPlayer(saved),
        });
    } catch (e) {
        // Nayi upload hui files hata do (DB mein purani hi rahengi)
        for (const fileUrl of uploaded) await removeIdDocument(fileUrl);

        if (e.code === 11000) {
            const field = Object.keys(e.keyPattern || e.keyValue || {}).join(", ") || "unknown";
            const message = field === "idNumber" ? "A player with this ID number is already registered." : `Duplicate value for: ${field}.`;
            return res.status(409).json({
                error: true,
                status: 409,
                message,
                message_desc: e.message,
                data: { field, value: e.keyValue || {} },
            });
        }
        console.error("Update my youth player error:", e);
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
 * DELETE /api/user/parent/players/:id/delete   (logged-in parent, :id = Player ki _id)
 * Sirf "pending" player delete ho sakta hai (club ne abhi approve nahi kiya).
 * Approve ho chuke player ke liye clubAdmin se baat karni hogi.
 * Player + bachche ka User + uski files (photo, ID document) hat jaati hain. Parent ka apna account rehta hai.
 */
const deleteMyYouthPlayer = async (req, res) => {
    try {
        const found = await findMyPlayer(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { player } = found;

        if (player.status !== "pending") {
            return sendError(
                res,
                400,
                "This player is already approved by the club. Please contact the club admin to remove the player."
            );
        }

        const user = await User.findById(player.userId).select("profile_image");

        await Player.findByIdAndDelete(player._id);
        await User.findByIdAndDelete(player.userId);

        // Files S3 se (fail ho toh bhi delete ho chuka, sirf warning)
        await removeIdDocument(player.idDocument);
        if (user?.profile_image) await removeIdDocument(user.profile_image);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player deleted successfully.",
            message_desc: "Player deleted successfully.",
            data: { _id: player._id },
        });
    } catch (e) {
        console.error("Delete my youth player error:", e);
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
    selectParentClub,
    createYouthPlayer,
    listAgeGroups,
    listMyYouthPlayers,
    getMyYouthPlayer,
    updateMyYouthPlayer,
    deleteMyYouthPlayer,
};