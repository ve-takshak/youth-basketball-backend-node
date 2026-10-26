const fs = require("fs");
const path = require("path");
const validator = require("validator");
const User = require("../../models/User");
const Club = require("../../models/Club");
const Team = require("../../models/Team");
const Parent = require("../../models/Parent");
const Player = require("../../models/Player");
const ClubAdmin = require("../../models/ClubAdmin");
require("../../models/TeamCategory"); // getPlayer mein team.categoryId populate ke liye model register ho
const { SHIRT_SIZES, WEAR_SIZE_FIELDS, PLAYER_STATUSES, PLAYER_TYPES, PARENT_RELATIONS } = require("../../models/Player");
const { ROLES } = require("../../helpers/constants");
const { isValidId, cleanMobile, escapeRegex, getPagination } = require("../../helpers/common");
const { validatePersonInput } = require("../../helpers/userHelper");
const { upload_files, deleteFiles } = require("../../../utils/s3");

// Player do tarah ke (playerType):
//   senior -> User role "seniorPlayer": mobile zaroori (khud login), koi parent nahi
//   youth  -> User role "youthPlayer":  kam se kam ek parent zaroori, mobile optional
// Data do jagah:
//   User   -> firstname, lastname, birthDate, gender, idNumber, mobile, email
//   Player -> club, team, season, playerType, sizes (game/training/winter), shirtNumber,
//             idDocument, medicalNotes, parents (youth), status

const roleForType = (playerType) => (playerType === "senior" ? ROLES.SENIOR_PLAYER : ROLES.YOUTH_PLAYER);

// Jin statuses wale players team mein jagah lete hain (shirt number + capacity)
const ROSTER_STATUSES = ["active", "waitlisted"];

// Error messages ke liye sizes ke naam
const WEAR_SIZE_LABELS = {
    gameWearSize: "Game-wear size",
    trainingWearSize: "Training-wear size",
    winterWearSize: "Winter-wear size",
};

// ---------------------------------------------------------------------------
// Photo / ID / passport attachment (club logo jaisa, S3 par)
// ---------------------------------------------------------------------------
const ALLOWED_DOC_TYPES = ["image/png", "image/jpeg", "image/jpg", "application/pdf"];
const MAX_DOC_SIZE = 5 * 1024 * 1024; // 5MB

// Hamare bucket ka base URL, taaki sirf apni S3 files hi delete hon
const getS3BaseUrl = () =>
    `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/`;

// req.files.idDocument check karna (express-fileupload)
const getIdDocumentFile = (req) => {
    const file = req.files?.idDocument;
    if (!file) return { file: null };
    if (Array.isArray(file)) return { error: "Only one ID document file is allowed." };
    if (!ALLOWED_DOC_TYPES.includes(file.mimetype)) {
        return { error: "ID document must be a JPG, PNG or PDF file." };
    }
    if (file.size > MAX_DOC_SIZE) return { error: "ID document must be 5MB or smaller." };
    // File ka naam simple kar do (Hebrew / special characters URL na todein)
    const ext = path.extname(file.name || "").toLowerCase() || (file.mimetype === "application/pdf" ? ".pdf" : ".jpg");
    file.name = `id-document${ext}`;
    return { file };
};

// Purani file hatana: S3 wali ho toh S3 se, local upload ho toh disk se
const removeIdDocument = async (fileUrl) => {
    if (!fileUrl) return;
    try {
        const baseUrl = getS3BaseUrl();
        if (fileUrl.startsWith(baseUrl)) {
            const key = fileUrl.replace(baseUrl, "");
            const slash = key.lastIndexOf("/");
            const result = await deleteFiles(key.slice(0, slash), key.slice(slash + 1));
            if (result !== 1) console.warn("Failed to delete player ID document from S3:", result);
        } else if (!fileUrl.startsWith("http")) {
            const filePath = path.resolve(__dirname, "../../../", fileUrl);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.warn("Failed to delete player ID document:", err.message);
    }
};

const fileUrlOf = (value) => {
    if (!value) return "";
    if (value.startsWith("http")) return value;
    const appUrl = process.env.APP_URL || "http://localhost:5000";
    return `${appUrl}/${value.replace(/\\/g, "/")}`;
};

// multipart/form-data mein parents JSON string bankar aate hain
const parseParents = (raw) => {
    if (raw === undefined) return undefined;
    if (typeof raw === "string") {
        if (!raw.trim()) return [];
        try {
            return JSON.parse(raw);
        } catch (e) {
            return null; // galat JSON
        }
    }
    return raw;
};

// ---------------------------------------------------------------------------
// Helpers (galti ho toh { status, message } return karte hain)
// ---------------------------------------------------------------------------

// clubAdmin sirf apne club ke player ko chhu sakta hai. SuperAdmin sab ko.
const canAccess = (req, playerClubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(playerClubId?._id || playerClubId);

const toDateString = (date) => (date ? new Date(date).toISOString().split("T")[0] : null);

const ageFrom = (birthDate) => {
    if (!birthDate) return null;
    const dob = new Date(birthDate);
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) age -= 1;
    return age;
};

/**
 * User wali fields (naam, DOB, gender, ID, mobile, email).
 * partial = update: sirf bheje gaye fields check honge.
 */
const validatePersonFields = (body, partial = false, playerType = "youth") => {
    const values = {};
    const has = (key) => body[key] !== undefined;

    if (!partial || has("firstname")) {
        values.firstname = String(body.firstname || "").trim();
        if (!values.firstname) return { status: 400, message: "Player first name is required." };
    }
    if (!partial || has("lastname")) {
        values.lastname = String(body.lastname || "").trim();
        if (!values.lastname) return { status: 400, message: "Player last name is required." };
    }
    if (!partial || has("birthDate")) {
        const dob = new Date(body.birthDate);
        if (!body.birthDate || isNaN(dob.getTime())) return { status: 400, message: "Valid date of birth is required." };
        if (dob > new Date()) return { status: 400, message: "Date of birth cannot be in the future." };
        values.birthDate = dob;
    }
    if (!partial || has("gender")) {
        values.gender = String(body.gender || "").toLowerCase();
        if (!["boys", "girls"].includes(values.gender)) return { status: 400, message: "Gender must be boys or girls." };
    }
    if (has("idNumber")) {
        values.idNumber = String(body.idNumber || "").replace(/\s/g, "");
        if (values.idNumber && !/^\d{5,9}$/.test(values.idNumber)) {
            return { status: 400, message: "ID number must be 5 to 9 digits." };
        }
    }
    if (has("email")) {
        values.email = String(body.email || "").trim().toLowerCase();
        if (values.email && !validator.isEmail(values.email)) return { status: 400, message: "Please enter a valid email." };
    }
    // Senior: mobile zaroori (khud login karta hai). Youth: optional, diya ho toh sahi ho.
    const mobileRequired = playerType === "senior";
    if ((mobileRequired && !partial) || has("mobileNumber") || has("countryCode")) {
        values.countryCode = String(body.countryCode || "+972").trim();
        values.mobileNumber = cleanMobile(body.mobileNumber);
        if (mobileRequired && !values.mobileNumber) {
            return { status: 400, message: "Mobile number is required for a senior player." };
        }
        if (values.mobileNumber && values.mobileNumber.length < 7) {
            return { status: 400, message: "Valid mobile number is required." };
        }
    }

    return { values };
};

// Player wali fields (khel se judi). partial = update.
const validatePlayerFields = (body) => {
    const values = {};
    const has = (key) => body[key] !== undefined;

    if (has("playerType")) {
        values.playerType = String(body.playerType).toLowerCase();
        if (!PLAYER_TYPES.includes(values.playerType)) return { status: 400, message: "Player type must be youth or senior." };
    }
    // Teen size (game / training / winter), teeno optional, same SHIRT_SIZES list
    for (const field of WEAR_SIZE_FIELDS) {
        if (has(field)) {
            values[field] = String(body[field] ?? "").trim().toUpperCase();
            if (values[field] && !SHIRT_SIZES.includes(values[field])) {
                return { status: 400, message: `${WEAR_SIZE_LABELS[field]} must be one of: ${SHIRT_SIZES.join(", ")}.` };
            }
        }
    }
    if (has("shirtNumber")) {
        if (body.shirtNumber === null || body.shirtNumber === "") {
            values.shirtNumber = null;
        } else {
            const num = Number(body.shirtNumber);
            if (!Number.isInteger(num) || num < 0) return { status: 400, message: "Shirt number must be a whole number (0 or more)." };
            values.shirtNumber = num;
        }
    }
    if (has("status")) {
        values.status = String(body.status).toLowerCase();
        if (!PLAYER_STATUSES.includes(values.status)) {
            return { status: 400, message: `Status must be one of: ${PLAYER_STATUSES.join(", ")}.` };
        }
    }
    if (has("season")) values.season = String(body.season || "").trim();
    if (has("medicalNotes")) {
        values.medicalNotes = String(body.medicalNotes ?? "").trim();
        if (values.medicalNotes.length > 500) return { status: 400, message: "Medical notes must be 500 characters or less." };
    }

    return { values };
};

// Mobile / email / ID kisi aur User ke paas toh nahi
const findDuplicate = async ({ countryCode, mobileNumber, email, idNumber, excludeUserId = null }) => {
    const notMe = excludeUserId ? { _id: { $ne: excludeUserId } } : {};
    if (mobileNumber && (await User.exists({ countryCode, mobileNumber, ...notMe }))) {
        return { status: 409, message: "This mobile number is already registered." };
    }
    if (email && (await User.exists({ email, ...notMe }))) {
        return { status: 409, message: "This email is already registered." };
    }
    if (idNumber && (await User.exists({ idNumber, ...notMe }))) {
        return { status: 409, message: "A player with this ID number already exists." };
    }
    return null;
};

// Team check: sahi id, usi club ki. teamId khaali = koi team nahi (waitlist)
const resolveTeam = async (teamId, clubId) => {
    if (teamId === undefined || teamId === null || String(teamId).trim() === "") return { team: null };
    if (!isValidId(teamId)) return { status: 400, message: "Invalid team id." };
    const team = await Team.findById(teamId);
    if (!team) return { status: 404, message: "Team not found." };
    if (String(team.clubId) !== String(clubId)) return { status: 400, message: "Selected team does not belong to this club." };
    return { team };
};

// Team mein shirt number duplicate + capacity check
const checkTeamRules = async ({ team, shirtNumber, status, excludePlayerId = null }) => {
    if (!team) return null;
    const notMe = excludePlayerId ? { _id: { $ne: excludePlayerId } } : {};

    if (shirtNumber !== null && shirtNumber !== undefined && ROSTER_STATUSES.includes(status)) {
        const taken = await Player.findOne({
            teamId: team._id,
            shirtNumber,
            status: { $in: ROSTER_STATUSES },
            ...notMe,
        }).populate("userId", "firstname lastname");
        if (taken) {
            const name = `${taken.userId?.firstname || ""} ${taken.userId?.lastname || ""}`.trim() || "another player";
            return { status: 409, message: `Shirt number ${shirtNumber} is already taken by ${name} in this team.` };
        }
    }

    if (status === "active" && team.teamCapacity) {
        const activeCount = await Player.countDocuments({ teamId: team._id, status: "active", ...notMe });
        if (activeCount >= team.teamCapacity) {
            return { status: 409, message: `Team is full (${team.teamCapacity} active players). Add the player as waitlisted or increase capacity.` };
        }
    }

    return null;
};

/**
 * Body ke parents ko Parent records mein badalna.
 * Har parent: { firstname, lastname, countryCode, mobileNumber, email?, relation?, isPrimary? }
 * Mobile se User pehle se hai toh wahi (agar wo parent hai), warna naya User (role: parent) + Parent.
 * created: is call mein jo naye bane (fail hone pe hatane ke liye)
 */
const resolveParents = async (rawParents, clubId, createdBy, created) => {
    if (!Array.isArray(rawParents)) return { status: 400, message: "Parents must be a list." };

    const links = [];
    const seenMobiles = new Set();

    for (let i = 0; i < rawParents.length; i += 1) {
        const raw = rawParents[i] || {};
        const label = `Parent ${i + 1}`;

        const checked = validatePersonInput(raw);
        if (checked.message) return { status: checked.status, message: `${label}: ${checked.message}` };
        const person = checked.values;

        const mobileKey = `${person.countryCode}${person.mobileNumber}`;
        if (seenMobiles.has(mobileKey)) return { status: 400, message: `${label}: same mobile number added twice.` };
        seenMobiles.add(mobileKey);

        const relation = String(raw.relation || "guardian").toLowerCase();
        if (!PARENT_RELATIONS.includes(relation)) {
            return { status: 400, message: `${label}: relation must be one of ${PARENT_RELATIONS.join(", ")}.` };
        }

        let user = await User.findOne({ countryCode: person.countryCode, mobileNumber: person.mobileNumber });

        if (user && user.role !== ROLES.PARENT) {
            return { status: 409, message: `${label}: this mobile number belongs to a ${user.role} account.` };
        }

        if (!user) {
            if (person.email && (await User.exists({ email: person.email }))) {
                return { status: 409, message: `${label}: this email is already registered.` };
            }
            user = await User.create({
                firstname: person.firstname,
                lastname: person.lastname,
                email: person.email || undefined,
                countryCode: person.countryCode,
                mobileNumber: person.mobileNumber,
                role: ROLES.PARENT,
            });
            created.users.push(user._id);
        }

        let parent = await Parent.findOne({ userId: user._id });
        if (!parent) {
            parent = await Parent.create({ userId: user._id, clubId, createdBy });
            created.parents.push(parent._id);
        }

        links.push({ parentId: parent._id, relation, isPrimary: Boolean(raw.isPrimary) });
    }

    // Ek hi primary parent. Koi nahi chuna toh pehla primary.
    if (links.length > 0) {
        const firstPrimary = links.findIndex((link) => link.isPrimary);
        links.forEach((link, index) => {
            link.isPrimary = index === (firstPrimary === -1 ? 0 : firstPrimary);
        });
    }

    return { links };
};

// Fail hone pe is request mein bane naye Parent/User hata dena
const rollbackCreated = async (created) => {
    if (created.parents.length) await Parent.deleteMany({ _id: { $in: created.parents } }).catch(() => { });
    if (created.users.length) await User.deleteMany({ _id: { $in: created.users } }).catch(() => { });
};

// Jin parents ka ab koi bachcha nahi bacha, unka Parent + User hata dena
const cleanupOrphanParents = async (parentIds) => {
    for (const parentId of parentIds) {
        const stillUsed = await Player.exists({ "parents.parentId": parentId });
        if (stillUsed) continue;
        const parent = await Parent.findByIdAndDelete(parentId);
        if (parent) await User.findByIdAndDelete(parent.userId);
    }
};

// List / create / update ke liye (halka populate)
const populatePlayer = (query) =>
    query
        .populate("userId", "firstname lastname birthDate gender idNumber email countryCode mobileNumber is_verify profile_image")
        .populate("clubId", "name")
        // Team ke saath uska coach (Coach -> User) bhi
        .populate({
            path: "teamId",
            select: "name season coachId",
            populate: {
                path: "coachId",
                select: "userId",
                populate: { path: "userId", select: "firstname lastname email countryCode mobileNumber profile_image" },
            },
        })
        .populate({
            path: "parents.parentId",
            select: "userId",
            populate: { path: "userId", select: "firstname lastname email countryCode mobileNumber is_verify profile_image" },
        });

// User + Player ek flat object mein (frontend ke liye aasaan)
const formatPlayer = (player) => {
    const user = player.userId || {};
    return {
        _id: player._id,
        userId: user._id || null,
        firstname: user.firstname || "",
        lastname: user.lastname || "",
        profile_image: user.profile_image || "",
        birthDate: toDateString(user.birthDate),
        age: ageFrom(user.birthDate),
        gender: user.gender || "",
        idNumber: user.idNumber || "",
        email: user.email || "",
        countryCode: user.mobileNumber ? user.countryCode : "",
        mobileNumber: user.mobileNumber || "",
        is_verify: user.is_verify || false,
        playerType: player.playerType,
        shirtNumber: player.shirtNumber ?? null,
        gameWearSize: player.gameWearSize || "",
        trainingWearSize: player.trainingWearSize || "",
        winterWearSize: player.winterWearSize || "",
        medicalNotes: player.medicalNotes || "",
        idDocument: fileUrlOf(player.idDocument),
        status: player.status,
        registrationNumber: player.registrationNumber || "",
        season: player.season || "",
        club: player.clubId && player.clubId._id ? { _id: player.clubId._id, name: player.clubId.name } : null,
        team: player.teamId && player.teamId._id ? { _id: player.teamId._id, name: player.teamId.name } : null,
        // Team ka coach (team nahi ya coach assign nahi toh null)
        coach:
            player.teamId && player.teamId.coachId && player.teamId.coachId._id
                ? {
                    _id: player.teamId.coachId._id,
                    userId: player.teamId.coachId.userId?._id || null,
                    firstname: player.teamId.coachId.userId?.firstname || "",
                    lastname: player.teamId.coachId.userId?.lastname || "",
                    profile_image: player.teamId.coachId.userId?.profile_image || "",
                    email: player.teamId.coachId.userId?.email || "",
                    countryCode: player.teamId.coachId.userId?.countryCode || "",
                    mobileNumber: player.teamId.coachId.userId?.mobileNumber || "",
                }
                : null,
        parents: (player.parents || [])
            .filter((link) => link.parentId)
            .map((link) => ({
                parentId: link.parentId._id || link.parentId,
                userId: link.parentId.userId?._id || null,
                firstname: link.parentId.userId?.firstname || "",
                lastname: link.parentId.userId?.lastname || "",
                profile_image: link.parentId.userId?.profile_image || "",
                email: link.parentId.userId?.email || "",
                countryCode: link.parentId.userId?.countryCode || "",
                mobileNumber: link.parentId.userId?.mobileNumber || "",
                is_verify: link.parentId.userId?.is_verify || false,
                relation: link.relation,
                isPrimary: link.isPrimary,
            })),
        createdAt: player.createdAt,
        updatedAt: player.updatedAt,
    };
};

// Sirf detail page (getPlayer) ke liye: club, team, coach ki poori details
const populatePlayerDetail = (query) =>
    query
        .populate("userId", "firstname lastname birthDate gender idNumber email countryCode mobileNumber is_verify profile_image")
        .populate("clubId", "name logo theme")
        .populate({
            path: "teamId",
            select: "name season gender teamType teamCapacity status categoryId coachId",
            populate: [
                { path: "categoryId", select: "name" },
                {
                    path: "coachId",
                    select: "userId",
                    populate: { path: "userId", select: "firstname lastname email countryCode mobileNumber profile_image" },
                },
            ],
        })
        .populate({
            path: "parents.parentId",
            select: "userId",
            populate: { path: "userId", select: "firstname lastname email countryCode mobileNumber is_verify profile_image" },
        });

// formatPlayer + club (logo, theme, primary admin) + team (category, capacity, player count)
const formatPlayerDetail = async (player) => {
    const base = formatPlayer(player);
    const club = player.clubId && player.clubId._id ? player.clubId : null;
    const team = player.teamId && player.teamId._id ? player.teamId : null;

    // Club ka primary admin (sabse pehla bana hua)
    let clubAdmin = null;
    if (club) {
        const admin = await ClubAdmin.findOne({ clubId: club._id })
            .sort({ createdAt: 1 })
            .populate("userId", "firstname lastname email countryCode mobileNumber profile_image");
        if (admin?.userId) {
            clubAdmin = {
                _id: admin._id,
                userId: admin.userId._id,
                firstname: admin.userId.firstname || "",
                lastname: admin.userId.lastname || "",
                profile_image: admin.userId.profile_image || "",
                email: admin.userId.email || "",
                countryCode: admin.userId.countryCode || "",
                mobileNumber: admin.userId.mobileNumber || "",
            };
        }
    }

    // Team mein kitne players (active + total)
    let activePlayers = 0;
    let totalPlayers = 0;
    if (team) {
        [activePlayers, totalPlayers] = await Promise.all([
            Player.countDocuments({ teamId: team._id, status: "active" }),
            Player.countDocuments({ teamId: team._id }),
        ]);
    }

    return {
        ...base,
        club: club
            ? {
                _id: club._id,
                name: club.name,
                logoUrl: fileUrlOf(club.logo),
                theme: club.theme || {},
                admin: clubAdmin,
            }
            : null,
        team: team
            ? {
                _id: team._id,
                name: team.name,
                season: team.season || "",
                gender: team.gender || "mixed",
                teamType: team.teamType || "league",
                teamCapacity: team.teamCapacity ?? 20,
                status: team.status || "active",
                category:
                    team.categoryId && team.categoryId._id
                        ? { _id: team.categoryId._id, name: team.categoryId.name }
                        : null,
                activePlayers,
                totalPlayers,
            }
            : null,
    };
};

// Saare error responses ek jaise
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
// APIs
// ---------------------------------------------------------------------------

/**
 * POST /api/user/players/create   (superAdmin ya clubAdmin)
 * JSON ya multipart/form-data (file ke saath). Multipart mein parents JSON string mein bhejo.
 * idDocument (file, optional): JPG / PNG / PDF, max 5MB
 * body: {
 *   playerType: "youth" (default) | "senior"
 *   firstname, lastname, birthDate, gender, idNumber?, email?, countryCode?, mobileNumber?,   -> User
 *     (senior ke liye mobileNumber zaroori)
 *   clubId (sirf superAdmin), teamId?, season?, shirtNumber?, status?, medicalNotes?,         -> Player
 *   gameWearSize?, trainingWearSize?, winterWearSize?                                         -> Player
 *   parents (sirf youth, zaroori): [{ firstname, lastname, countryCode, mobileNumber, email?, relation?, isPrimary? }]
 * }
 */
const createPlayer = async (req, res) => {
    const created = { users: [], parents: [] };
    let playerUser = null;
    let uploadedDoc = "";
    try {
        const body = req.body || {};

        // multipart/form-data mein parents JSON string aata hai
        const parsedParents = parseParents(body.parents);
        if (parsedParents === null) return sendError(res, 400, "Parents must be valid JSON.");

        const docCheck = getIdDocumentFile(req);
        if (docCheck.error) return sendError(res, 400, docCheck.error);

        // playerType pehle, kyunki senior ke liye mobile zaroori hai aur parent nahi
        const playerType = String(body.playerType || "youth").toLowerCase();
        if (!PLAYER_TYPES.includes(playerType)) return sendError(res, 400, "Player type must be youth or senior.");

        const personCheck = validatePersonFields(body, false, playerType);
        if (personCheck.message) return sendError(res, personCheck.status, personCheck.message);
        const person = personCheck.values;

        const playerCheck = validatePlayerFields(body);
        if (playerCheck.message) return sendError(res, playerCheck.status, playerCheck.message);
        const values = playerCheck.values;
        values.status = values.status || "active";
        values.playerType = playerType;

        // clubAdmin apne club mein, superAdmin body se club chunega
        const clubId = req.user.role === ROLES.CLUB_ADMIN ? String(req.clubId) : String(body.clubId || "").trim();
        if (!isValidId(clubId) || !(await Club.exists({ _id: clubId }))) {
            return sendError(res, 400, "Please select a valid club.");
        }

        const teamResult = await resolveTeam(body.teamId, clubId);
        if (teamResult.message) return sendError(res, teamResult.status, teamResult.message);

        const ruleError = await checkTeamRules({
            team: teamResult.team,
            shirtNumber: values.shirtNumber,
            status: values.status,
        });
        if (ruleError) return sendError(res, ruleError.status, ruleError.message);

        const duplicate = await findDuplicate(person);
        if (duplicate) return sendError(res, duplicate.status, duplicate.message);

        // Senior: parent nahi. Youth: kam se kam ek parent zaroori
        const rawParents = parsedParents || [];
        if (playerType === "senior" && Array.isArray(rawParents) && rawParents.length > 0) {
            return sendError(res, 400, "A senior player cannot have parents.");
        }
        if (playerType === "youth" && (!Array.isArray(rawParents) || rawParents.length === 0)) {
            return sendError(res, 400, "At least one parent or guardian is required for a youth player.");
        }

        const parentResult = await resolveParents(rawParents, clubId, req.user._id, created);
        if (parentResult.message) {
            await rollbackCreated(created);
            return sendError(res, parentResult.status, parentResult.message);
        }

        // ID document S3 par (saari checking pass hone ke baad hi)
        if (docCheck.file) {
            uploadedDoc = await upload_files("players", docCheck.file);
            if (!uploadedDoc) {
                await rollbackCreated(created);
                return sendError(res, 500, "ID document upload failed. Please try again.");
            }
        }

        // 1. Player ka User (senior: seniorPlayer, youth: youthPlayer)
        playerUser = await User.create({
            firstname: person.firstname,
            lastname: person.lastname,
            birthDate: person.birthDate,
            gender: person.gender,
            idNumber: person.idNumber || "",
            email: person.email || undefined,
            countryCode: person.countryCode || "+972",
            mobileNumber: person.mobileNumber || "",
            role: roleForType(playerType),
        });

        // 2. Player record (khel ki details: sizes, number, status, medical notes...)
        const player = await Player.create({
            ...values,
            userId: playerUser._id,
            clubId,
            teamId: teamResult.team ? teamResult.team._id : null,
            season: values.season ?? (teamResult.team ? teamResult.team.season : ""),
            parents: parentResult.links,
            idDocument: uploadedDoc,
            createdBy: req.user._id,
        });

        const saved = await populatePlayer(Player.findById(player._id));

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Player created successfully.",
            message_desc: "Player created successfully.",
            data: formatPlayer(saved),
        });
    } catch (e) {
        // Adhoora data na bache (S3 file bhi)
        if (playerUser) await User.findByIdAndDelete(playerUser._id).catch(() => { });
        await rollbackCreated(created);
        if (uploadedDoc) await removeIdDocument(uploadedDoc);
        return sendServerError(res, "Create player", e);
    }
};

// List APIs ka common filter (club + status + type + naam/ID/gender search)
// Galti ho toh { status, message }, warna { filter }
const buildPlayerFilter = async (req, baseFilter = {}) => {
    const search = String(req.query.search || "").trim();
    const clubId = String(req.query.clubId || "").trim();
    const status = String(req.query.status || "").trim().toLowerCase();
    const gender = String(req.query.gender || "").trim().toLowerCase();
    const playerType = String(req.query.playerType || "").trim().toLowerCase();

    const filter = { ...baseFilter };

    if (req.user.role === ROLES.CLUB_ADMIN) {
        if (!req.clubId) return { status: 403, message: "Your account is not linked to any club." };
        filter.clubId = req.clubId;
    } else if (clubId) {
        if (!isValidId(clubId)) return { status: 400, message: "Invalid club id." };
        filter.clubId = clubId;
    }

    if (status && PLAYER_STATUSES.includes(status)) filter.status = status;
    if (playerType && PLAYER_TYPES.includes(playerType)) filter.playerType = playerType;

    // Naam / ID / gender User mein hain, isliye pehle matching player users
    if (search || ["boys", "girls"].includes(gender)) {
        const userFilter = { role: { $in: [ROLES.SENIOR_PLAYER, ROLES.YOUTH_PLAYER] } };
        if (["boys", "girls"].includes(gender)) userFilter.gender = gender;
        if (search) {
            const rx = new RegExp(escapeRegex(search), "i");
            userFilter.$or = [{ firstname: rx }, { lastname: rx }, { idNumber: rx }];
        }
        const users = await User.find(userFilter).select("_id");
        filter.userId = { $in: users.map((u) => u._id) };
    }

    return { filter };
};

/**
 * GET /api/user/players?clubId=&teamId=&status=&gender=&playerType=&search=&page=1&limit=10   (superAdmin ya clubAdmin)
 * search: naam ya ID number.  teamId=none: jin players ki koi team nahi
 */
const listPlayers = async (req, res) => {
    try {
        const teamId = String(req.query.teamId || "").trim();
        const { page, limit, skip } = getPagination(req.query);

        const built = await buildPlayerFilter(req);
        if (built.message) return sendError(res, built.status, built.message);
        const { filter } = built;

        if (teamId === "none") filter.teamId = null;
        else if (teamId && isValidId(teamId)) filter.teamId = teamId;

        const [players, total] = await Promise.all([
            populatePlayer(Player.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
            Player.countDocuments(filter),
        ]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Players fetched successfully.",
            message_desc: "Players fetched successfully.",
            data: {
                players: players.map(formatPlayer),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        return sendServerError(res, "List players", e);
    }
};

/**
 * GET /api/user/players/unassigned?clubId=&status=&playerType=&gender=&search=&page=1&limit=10   (superAdmin ya clubAdmin)
 * Wo players jo KISI bhi team mein nahi hain (teamId: null).
 * clubAdmin: sirf apne club ke. superAdmin: saare clubs ke (ya clubId se ek club).
 */
const listUnassignedPlayers = async (req, res) => {
    try {
        const { page, limit, skip } = getPagination(req.query);

        const built = await buildPlayerFilter(req, { teamId: null });
        if (built.message) return sendError(res, built.status, built.message);
        const { filter } = built;

        const [players, total] = await Promise.all([
            populatePlayer(Player.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
            Player.countDocuments(filter),
        ]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Unassigned players fetched successfully.",
            message_desc: "Unassigned players fetched successfully.",
            data: {
                players: players.map(formatPlayer),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        return sendServerError(res, "List unassigned players", e);
    }
};

/**
 * GET /api/user/players/:id   (superAdmin ya clubAdmin, :id = Player ki _id)
 * Detail page ke liye: player + club (logo, theme, primary admin) + team (category, capacity, counts) + coach + parents
 */
const getPlayer = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid player id.");

        const player = await populatePlayerDetail(Player.findById(id));
        if (!player || !canAccess(req, player.clubId)) return sendError(res, 404, "Player not found.");

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player fetched successfully.",
            message_desc: "Player fetched successfully.",
            data: await formatPlayerDetail(player),
        });
    } catch (e) {
        return sendServerError(res, "Get player", e);
    }
};

/**
 * PUT /api/user/players/:id/update   (superAdmin ya clubAdmin, :id = Player ki _id)
 * body: jo badalna hai wahi. teamId: "" = team se hatana.
 * idDocument (file) = nayi file. removeIdDocument=true = file hatana.
 * NOTE: parents is API se update NAHI hote (uske liye link / unlink APIs).
 */
const updatePlayer = async (req, res) => {
    let uploadedDoc = "";
    try {
        const { id } = req.params;
        const body = req.body || {};

        // 1. Player id valid hai?
        if (!isValidId(id)) return sendError(res, 400, "Invalid player id.");

        // 2. Player mila aur access hai?
        const player = await Player.findById(id);
        if (!player) return sendError(res, 404, "Player not found.");
        if (!canAccess(req, player.clubId)) return sendError(res, 403, "You don't have access to this player.");

        // 3. ID document file check
        const docCheck = getIdDocumentFile(req);
        if (docCheck.error) return sendError(res, 400, docCheck.error);

        // 4. Player ka User mila?
        const user = await User.findById(player.userId);
        if (!user) return sendError(res, 404, "Player user not found.");

        // 5. Naya playerType (bheja ho toh), warna purana
        let newType = player.playerType || "youth";
        if (body.playerType !== undefined) {
            newType = String(body.playerType).toLowerCase();
            if (!PLAYER_TYPES.includes(newType)) return sendError(res, 400, "Player type must be youth or senior.");
        }

        // 6. User fields validate (partial = sirf bheje gaye)
        const personCheck = validatePersonFields(body, true, newType);
        if (personCheck.message) return sendError(res, personCheck.status, personCheck.message);
        const person = personCheck.values;

        // 7. Player fields validate (sizes, number, status, season, medical notes)
        const playerCheck = validatePlayerFields(body);
        if (playerCheck.message) return sendError(res, playerCheck.status, playerCheck.message);
        const values = playerCheck.values;
        values.playerType = newType;

        // 8. Senior ban raha hai toh mobile hona chahiye
        if (newType === "senior" && !(person.mobileNumber || user.mobileNumber)) {
            return sendError(res, 400, "Mobile number is required for a senior player.");
        }

        // 9. Duplicate mobile / email / idNumber check
        const duplicate = await findDuplicate({
            countryCode: person.countryCode || user.countryCode,
            mobileNumber: person.mobileNumber,
            email: person.email,
            idNumber: person.idNumber,
            excludeUserId: user._id,
        });
        if (duplicate) return sendError(res, duplicate.status, duplicate.message);

        // 10. Team resolve
        let team = player.teamId ? await Team.findById(player.teamId) : null;
        if (body.teamId !== undefined) {
            const teamResult = await resolveTeam(body.teamId, player.clubId);
            if (teamResult.message) return sendError(res, teamResult.status, teamResult.message);
            team = teamResult.team;
        }

        // 11. Team rules (shirt number duplicate, capacity)
        const ruleError = await checkTeamRules({
            team,
            shirtNumber: values.shirtNumber !== undefined ? values.shirtNumber : player.shirtNumber,
            status: values.status || player.status,
            excludePlayerId: player._id,
        });
        if (ruleError) return sendError(res, ruleError.status, ruleError.message);

        // 12. ID document handle
        const oldDoc = player.idDocument || "";
        let docChanged = false;
        if (docCheck.file) {
            uploadedDoc = await upload_files("players", docCheck.file);
            if (!uploadedDoc) return sendError(res, 500, "ID document upload failed. Please try again.");
            player.idDocument = uploadedDoc;
            docChanged = true;
        } else if (String(body.removeIdDocument) === "true") {
            player.idDocument = "";
            docChanged = true;
        }

        // 13. User update
        if (person.email !== undefined) person.email = person.email || undefined;
        Object.assign(user, person);
        user.role = roleForType(newType);
        await user.save();

        // 14. Player update (parents ko chhod ke)
        Object.assign(player, values);
        if (body.teamId !== undefined) player.teamId = team ? team._id : null;
        await player.save();

        // 15. Purani file hatao (agar change hui)
        if (docChanged && oldDoc) await removeIdDocument(oldDoc);

        // 16. Populated player wapas bhejo
        const saved = await populatePlayer(Player.findById(player._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player updated successfully.",
            message_desc: "Player updated successfully.",
            data: formatPlayer(saved),
        });
    } catch (e) {
        if (uploadedDoc) await removeIdDocument(uploadedDoc);
        return sendServerError(res, "Update player", e);
    }
};

/**
 * DELETE /api/user/players/:id/delete   (superAdmin ya clubAdmin, :id = Player ki _id)
 * Player + uska User hatta hai. Jis parent ka ab koi aur bachcha nahi, uska Parent + User bhi.
 */
const deletePlayer = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid player id.");

        const player = await Player.findById(id);
        if (!player || !canAccess(req, player.clubId)) return sendError(res, 404, "Player not found.");

        const parentIds = player.parents.map((link) => link.parentId);
        const playerUser = await User.findById(player.userId).select("profile_image");
        await Player.findByIdAndDelete(player._id);
        await User.findByIdAndDelete(player.userId);
        await cleanupOrphanParents(parentIds);
        await removeIdDocument(player.idDocument);
        // Profile image bhi S3 se (wahi S3 delete helper)
        if (playerUser?.profile_image) await removeIdDocument(playerUser.profile_image);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player deleted successfully.",
            message_desc: "Player deleted successfully.",
            data: { _id: player._id },
        });
    } catch (e) {
        return sendServerError(res, "Delete player", e);
    }
};

/**
 * GET /api/user/players/shirt-sizes   (bina token)
 * Player form ke teeno size dropdowns (game / training / winter) ke liye list. Model se aati hai.
 */
const SHIRT_SIZE_LABELS = {
    "8": "8",
    "10": "10",
    "12": "12",
    "14": "14",
    "16": "16",
    S: "S",
    M: "M",
    L: "L",
    XL: "XL",
    XXL: "XXL",
    XXXL: "XXXL",
};

const listShirtSizes = async (req, res) => {
    return res.status(200).json({
        error: false,
        status: 200,
        message: "Shirt sizes fetched successfully.",
        message_desc: "Shirt sizes fetched successfully.",
        data: {
            shirtSizes: SHIRT_SIZES.map((code) => ({
                code,
                label: SHIRT_SIZE_LABELS[code] || code,
            })),
        },
    });
};

/**
 * GET /api/user/teams/:id/shirt-numbers?excludePlayerId=   (superAdmin ya clubAdmin)
 * Team ke bhare hue (taken) shirt numbers. Sirf active / waitlisted players ke.
 */
const listShirtNumbers = async (req, res) => {
    try {
        const { id } = req.params;
        const excludePlayerId = String(req.query.excludePlayerId || "").trim();

        if (!isValidId(id)) return sendError(res, 400, "Invalid team id.");

        const team = await Team.findById(id);
        if (!team || !canAccess(req, team.clubId)) return sendError(res, 404, "Team not found.");

        const filter = {
            teamId: team._id,
            status: { $in: ROSTER_STATUSES },
            shirtNumber: { $ne: null },
        };
        if (excludePlayerId && isValidId(excludePlayerId)) filter._id = { $ne: excludePlayerId };

        const players = await Player.find(filter)
            .populate("userId", "firstname lastname profile_image")
            .sort({ shirtNumber: 1 });

        const taken = players.map((p) => ({
            shirtNumber: p.shirtNumber,
            playerId: p._id,
            firstname: p.userId?.firstname || "",
            lastname: p.userId?.lastname || "",
            profile_image: p.userId?.profile_image || "",
            status: p.status,
        }));

        const activeCount = await Player.countDocuments({ teamId: team._id, status: "active" });

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Shirt numbers fetched successfully.",
            message_desc: "Shirt numbers fetched successfully.",
            data: {
                team: {
                    _id: team._id,
                    name: team.name,
                    teamCapacity: team.teamCapacity,
                    activePlayers: activeCount,
                },
                taken,
                takenNumbers: taken.map((t) => t.shirtNumber),
                takenCount: taken.length,
            },
        });
    } catch (e) {
        return sendServerError(res, "List shirt numbers", e);
    }
};

/**
 * GET /api/user/teams/:id/other-players?search=&fromTeamId=&status=&playerType=&page=1&limit=10
 * (superAdmin ya clubAdmin)
 *
 * Isi team ke CLUB ke woh players jo IS team mein NAHI hain:
 *   - doosri teams ke players
 *   - bina team wale players (waitlist)
 * Team page pe "doosri team se player add / move karo" ke liye.
 *
 * fromTeamId: sirf ek khaas team ke players (ya "none" = bina team wale)
 */
const listOtherTeamPlayers = async (req, res) => {
    try {
        const { id } = req.params;
        const search = String(req.query.search || "").trim();
        const fromTeamId = String(req.query.fromTeamId || "").trim();
        const status = String(req.query.status || "").trim().toLowerCase();
        const playerType = String(req.query.playerType || "").trim().toLowerCase();
        const { page, limit, skip } = getPagination(req.query);

        if (!isValidId(id)) return sendError(res, 400, "Invalid team id.");

        const team = await Team.findById(id);
        if (!team || !canAccess(req, team.clubId)) return sendError(res, 404, "Team not found.");

        // Usi club ke players, is team ke chhod ke
        const filter = { clubId: team.clubId, teamId: { $ne: team._id } };

        if (fromTeamId === "none") {
            filter.teamId = null;
        } else if (fromTeamId) {
            if (!isValidId(fromTeamId) || String(fromTeamId) === String(team._id)) {
                return sendError(res, 400, "Invalid fromTeamId.");
            }
            filter.teamId = fromTeamId;
        }

        if (status && PLAYER_STATUSES.includes(status)) filter.status = status;
        if (playerType && PLAYER_TYPES.includes(playerType)) filter.playerType = playerType;

        // Naam / ID User mein hain
        if (search) {
            const rx = new RegExp(escapeRegex(search), "i");
            const users = await User.find({
                role: { $in: [ROLES.SENIOR_PLAYER, ROLES.YOUTH_PLAYER] },
                $or: [{ firstname: rx }, { lastname: rx }, { idNumber: rx }],
            }).select("_id");
            filter.userId = { $in: users.map((u) => u._id) };
        }

        const [players, total] = await Promise.all([
            populatePlayer(Player.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
            Player.countDocuments(filter),
        ]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Players fetched successfully.",
            message_desc: "Players fetched successfully.",
            data: {
                team: { _id: team._id, name: team.name },
                players: players.map(formatPlayer),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        return sendServerError(res, "List other team players", e);
    }
};

/**
 * POST /api/user/players/assign   (superAdmin ya clubAdmin)
 * Pehle se bane EK YA ZYADA players ko ek team mein daalna. Naya player NAHI banta.
 * Player bina team ka ho ya kisi doosri team mein ho, dono chalega (doosri team se move ho jayega).
 * Har player ka purana shirt number aur status rehta hai.
 * body: { teamId, playerIds: ["id1", "id2", "id3"] }
 * Har player alag se check hota hai. Jo sahi hain wo assign, jinme problem hai wo "failed" mein wajah ke saath.
 */
const assignPlayerToTeam = async (req, res) => {
    try {
        const body = req.body || {};
        const teamId = String(body.teamId || "").trim();
        if (!isValidId(teamId)) return sendError(res, 400, "Please select a valid team.");

        // Khaali aur same id do baar aayi toh hata do
        const playerIds = Array.isArray(body.playerIds)
            ? [...new Set(body.playerIds.map((id) => String(id || "").trim()).filter(Boolean))]
            : [];
        if (playerIds.length === 0) return sendError(res, 400, "Please select at least one player.");

        const team = await Team.findById(teamId);
        if (!team || !canAccess(req, team.clubId)) return sendError(res, 404, "Team not found.");

        const assigned = [];
        const failed = [];

        // Ek ek karke, taaki pichhle player ka number / capacity agle ke check mein gine
        for (const playerId of playerIds) {
            const fail = (message) => failed.push({ playerId, message });

            if (!isValidId(playerId)) {
                fail("Invalid player id.");
                continue;
            }

            const player = await Player.findById(playerId);
            if (!player || !canAccess(req, player.clubId)) {
                fail("Player not found.");
                continue;
            }

            if (String(player.clubId) !== String(team.clubId)) {
                fail("This player belongs to another club.");
                continue;
            }

            if (player.teamId && String(player.teamId) === String(team._id)) {
                fail("Player is already in this team.");
                continue;
            }

            // Is team mein player ka shirt number free hai? Capacity bachi hai?
            const ruleError = await checkTeamRules({
                team,
                shirtNumber: player.shirtNumber,
                status: player.status,
                excludePlayerId: player._id,
            });
            if (ruleError) {
                fail(ruleError.message);
                continue;
            }

            player.teamId = team._id;
            if (!player.season) player.season = team.season || "";
            await player.save();

            const saved = await populatePlayer(Player.findById(player._id));
            assigned.push(formatPlayer(saved));
        }

        // Ek bhi assign nahi hua toh error, warna success (failed list ke saath)
        if (assigned.length === 0) {
            const message = failed.length === 1 ? failed[0].message : "No players were added to the team.";
            return sendError(res, 400, message, { assigned, failed });
        }

        const message = failed.length
            ? `${assigned.length} player(s) added to team, ${failed.length} failed.`
            : `${assigned.length} player(s) added to team successfully.`;

        return res.status(200).json({
            error: false,
            status: 200,
            message,
            message_desc: message,
            data: {
                team: { _id: team._id, name: team.name },
                assigned,
                failed,
            },
        });
    } catch (e) {
        return sendServerError(res, "Assign player to team", e);
    }
};

/**
 * PUT /api/user/teams/:id/players/:playerId/remove   (superAdmin ya clubAdmin)
 * Player ko team se HATANA. Player aur uska User delete NAHI hote,
 * bas teamId null ho jaata hai (aur shirt number free). Baad mein kisi bhi team mein assign kar sakte ho.
 */
const removePlayerFromTeam = async (req, res) => {
    try {
        const { id, playerId } = req.params;

        if (!isValidId(id)) return sendError(res, 400, "Invalid team id.");
        if (!isValidId(playerId)) return sendError(res, 400, "Invalid player id.");

        const team = await Team.findById(id);
        if (!team || !canAccess(req, team.clubId)) return sendError(res, 404, "Team not found.");

        const player = await Player.findById(playerId);
        if (!player || !canAccess(req, player.clubId)) return sendError(res, 404, "Player not found.");

        if (!player.teamId || String(player.teamId) !== String(team._id)) {
            return sendError(res, 400, "Player is not in this team.");
        }

        player.teamId = null;
        player.shirtNumber = null; // number is team ka tha, ab free
        await player.save();

        const saved = await populatePlayer(Player.findById(player._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player removed from team successfully.",
            message_desc: "Player removed from team successfully.",
            data: formatPlayer(saved),
        });
    } catch (e) {
        return sendServerError(res, "Remove player from team", e);
    }
};

module.exports = {
    createPlayer,
    listPlayers,
    listUnassignedPlayers,
    getPlayer,
    updatePlayer,
    deletePlayer,
    listShirtSizes,
    listShirtNumbers,
    listOtherTeamPlayers,
    assignPlayerToTeam,
    removePlayerFromTeam,

    // parentController / adminParentController ke liye
    removeIdDocument,
    populatePlayer,
    formatPlayer,
};