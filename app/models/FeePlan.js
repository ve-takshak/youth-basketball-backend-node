const mongoose = require("../../config/database");
const { CHARGE_ITEM_TYPES, CURRENCIES } = require("./Charge");

// Club ki price list. Club admin ek baar set karta hai: "Season 2026 / 2027 - U14" = season fee 2400 + jersey 400.
// Bill banate waqt (POST /user/payments/charges/issue) sirf feePlanId bhejo, items / amount yahin se aate hain.
// Plan badalne se pehle bane bills nahi badalte (bill mein items copy hote hain).
//
// teamIds khaali = club ki saari teams ke liye.
const FeePlanItemSchema = new mongoose.Schema(
    {
        type: { type: String, enum: CHARGE_ITEM_TYPES, default: "other" },
        name: { type: String, trim: true, required: true },
        amount: { type: Number, min: 0, required: true },
    },
    { _id: true }
);

const FeePlanSchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        name: { type: String, trim: true, required: true }, // "Season registration 2026 / 2027" -> bill ka title bhi
        season: { type: String, trim: true, default: "" },
        teamIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Team" }], default: [] },
        items: { type: [FeePlanItemSchema], validate: (v) => v.length > 0 },
        amount: { type: Number, min: 0, required: true }, // items ka total
        currency: { type: String, enum: CURRENCIES, default: "ILS" },
        dueDate: { type: Date, default: null },
        isActive: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

FeePlanSchema.index({ clubId: 1, season: 1, isActive: 1 });

module.exports = mongoose.model("FeePlan", FeePlanSchema);
