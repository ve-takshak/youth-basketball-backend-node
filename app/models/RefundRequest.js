const mongoose = require("../../config/database");

// Parent ka refund request (yearly ek baar pay kiya / camp, beech mein chhoda). Club owner review karta hai:
//   pending   parent ne bheja, owner ne abhi dekha nahi
//   refunded  owner ne approve kiya aur gateway (Tranzila) / manual se paisa lauta diya
//   rejected  owner ne mana kiya (note ke saath)
//   failed    approve kiya par gateway ne refund nahi kiya (owner dobara approve kar sakta hai)
// Ek bill pe ek hi khula (pending / failed) request.
// processing = approve chal raha (gateway call), do baar refund na ho isliye lock
const REFUND_REQUEST_STATUSES = ["pending", "processing", "refunded", "rejected", "failed"];
const OPEN_STATUSES = ["pending", "failed"];

const RefundRequestSchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        chargeId: { type: mongoose.Schema.Types.ObjectId, ref: "Charge", required: true },
        playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
        requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

        reason: { type: String, trim: true, maxlength: 500, default: "" },
        lastDay: { type: Date, required: true }, // player ka aakhri din (isi se bache mahine / din)
        // Request ke waqt ka hisaab (helpers/refundQuote). Owner ko dikhta hai, woh amount badal sakta hai.
        quote: {
            unit: { type: String, default: null }, // month | day
            totalUnits: { type: Number, default: 0 },
            usedUnits: { type: Number, default: 0 },
            remainingUnits: { type: Number, default: 0 },
            serviceAmount: { type: Number, default: 0 },
            suggestedAmount: { type: Number, default: 0 },
        },
        currency: { type: String, default: "ILS" },

        status: { type: String, enum: REFUND_REQUEST_STATUSES, default: "pending" },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        reviewedAt: { type: Date, default: null },
        reviewNote: { type: String, trim: true, maxlength: 500, default: "" },
        refundedAmount: { type: Number, min: 0, default: 0 },
        manual: { type: Boolean, default: false },
        providerTxnId: { type: String, default: "" },
        failureMessage: { type: String, default: "" },
    },
    { timestamps: true }
);

RefundRequestSchema.index({ clubId: 1, status: 1, createdAt: -1 });
RefundRequestSchema.index({ chargeId: 1, status: 1 });

module.exports = mongoose.model("RefundRequest", RefundRequestSchema);
module.exports.REFUND_REQUEST_STATUSES = REFUND_REQUEST_STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
