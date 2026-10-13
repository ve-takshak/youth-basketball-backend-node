const validator = require("validator");
const User = require("../../models/User");
const Club = require("../../models/Club");
const Team = require("../../models/Team");
const Parent = require("../../models/Parent");
const Player = require("../../models/Player");
const { SHIRT_SIZES, PLAYER_STATUSES, PLAYER_TYPES, PARENT_RELATIONS } = require("../../models/Player");
const { ROLES } = require("../../helpers/constants");
const { isValidId, cleanMobile, escapeRegex, getPagination } = require("../../helpers/common");
const { validatePersonInput } = require("../../helpers/userHelper");

// Player ka data do jagah:
//   User   (role: "player") -> firstname, lastname, birthDate, gender, idNumber, mobile, email
//   Player                  -> club, team, season, playerType, shirt, parents, status

// Jin statuses wale players team mein jagah lete hain (shirt number + capacity)
const ROSTER_STATUSES = ["active", "waitlisted"];

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
const validatePersonFields = (body, partial = false) => {
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
    // Mobile optional (bachche ka nahi hota). Diya ho toh sahi hona chahiye.
    if (has("mobileNumber") || has("countryCode")) {
        values.countryCode = String(body.countryCode || "+972").trim();
        values.mobileNumber = cleanMobile(body.mobileNumber);
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
    if (has("shirtSize")) {
        values.shirtSize = String(body.shirtSize || "").toUpperCase();
        if (values.shirtSize && !SHIRT_SIZES.includes(values.shirtSize)) {
            return { status: 400, message: `Shirt size must be one of: ${SHIRT_SIZES.join(", ")}.` };
        }
    }
    if (has("shirtNumber")) {
        if (body.shirtNumber === null || body.shirtNumber === "") {
            values.shirtNumber = null;
        } else {
            const num = Number(body.shirtNumber);
            if (!Number.isInteger(num) || num < 0 || num > 99) return { status: 400, message: "Shirt number must be between 0 and 99." };
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

const populatePlayer = (query) =>
    query
        .populate("userId", "firstname lastname birthDate gender idNumber email countryCode mobileNumber is_verify")
        .populate("clubId", "name")
        .populate("teamId", "name season")
        .populate({
            path: "parents.parentId",
            select: "userId",
            populate: { path: "userId", select: "firstname lastname email countryCode mobileNumber is_verify" },
        });

// User + Player ek flat object mein (frontend ke liye aasaan)
const formatPlayer = (player) => {
    const user = player.userId || {};
    return {
        _id: player._id,
        userId: user._id || null,
        firstname: user.firstname || "",
        lastname: user.lastname || "",
        birthDate: toDateString(user.birthDate),
        age: ageFrom(user.birthDate),
        gender: user.gender || "",
        idNumber: user.idNumber || "",
        email: user.email || "",
        countryCode: user.mobileNumber ? user.countryCode : "",
        mobileNumber: user.mobileNumber || "",
        is_verify: user.is_verify || false,
        playerType: player.playerType,
        shirtSize: player.shirtSize || "",
        shirtNumber: player.shirtNumber ?? null,
        status: player.status,
        season: player.season || "",
        club: player.clubId && player.clubId._id ? { _id: player.clubId._id, name: player.clubId.name } : null,
        team: player.teamId && player.teamId._id ? { _id: player.teamId._id, name: player.teamId.name } : null,
        parents: (player.parents || [])
            .filter((link) => link.parentId)
            .map((link) => ({
                parentId: link.parentId._id || link.parentId,
                userId: link.parentId.userId?._id || null,
                firstname: link.parentId.userId?.firstname || "",
                lastname: link.parentId.userId?.lastname || "",
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

// ---------------------------------------------------------------------------
// APIs
// ---------------------------------------------------------------------------

/**
 * POST /api/user/players/create   (superAdmin ya clubAdmin)
 * body: {
 *   firstname, lastname, birthDate, gender, idNumber?, email?, countryCode?, mobileNumber?,   -> User
 *   clubId (sirf superAdmin), teamId?, season?, playerType?, shirtSize?, shirtNumber?, status?, -> Player
 *   parents: [{ firstname, lastname, countryCode, mobileNumber, email?, relation?, isPrimary? }]
 * }
 */
const createPlayer = async (req, res) => {
    const created = { users: [], parents: [] };
    let playerUser = null;
    try {
        const personCheck = validatePersonFields(req.body);
        if (personCheck.message) {
            return res.status(personCheck.status).json({
                error: true,
                status: personCheck.status,
                message: personCheck.message,
                message_desc: personCheck.message,
                data: {},
            });
        }
        const person = personCheck.values;

        const playerCheck = validatePlayerFields(req.body);
        if (playerCheck.message) {
            return res.status(playerCheck.status).json({
                error: true,
                status: playerCheck.status,
                message: playerCheck.message,
                message_desc: playerCheck.message,
                data: {},
            });
        }
        const values = playerCheck.values;
        values.status = values.status || "active";
        values.playerType = values.playerType || "youth";

        // clubAdmin apne club mein, superAdmin body se club chunega
        const clubId = req.user.role === ROLES.CLUB_ADMIN ? String(req.clubId) : String(req.body.clubId || "").trim();
        if (!isValidId(clubId) || !(await Club.exists({ _id: clubId }))) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Please select a valid club.",
                message_desc: "Please select a valid club.",
                data: {},
            });
        }

        const teamResult = await resolveTeam(req.body.teamId, clubId);
        if (teamResult.message) {
            return res.status(teamResult.status).json({
                error: true,
                status: teamResult.status,
                message: teamResult.message,
                message_desc: teamResult.message,
                data: {},
            });
        }

        const ruleError = await checkTeamRules({
            team: teamResult.team,
            shirtNumber: values.shirtNumber,
            status: values.status,
        });
        if (ruleError) {
            return res.status(ruleError.status).json({
                error: true,
                status: ruleError.status,
                message: ruleError.message,
                message_desc: ruleError.message,
                data: {},
            });
        }

        const duplicate = await findDuplicate(person);
        if (duplicate) {
            return res.status(duplicate.status).json({
                error: true,
                status: duplicate.status,
                message: duplicate.message,
                message_desc: duplicate.message,
                data: {},
            });
        }

        // Youth player ke liye kam se kam ek parent zaroori
        const rawParents = req.body.parents || [];
        if (values.playerType === "youth" && (!Array.isArray(rawParents) || rawParents.length === 0)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "At least one parent or guardian is required for a youth player.",
                message_desc: "At least one parent or guardian is required for a youth player.",
                data: {},
            });
        }

        const parentResult = await resolveParents(rawParents, clubId, req.user._id, created);
        if (parentResult.message) {
            await rollbackCreated(created);
            return res.status(parentResult.status).json({
                error: true,
                status: parentResult.status,
                message: parentResult.message,
                message_desc: parentResult.message,
                data: {},
            });
        }

        // 1. Player ka User (role: player)
        playerUser = await User.create({
            firstname: person.firstname,
            lastname: person.lastname,
            birthDate: person.birthDate,
            gender: person.gender,
            idNumber: person.idNumber || "",
            email: person.email || undefined,
            countryCode: person.countryCode || "+972",
            mobileNumber: person.mobileNumber || "",
            role: ROLES.PLAYER,
        });

        // 2. Player record (khel ki details)
        const player = await Player.create({
            ...values,
            userId: playerUser._id,
            clubId,
            teamId: teamResult.team ? teamResult.team._id : null,
            season: values.season ?? (teamResult.team ? teamResult.team.season : ""),
            parents: parentResult.links,
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
        // Adhoora data na bache
        if (playerUser) await User.findByIdAndDelete(playerUser._id).catch(() => { });
        await rollbackCreated(created);
        console.error("Create player error:", e);
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
 * GET /api/user/players?clubId=&teamId=&status=&gender=&search=&page=1&limit=10   (superAdmin ya clubAdmin)
 * search: naam ya ID number.  teamId=none: jin players ki koi team nahi
 */
const listPlayers = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        const teamId = String(req.query.teamId || "").trim();
        const status = String(req.query.status || "").trim().toLowerCase();
        const gender = String(req.query.gender || "").trim().toLowerCase();
        const { page, limit, skip } = getPagination(req.query);

        const filter = {};

        if (req.user.role === ROLES.CLUB_ADMIN) {
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

        if (teamId === "none") filter.teamId = null;
        else if (teamId && isValidId(teamId)) filter.teamId = teamId;

        if (status && PLAYER_STATUSES.includes(status)) filter.status = status;

        // Naam / ID / gender User mein hain, isliye pehle matching player users
        if (search || ["boys", "girls"].includes(gender)) {
            const userFilter = { role: ROLES.PLAYER };
            if (["boys", "girls"].includes(gender)) userFilter.gender = gender;
            if (search) {
                const rx = new RegExp(escapeRegex(search), "i");
                userFilter.$or = [{ firstname: rx }, { lastname: rx }, { idNumber: rx }];
            }
            const users = await User.find(userFilter).select("_id");
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
                players: players.map(formatPlayer),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        console.error("List players error:", e);
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
 * GET /api/user/players/:id   (superAdmin ya clubAdmin, :id = Player ki _id)
 */
const getPlayer = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid player id.",
                message_desc: "Invalid player id.",
                data: {},
            });
        }

        const player = await populatePlayer(Player.findById(id));
        if (!player || !canAccess(req, player.clubId)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Player not found.",
                message_desc: "Player not found.",
                data: {},
            });
        }

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player fetched successfully.",
            message_desc: "Player fetched successfully.",
            data: formatPlayer(player),
        });
    } catch (e) {
        console.error("Get player error:", e);
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
 * PUT /api/user/players/:id/update   (superAdmin ya clubAdmin, :id = Player ki _id)
 * body: jo badalna hai wahi. teamId: "" = team se hatana.
 * parents bheja toh poori list replace (jo parent hat gaya, uska bachcha na bacha toh uska account bhi hatega).
 */
const updatePlayer = async (req, res) => {
    const created = { users: [], parents: [] };
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid player id.",
                message_desc: "Invalid player id.",
                data: {},
            });
        }

        const player = await Player.findById(id);
        if (!player || !canAccess(req, player.clubId)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Player not found.",
                message_desc: "Player not found.",
                data: {},
            });
        }

        const user = await User.findById(player.userId);
        if (!user) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Player user not found.",
                message_desc: "Player user not found.",
                data: {},
            });
        }

        const personCheck = validatePersonFields(req.body, true);
        if (personCheck.message) {
            return res.status(personCheck.status).json({
                error: true,
                status: personCheck.status,
                message: personCheck.message,
                message_desc: personCheck.message,
                data: {},
            });
        }
        const person = personCheck.values;

        const playerCheck = validatePlayerFields(req.body);
        if (playerCheck.message) {
            return res.status(playerCheck.status).json({
                error: true,
                status: playerCheck.status,
                message: playerCheck.message,
                message_desc: playerCheck.message,
                data: {},
            });
        }
        const values = playerCheck.values;

        const duplicate = await findDuplicate({
            countryCode: person.countryCode || user.countryCode,
            mobileNumber: person.mobileNumber,
            email: person.email,
            idNumber: person.idNumber,
            excludeUserId: user._id,
        });
        if (duplicate) {
            return res.status(duplicate.status).json({
                error: true,
                status: duplicate.status,
                message: duplicate.message,
                message_desc: duplicate.message,
                data: {},
            });
        }

        // Team (club wahi rehta hai)
        let team = player.teamId ? await Team.findById(player.teamId) : null;
        if (req.body.teamId !== undefined) {
            const teamResult = await resolveTeam(req.body.teamId, player.clubId);
            if (teamResult.message) {
                return res.status(teamResult.status).json({
                    error: true,
                    status: teamResult.status,
                    message: teamResult.message,
                    message_desc: teamResult.message,
                    data: {},
                });
            }
            team = teamResult.team;
        }

        const ruleError = await checkTeamRules({
            team,
            shirtNumber: values.shirtNumber !== undefined ? values.shirtNumber : player.shirtNumber,
            status: values.status || player.status,
            excludePlayerId: player._id,
        });
        if (ruleError) {
            return res.status(ruleError.status).json({
                error: true,
                status: ruleError.status,
                message: ruleError.message,
                message_desc: ruleError.message,
                data: {},
            });
        }

        // Parents replace
        let removedParentIds = [];
        if (req.body.parents !== undefined) {
            const playerType = values.playerType || player.playerType;
            if (playerType === "youth" && (!Array.isArray(req.body.parents) || req.body.parents.length === 0)) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "At least one parent or guardian is required for a youth player.",
                    message_desc: "At least one parent or guardian is required for a youth player.",
                    data: {},
                });
            }

            const parentResult = await resolveParents(req.body.parents, player.clubId, req.user._id, created);
            if (parentResult.message) {
                await rollbackCreated(created);
                return res.status(parentResult.status).json({
                    error: true,
                    status: parentResult.status,
                    message: parentResult.message,
                    message_desc: parentResult.message,
                    data: {},
                });
            }

            const newIds = parentResult.links.map((link) => String(link.parentId));
            removedParentIds = player.parents
                .map((link) => link.parentId)
                .filter((parentId) => !newIds.includes(String(parentId)));
            player.parents = parentResult.links;
        }

        // User mein personal details
        if (person.email !== undefined) person.email = person.email || undefined;
        Object.assign(user, person);

        // Player mein khel ki details
        Object.assign(player, values);
        if (req.body.teamId !== undefined) player.teamId = team ? team._id : null;

        await user.save();
        await player.save();
        await cleanupOrphanParents(removedParentIds);

        const saved = await populatePlayer(Player.findById(player._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player updated successfully.",
            message_desc: "Player updated successfully.",
            data: formatPlayer(saved),
        });
    } catch (e) {
        await rollbackCreated(created);
        console.error("Update player error:", e);
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
 * DELETE /api/user/players/:id/delete   (superAdmin ya clubAdmin, :id = Player ki _id)
 * Player + uska User hatta hai. Jis parent ka ab koi aur bachcha nahi, uska Parent + User bhi.
 */
const deletePlayer = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid player id.",
                message_desc: "Invalid player id.",
                data: {},
            });
        }

        const player = await Player.findById(id);
        if (!player || !canAccess(req, player.clubId)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Player not found.",
                message_desc: "Player not found.",
                data: {},
            });
        }

        const parentIds = player.parents.map((link) => link.parentId);
        await Player.findByIdAndDelete(player._id);
        await User.findByIdAndDelete(player.userId);
        await cleanupOrphanParents(parentIds);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Player deleted successfully.",
            message_desc: "Player deleted successfully.",
            data: { _id: player._id },
        });
    } catch (e) {
        console.error("Delete player error:", e);
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
 * GET /api/user/players/shirt-sizes   (koi bhi logged-in user)
 * Player form ke dropdown ke liye shirt sizes. List Player model se aati hai.
 */
const SHIRT_SIZE_LABELS = {
    YXS: "Youth XS",
    YS: "Youth S",
    YM: "Youth M",
    YL: "Youth L",
    XS: "XS",
    S: "S",
    M: "M",
    L: "L",
    XL: "XL",
    XXL: "XXL",
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
                group: code.startsWith("Y") ? "youth" : "adult",
            })),
        },
    });
};



const listShirtNumbers = async (req, res) => {
    try {
        const { id } = req.params;
        const excludePlayerId = String(req.query.excludePlayerId || "").trim();

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

        const filter = {
            teamId: team._id,
            status: { $in: ROSTER_STATUSES },
            shirtNumber: { $ne: null },
        };
        if (excludePlayerId && isValidId(excludePlayerId)) filter._id = { $ne: excludePlayerId };

        const players = await Player.find(filter)
            .populate("userId", "firstname lastname")
            .sort({ shirtNumber: 1 });

        const taken = players.map((p) => ({
            shirtNumber: p.shirtNumber,
            playerId: p._id,
            firstname: p.userId?.firstname || "",
            lastname: p.userId?.lastname || "",
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
        console.error("List shirt numbers error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = { createPlayer, listPlayers, getPlayer, updatePlayer, deletePlayer, listShirtSizes, listShirtNumbers };