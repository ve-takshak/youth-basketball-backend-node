const crypto = require("crypto");
const mongoose = require("../../config/database");
const { PROVIDER_IDS } = require("../payments");

// Har club ka apna payment gateway (Tranzila / Cardcom / PayPlus / HYP) aur uski terminal keys.
// Ek club = ek active gateway. Keys encrypted hain (helpers/secretBox), API kabhi secret wapas nahi bhejti.
const GATEWAY_MODES = ["test", "live"];

const TestCheckSchema = new mongoose.Schema(
    { name: String, ok: Boolean, message: String },
    { _id: false }
);

const PaymentGatewaySchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true, unique: true },
        provider: { type: String, enum: PROVIDER_IDS, required: true },
        mode: { type: String, enum: GATEWAY_MODES, default: "test" },

        // { terminalName: "v1:...", secretKey: "v1:..." } -> har value encrypted
        credentials: { type: Map, of: String, default: {} },

        // false = parents ko "Pay" nahi dikhega (keys rakhi rehti hain)
        isActive: { type: Boolean, default: true },

        // Webhook URL ka secret hissa: /api/payments/webhook/<gatewayId>/<webhookKey>
        // Bina iske koi bhi fake "payment ho gaya" notification bhej sakta tha.
        webhookKey: { type: String, default: () => crypto.randomBytes(24).toString("hex") },

        // Test console ka aakhri result
        lastTest: {
            at: { type: Date, default: null },
            ok: { type: Boolean, default: null },
            message: { type: String, default: "" },
            checks: { type: [TestCheckSchema], default: [] },
        },

        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

const PaymentGateway = mongoose.model("PaymentGateway", PaymentGatewaySchema);
module.exports = PaymentGateway;
module.exports.GATEWAY_MODES = GATEWAY_MODES;
