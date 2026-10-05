const jwt = require("jsonwebtoken");
const User = require("../models/User");

const sendError = (res, status, message) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data: {} });


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


const authentication = async (req, res, next) => {
    const { user, error } = await getUserFromToken(req);
    if (error) return sendError(res, 401, error);

    req.user = user;
    next();
};


const adminAuthentication = async (req, res, next) => {
    const { user, error } = await getUserFromToken(req);
    if (error) return sendError(res, 401, error);
    if (user.role !== "admin") return sendError(res, 403, "Access denied. Admin only.");

    req.user = user;
    next();
};

module.exports = { authentication, adminAuthentication };