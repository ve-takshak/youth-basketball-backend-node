const mongoose = require("../../config/database");

// Login ka refresh token. Asli token kabhi save nahi hota, sirf uska sha256 hash.
// Har refresh pe naya token banta hai (purana revoked, replacedBy naya). Ek login = ek familyId.
// Revoked token dobara aaye (chori ka shak) toh us family ke saare tokens band.
const RefreshTokenSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        tokenHash: { type: String, required: true, unique: true },
        familyId: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        revokedAt: { type: Date, default: null },
        revokedReason: { type: String, default: "" }, // rotated | logout | reuse | logout_all
        replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: "RefreshToken", default: null },
        device_type: { type: String, default: "" },
        ip: { type: String, default: "" },
        userAgent: { type: String, default: "" },
    },
    { timestamps: true }
);

RefreshTokenSchema.index({ userId: 1, revokedAt: 1 });
RefreshTokenSchema.index({ familyId: 1 });
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // expire hone pe Mongo khud hata deta hai

module.exports = mongoose.model("RefreshToken", RefreshTokenSchema);
