const mongoose = require("../../config/database");
const { CURRENCIES } = require("./Charge");

// Club ka saal ka Fee Plan (Subscription Plan screen). Ek club + season ka ek hi chalu plan.
//   pricingMode "same"          -> subscriptionAmount sab age groups ke liye
//   pricingMode "per_age_group" -> ageGroups: har age group (team category) ki alag fee
//   jerseyAmount                -> sabke liye (0 = jersey ka paisa nahi)
// Bill banate waqt (POST /user/payments/charges/issue) player ki team ki category se uski fee nikalti hai.
// Plan badalne se pehle bane bills nahi badalte (bill mein items copy hote hain).
const PRICING_MODES = ["same", "per_age_group"];

const AgeGroupFeeSchema = new mongoose.Schema(
    {
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "TeamCategory", required: true },
        amount: { type: Number, min: 0, default: 0 }, // saal ki subscription (0 = is group ki fee nahi)
    },
    { _id: false }
);

const FeePlanSchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        name: { type: String, trim: true, required: true }, // "Annual subscription 2026 / 2027" -> bill ka title bhi
        season: { type: String, trim: true, default: "" },
        pricingMode: { type: String, enum: PRICING_MODES, default: "same" },
        subscriptionAmount: { type: Number, min: 0, default: 0 }, // "same" mode ki fee
        ageGroups: { type: [AgeGroupFeeSchema], default: [] }, // "per_age_group" mode ki fees
        jerseyAmount: { type: Number, min: 0, default: 0 },
        currency: { type: String, enum: CURRENCIES, default: "ILS" },
        dueDate: { type: Date, default: null },
        isActive: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

FeePlanSchema.index({ clubId: 1, season: 1, isActive: 1 });

// Is age group (category) ki saal ki fee. "same" mode mein sabki ek.
FeePlanSchema.methods.subscriptionFor = function (categoryId) {
    if (this.pricingMode === "same") return this.subscriptionAmount || 0;
    if (!categoryId) return 0;
    const group = (this.ageGroups || []).find((g) => String(g.categoryId) === String(categoryId));
    return group ? group.amount : 0;
};

// Bill ke items is age group ke liye. null = is group ki fee set nahi (bill nahi banega).
FeePlanSchema.methods.itemsFor = function (categoryId, categoryName = "") {
    const fee = this.subscriptionFor(categoryId);
    if (!(fee > 0)) return null;
    return [
        { type: "season_registration", name: categoryName ? `Annual subscription - ${categoryName}` : "Annual subscription", amount: fee },
        ...(this.jerseyAmount > 0 ? [{ type: "jersey", name: "Jersey", amount: this.jerseyAmount }] : []),
    ];
};

module.exports = mongoose.model("FeePlan", FeePlanSchema);
module.exports.PRICING_MODES = PRICING_MODES;
