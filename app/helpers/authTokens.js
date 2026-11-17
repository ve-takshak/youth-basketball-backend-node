// Login tokens:
//   access token  - JWT, 15 minute. Har API ke Authorization: Bearer mein.
//   refresh token - random 64 byte, 30 din. Sirf POST /user/refresh-token pe. DB mein sirf hash.
// Refresh pe naya access + naya refresh token milta hai, purana band (rotation). Ek login = ek DB document, refresh pe wahi update hota hai.
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

const newRawToken = () => crypto.randomBytes(64).toString("hex");
const newExpiry = () => new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
const SESSION_EXPIRED = { status: 401, message: "Session expired. Please log in again." };

// Login / refresh ke response ka token wala hissa
const tokenPayload = (user, raw, expiresAt) => ({
    token: createAccessToken(user),
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_MINUTES * 60, // second
    refreshToken: raw,
    refreshTokenExpiresAt: expiresAt,
});

// Login: user + device_type ka ek hi document. Pehle se hai toh wahi update (purana token band), nahi toh banta hai.
const issueTokens = async (user, { device_type, req } = {}) => {
    const raw = newRawToken();
    const filter = { userId: user._id, device_type: String(device_type || "") };
    const update = {
        $set: {
            tokenHash: hashToken(raw),
            previousTokenHash: null,
            rotatedAt: null,
            expiresAt: newExpiry(),
            revokedAt: null,
            revokedReason: "",
            ...clientMeta(req),
        },
    };
    const upsert = () => RefreshToken.findOneAndUpdate(filter, update, { upsert: true, returnDocument: "after" });
    let doc;
    try {
        doc = await upsert();
    } catch (e) {
        if (e?.code !== 11000) throw e;
        doc = await upsert(); // do login ek saath: dusra ab update karega
    }
    return tokenPayload(user, raw, doc.expiresAt);
};

/**
 * Refresh token se naye tokens. Naya document nahi banta, wahi document update hota hai.
 * User check (exists, verified) caller karta hai loadUser se.
 * Return: { tokens, user } ya { status, message }
 */
const rotateTokens = async (raw, loadUser, req) => {
    if (!raw || typeof raw !== "string") return { status: 400, message: "Refresh token is required." };
    const hash = hashToken(raw);
    const now = new Date();

    const current = await RefreshToken.findOne({ tokenHash: hash });
    if (!current) {
        // Pichhla (already refresh ho chuka) token dobara aaya
        const old = await RefreshToken.findOne({ previousTokenHash: hash, revokedAt: null });
        // 30 sec ke andar = app ke do request ek saath (sirf mana). Baad mein = chori ka shak, ye login band.
        if (old && !(old.rotatedAt && now - old.rotatedAt < REUSE_GRACE_SECONDS * 1000)) {
            await RefreshToken.updateOne({ _id: old._id }, { $set: { revokedAt: now, revokedReason: "reuse" } });
        }
        return SESSION_EXPIRED;
    }
    if (current.revokedAt || current.expiresAt <= now) return SESSION_EXPIRED;

    const user = await loadUser(current.userId);
    if (!user) return SESSION_EXPIRED;

    // Isi document mein naya token (atomic: do request ek saath aaye toh sirf ek jeetega)
    const nextRaw = newRawToken();
    const updated = await RefreshToken.findOneAndUpdate(
        { _id: current._id, tokenHash: hash, revokedAt: null },
        {
            $set: {
                tokenHash: hashToken(nextRaw),
                previousTokenHash: hash,
                rotatedAt: now,
                expiresAt: newExpiry(),
                ...clientMeta(req),
            },
        },
        { returnDocument: "after" }
    );
    if (!updated) return SESSION_EXPIRED;
    return { user, tokens: tokenPayload(user, nextRaw, updated.expiresAt) };
};

// Logout: is login ka document hata do. allDevices = user ke saare logins
const revokeTokens = async (raw, { allDevices = false } = {}) => {
    const current = raw ? await RefreshToken.findOne({ tokenHash: hashToken(raw) }) : null;
    if (!current) return false;
    await RefreshToken.deleteMany(allDevices ? { userId: current.userId } : { _id: current._id });
    return true;
};

module.exports = { ACCESS_TOKEN_MINUTES, REFRESH_TOKEN_DAYS, createAccessToken, issueTokens, rotateTokens, revokeTokens };
