// Login tokens:
//   access token  - JWT, 15 minute. Har API ke Authorization: Bearer mein.
//   refresh token - random 64 byte, 30 din. Sirf POST /user/refresh-token pe. DB mein sirf hash.
// Refresh pe naya access + naya refresh token milta hai, purana refresh token band (rotation).
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const RefreshToken = require("../models/RefreshToken");

const ACCESS_TOKEN_MINUTES = 15;
const REFRESH_TOKEN_DAYS = 30;
// Ek hi refresh token do baar ek saath aaye (app ke do request) toh itne second tak family band nahi karte
const REUSE_GRACE_SECONDS = 30;

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

const createAccessToken = (user) =>
    jwt.sign({ id: user._id, role: user.role, type: "access" }, process.env.JWTKEY, {
        algorithm: "HS256",
        expiresIn: `${ACCESS_TOKEN_MINUTES}m`,
    });

const clientMeta = (req) => ({
    ip: String(req?.ip || "").slice(0, 64),
    userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 300),
});

const saveRefreshToken = async (user, { familyId, device_type = "", req } = {}) => {
    const raw = crypto.randomBytes(64).toString("hex");
    const doc = await RefreshToken.create({
        userId: user._id,
        tokenHash: hashToken(raw),
        familyId: familyId || crypto.randomUUID(),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
        device_type: String(device_type || ""),
        ...clientMeta(req),
    });
    return { raw, doc };
};

// Login / refresh ke response ka token wala hissa
const tokenPayload = (user, refresh) => ({
    token: createAccessToken(user),
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_MINUTES * 60, // second
    refreshToken: refresh.raw,
    refreshTokenExpiresAt: refresh.doc.expiresAt,
});

// Naya login: nayi family
const issueTokens = async (user, { device_type, req } = {}) => tokenPayload(user, await saveRefreshToken(user, { device_type, req }));

/**
 * Refresh token se naye tokens. User check (exists, verified) caller karta hai loadUser se.
 * Return: { tokens, user } ya { status, message }
 */
const rotateTokens = async (raw, loadUser, req) => {
    if (!raw || typeof raw !== "string") return { status: 400, message: "Refresh token is required." };
    const current = await RefreshToken.findOne({ tokenHash: hashToken(raw) });
    if (!current || current.expiresAt <= new Date()) return { status: 401, message: "Session expired. Please log in again." };

    if (current.revokedAt) {
        // Rotate hua token dobara: thodi der mein toh do request ek saath (sirf mana), baad mein chori ka shak (family band)
        const recent = current.revokedReason === "rotated" && Date.now() - current.revokedAt.getTime() < REUSE_GRACE_SECONDS * 1000;
        if (!recent && current.revokedReason === "rotated") {
            await RefreshToken.updateMany(
                { familyId: current.familyId, revokedAt: null },
                { $set: { revokedAt: new Date(), revokedReason: "reuse" } }
            );
        }
        return { status: 401, message: "Session expired. Please log in again." };
    }

    const user = await loadUser(current.userId);
    if (!user) return { status: 401, message: "Session expired. Please log in again." };

    // Pehle purana band (atomic: do request ek saath aaye toh sirf ek jeetega)
    const claimed = await RefreshToken.findOneAndUpdate(
        { _id: current._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: "rotated" } },
        { returnDocument: "after" }
    );
    if (!claimed) return { status: 401, message: "Session expired. Please log in again." };

    const next = await saveRefreshToken(user, { familyId: current.familyId, device_type: current.device_type, req });
    claimed.replacedBy = next.doc._id;
    await claimed.save();
    return { user, tokens: tokenPayload(user, next) };
};

// Logout: ye refresh token (aur uski family) band. allDevices = user ke saare
const revokeTokens = async (raw, { allDevices = false } = {}) => {
    const current = raw ? await RefreshToken.findOne({ tokenHash: hashToken(raw) }) : null;
    if (!current) return false;
    const filter = allDevices ? { userId: current.userId, revokedAt: null } : { familyId: current.familyId, revokedAt: null };
    await RefreshToken.updateMany(filter, { $set: { revokedAt: new Date(), revokedReason: allDevices ? "logout_all" : "logout" } });
    return true;
};

module.exports = { ACCESS_TOKEN_MINUTES, REFRESH_TOKEN_DAYS, createAccessToken, issueTokens, rotateTokens, revokeTokens };
