const jwt = require("jsonwebtoken");
const User = require("../models/User");
const ClubAdmin = require("../models/ClubAdmin");
const Coach = require("../models/Coach");
const { ROLES } = require("../helpers/constants");

const sendError = (res, status, message) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data: {} });

// Token check karke user return karta hai. Problem ho toh error message.
const getUserFromToken = async (req) => {
    const header = req.header("Authorization") || "";
    const [type, token] = header.split(" ");

    if (!token || type.toLowerCase() !== "bearer") return { error: "Token is required." };

    try {
        const decoded = jwt.verify(token, process.env.JWTKEY);
        const user = await User.findById(decoded.id);

        if (!user) return { error: "User no longer exists." };
        if (!user.is_verify) return { error: "Please verify your account." };

        return { user };
    } catch (e) {
        return { error: "Invalid or expired token." };
    }
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

    return null;
};

/**
 * Koi bhi logged-in user (saare roles)
 * router.get("/user/profile", authentication, getProfile)
 */
const authentication = async (req, res, next) => {
    try {
        const { user, error } = await getUserFromToken(req);
        if (error) return sendError(res, 401, error);

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
        const { user, error } = await getUserFromToken(req);
        if (error) return sendError(res, 401, error);
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
        const { user, error } = await getUserFromToken(req);
        if (error) return sendError(res, 401, error);
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

module.exports = { authentication, superAdminAuthentication, superAdminOrClubAdminAuthentication };
