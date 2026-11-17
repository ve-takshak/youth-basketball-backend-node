const mongoose = require("../../config/database");

// Login ka refresh token. Ek user + ek device_type (android / ios / web) = ek document. Dobara login = wahi update.
// Asli token kabhi save nahi hota, sirf sha256 hash.
// Refresh pe naya document NAHI banta: isi document mein tokenHash badal jaata hai, purana previousTokenHash mein.
// Purana token dobara aaye (30 sec ke baad) = chori ka shak, ye login band (revokedReason "reuse").
// Logout pe document hata dete hain. Expire hone pe Mongo khud hata deta hai.
const RefreshTokenSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        tokenHash: { type: String, required: true, unique: true }, // abhi wala token
        previousTokenHash: { type: String, default: null }, // pichhla token (reuse pakadne ke liye)
        rotatedAt: { type: Date, default: null }, // aakhri refresh kab hua
        expiresAt: { type: Date, required: true }, // har refresh pe 30 din aage
        revokedAt: { type: Date, default: null },
        revokedReason: { type: String, default: "" }, // reuse
        device_type: { type: String, default: "" },
        ip: { type: String, default: "" },
        userAgent: { type: String, default: "" },
    },
    { timestamps: true }
);

RefreshTokenSchema.index({ userId: 1, device_type: 1 }, { unique: true });
RefreshTokenSchema.index({ previousTokenHash: 1 });
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // expire hone pe Mongo khud hata deta hai

module.exports = mongoose.model("RefreshToken", RefreshTokenSchema);
