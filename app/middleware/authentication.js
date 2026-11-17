const jwt = require("jsonwebtoken");
const User = require("../models/User");
const ClubAdmin = require("../models/ClubAdmin");
const Coach = require("../models/Coach");
const Parent = require("../models/Parent");
const Club = require("../models/Club");
const Player = require("../models/Player");
const { ROLES, isPlayerRole, NO_MOBILE_PLAYER_MESSAGE } = require("../helpers/constants");
const { getRequiredTerms, hasAcceptedRequired } = require("../helpers/termsHelper");

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

// 401 ke saath data.code: TOKEN_EXPIRED = app POST /user/refresh-token kare, baaki = login screen
const sendAuthError = (res, { error, code }) => sendError(res, 401, error, { code });

// Token check karke user return karta hai. Problem ho toh { error, code }.
// Sirf access token (type "access", 15 min) chalta hai. Purane 180 din wale token ab nahi chalte.
const getUserFromToken = async (req) => {
    const header = req.header("Authorization") || "";
    const [type, token] = header.split(" ");

    if (!token || type.toLowerCase() !== "bearer") return { error: "Token is required.", code: "TOKEN_REQUIRED" };

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWTKEY, { algorithms: ["HS256"] });
    } catch (e) {
        if (e.name === "TokenExpiredError") return { error: "Token expired.", code: "TOKEN_EXPIRED" };
        return { error: "Invalid token.", code: "TOKEN_INVALID" };
    }
    if (decoded.type !== "access") return { error: "Invalid token. Please log in again.", code: "TOKEN_INVALID" };

    const user = await User.findById(decoded.id);
    if (!user) return { error: "User no longer exists.", code: "TOKEN_INVALID" };
    if (!user.is_verify) return { error: "Please verify your account.", code: "TOKEN_INVALID" };
    // Player ka mobile hata diya gaya ho toh purana token bhi band
    if (isPlayerRole(user.role) && !user.mobileNumber) return { error: NO_MOBILE_PLAYER_MESSAGE, code: "TOKEN_INVALID" };

    return { user };
};

// clubAdmin aur coach ka club nikal ke req.clubId mein daalna (superAdmin ke liye null)
const attachClub = async (req) => {
    req.clubId = null;

    if (req.user.role === ROLES.CLUB_ADMIN) {
        const clubAdmin = await ClubAdmin.findOne({ userId: req.user._id });
        if (!clubAdmin) return "Your account is not linked to any club.";
        req.clubId = clubAdmin.clubId;
    }

    if (req.user.role === ROLES.COACH) {
        const coach = await Coach.findOne({ userId: req.user._id });
        if (!coach) return "Your account is not linked to any club.";
        req.clubId = coach.clubId;
    }

    // Archived club: already logged-in users ka token bhi kaam nahi karega
    let clubId = req.clubId;
    if (req.user.role === ROLES.PARENT) {
        const parent = await Parent.findOne({ userId: req.user._id }).select("clubId");
        clubId = parent?.clubId;
    }
    if (isPlayerRole(req.user.role)) {
        const player = await Player.findOne({ userId: req.user._id }).select("clubId");
        clubId = player?.clubId;
    }
    if (clubId && (await Club.exists({ _id: clubId, isArchived: true }))) {
        return "Your club has been archived. Please contact the administrator.";
    }

    return null;
};

/**
 * Koi bhi logged-in user (saare roles)
 * router.get("/user/profile", authentication, getProfile)
 */
const authentication = async (req, res, next) => {
    try {
        const auth = await getUserFromToken(req);
        const { user, error } = auth;
        if (error) return sendAuthError(res, auth);

        req.user = user;
        const clubError = await attachClub(req);
        if (clubError) return sendError(res, 403, clubError);

        next();
    } catch (e) {
        return sendError(res, 500, "Something went wrong.");
    }
};

/**
 * Sirf superAdmin
 * router.post("/user/createClub", superAdminAuthentication, createClub)
 */
const superAdminAuthentication = async (req, res, next) => {
    try {
        const auth = await getUserFromToken(req);
        const { user, error } = auth;
        if (error) return sendAuthError(res, auth);
        if (user.role !== ROLES.SUPER_ADMIN) return sendError(res, 403, "Access denied. Super admin only.");

        req.user = user;
        req.clubId = null;
        next();
    } catch (e) {
        return sendError(res, 500, "Something went wrong.");
    }
};

/**
 * SuperAdmin ya clubAdmin (web panel wale dono roles)
 * clubAdmin ke liye req.clubId mein uska club hoga, superAdmin ke liye null.
 * router.post("/user/createCoach", superAdminOrClubAdminAuthentication, createCoach)
 */
const superAdminOrClubAdminAuthentication = async (req, res, next) => {
    try {
        const auth = await getUserFromToken(req);
        const { user, error } = auth;
        if (error) return sendAuthError(res, auth);
        if (![ROLES.SUPER_ADMIN, ROLES.CLUB_ADMIN].includes(user.role)) {
            return sendError(res, 403, "Access denied. Super admin or club admin only.");
        }

        req.user = user;
        const clubError = await attachClub(req);
        if (clubError) return sendError(res, 403, clubError);

        next();
    } catch (e) {
        return sendError(res, 500, "Something went wrong.");
    }
};

/**
 * Parent ke bachche / payment APIs ke liye, authentication ke BAAD lagao.
 * Club ke terms hon aur parent ne required version accept na kiya ho toh 403 + data.termsRequired.
 * Dusre roles ko aur club bina terms wale parents ko nahi rokta.
 * router.get("/user/parent/listMyYouthPlayers", authentication, requireTermsAccepted, listMyYouthPlayers)
 */
const requireTermsAccepted = async (req, res, next) => {
    try {
        if (req.user.role !== ROLES.PARENT) return next();

        const parent = await Parent.findOne({ userId: req.user._id }).select("clubId");
        if (!parent) return next();

        const required = await getRequiredTerms(parent.clubId);
        if (!required || (await hasAcceptedRequired(req.user._id, parent.clubId, required))) return next();

        const message = "Please accept your club's terms and conditions to continue.";
        return res.status(403).json({ error: true, status: 403, message, message_desc: message, data: { termsRequired: true } });
    } catch (e) {
        return sendError(res, 500, "Something went wrong.");
    }
};

module.exports = { authentication, superAdminAuthentication, superAdminOrClubAdminAuthentication, requireTermsAccepted };
