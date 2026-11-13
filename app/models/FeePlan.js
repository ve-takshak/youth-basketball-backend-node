const mongoose = require("../../config/database");
const { CURRENCIES } = require("./Charge");
const { monthsLeftInSeason, SEASON_MONTHS } = require("../helpers/season");

const round = (n) => Math.round(n * 100) / 100;

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
        // true: season ke beech mein join kare toh bache mahino ki fee (1200 saal, Nov mein join -> 9 mahine -> 900). Jersey poori.
        proRate: { type: Boolean, default: true },
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

// Is age group + join date ka hisaab. proRate on: saal ki fee / 12 x bache mahine (join wala mahina bhi).
// Saal 1200, Nov 2026 mein join ("2026 / 2027") -> 9 mahine x 100 = 900. Jersey hamesha poori.
FeePlanSchema.methods.quoteFor = function (categoryId, joinDate = new Date()) {
    const annualFee = this.subscriptionFor(categoryId) || 0;
    const months = this.proRate === false ? SEASON_MONTHS : monthsLeftInSeason(this.season, joinDate);
    const subscription = months < SEASON_MONTHS ? round((annualFee * months) / SEASON_MONTHS) : annualFee;
    const jersey = annualFee > 0 ? this.jerseyAmount || 0 : 0;
    return {
        annualFee,
        monthlyRate: round(annualFee / SEASON_MONTHS),
        months, // kitne mahine ka paisa (12 = poora saal)
        proRated: months < SEASON_MONTHS,
        subscription,
        jersey,
        total: annualFee > 0 ? round(subscription + jersey) : 0,
    };
};

// Bill ke items is age group ke liye. null = is group ki fee set nahi (bill nahi banega).
FeePlanSchema.methods.itemsFor = function (categoryId, categoryName = "", joinDate = new Date()) {
    const quote = this.quoteFor(categoryId, joinDate);
    if (!(quote.annualFee > 0)) return null;
    const name = categoryName ? `Annual subscription - ${categoryName}` : "Annual subscription";
    return [
        { type: "season_registration", name: quote.proRated ? `${name} (${quote.months} of ${SEASON_MONTHS} months)` : name, amount: quote.subscription },
        ...(quote.jersey > 0 ? [{ type: "jersey", name: "Jersey", amount: quote.jersey }] : []),
    ];
};

module.exports = mongoose.model("FeePlan", FeePlanSchema);
module.exports.PRICING_MODES = PRICING_MODES;
