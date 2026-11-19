const mongoose = require("../../config/database");
const { CURRENCIES } = require("./Charge");
const { monthsLeftInSeason, seasonEnd, SEASON_MONTHS } = require("../helpers/season");

const round = (n) => Math.round(n * 100) / 100;

// Club ka saal ka Fee Plan (Subscription Plan screen). Ek club + season ka ek hi chalu plan.
//   pricingMode "same"          -> subscriptionAmount sab age groups ke liye
//   pricingMode "per_age_group" -> ageGroups: har age group (team category) ki alag fee
//   jerseyAmount                -> "same" mode mein sabki jersey (0 = jersey ka paisa nahi). per_age_group mein har group ki apni.
// Bill banate waqt (POST /user/payments/charges/issue) player ki team ki category se uski fee nikalti hai.
// Plan badalne se pehle bane bills nahi badalte (bill mein items copy hote hain).
const PRICING_MODES = ["same", "per_age_group"];
// Parent kaise pay kar sakta hai: ek baar | har mahine (Standing Order) | dono
const PAYMENT_OPTIONS = ["one_time", "standing_order", "both"];
// Product / subscription type:
//   yearly    saal ki fee: ek baar (quit kare toh refund request) ya monthly kisht (owner aage ki band kar sakta hai)
//   seasonal  seasonal training, sirf monthly (Standing Order). Band karna sirf club owner ke haath mein.
//   camp      chhota camp (jaise 7 din), sirf ek baar. Beech mein chhode toh bache dino ka refund request.
// Season mein ek hi chalu yearly/seasonal plan (auto bill isi se). Camps jitne chahe.
const PRODUCT_TYPES = ["yearly", "seasonal", "camp"];
const SUBSCRIPTION_PRODUCTS = ["yearly", "seasonal"];
// Type ke hisaab se paymentOptions fix: seasonal = monthly, camp = ek baar
const FORCED_PAYMENT_OPTIONS = { seasonal: "standing_order", camp: "one_time" };
const DEFAULT_CAMP_DAYS = 7;

// Plan ki setting mein ye tareeka chalta hai? method: "one_time" | "standing_order". Plan nahi / purana = both.
const planAllows = (paymentOptions, method) => {
    const value = PAYMENT_OPTIONS.includes(paymentOptions) ? paymentOptions : "both";
    return value === "both" || value === method;
};

/**
 * Bill kaise pay ho sakta hai: plan ka paymentOptions + club ki paymentSettings (allowStandingOrder, maxInstallments).
 * Plan nahi (haath ka bill) = sirf club setting. Club ne monthly band kiya aur plan "sirf monthly" ho toh ek baar khula (warna pay hi na ho).
 * Return { oneTime, standingOrder, paymentOptions: one_time | standing_order | both }
 */
const allowedMethods = (planOptions, settings = {}) => {
    const clubMonthly = settings.allowStandingOrder !== false && (settings.maxInstallments || 10) >= 2;
    let oneTime = planAllows(planOptions, "one_time");
    const standingOrder = clubMonthly && planAllows(planOptions, "standing_order");
    if (!oneTime && !standingOrder) oneTime = true;
    return { oneTime, standingOrder, paymentOptions: oneTime && standingOrder ? "both" : oneTime ? "one_time" : "standing_order" };
};

const AgeGroupFeeSchema = new mongoose.Schema(
    {
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "TeamCategory", required: true },
        amount: { type: Number, min: 0, default: 0 }, // saal ki subscription (0 = is group ki fee nahi)
        // Is age group ki jersey (0 = jersey nahi), amount jaisi. null = sirf purane plan, plan ki jerseyAmount chalegi.
        jerseyAmount: { type: Number, min: 0, default: null },
    },
    { _id: false }
);

const FeePlanSchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        name: { type: String, trim: true, required: true }, // "Annual subscription 2026 / 2027" -> bill ka title bhi
        season: { type: String, trim: true, default: "" },
        productType: { type: String, enum: PRODUCT_TYPES, default: "yearly" },
        // Sirf camp: kab shuru aur kitne din (refund bache dino ke hisaab se). Fee = subscriptionAmount.
        camp: {
            startDate: { type: Date, default: null },
            days: { type: Number, min: 1, max: 60, default: DEFAULT_CAMP_DAYS },
        },
        pricingMode: { type: String, enum: PRICING_MODES, default: "same" },
        subscriptionAmount: { type: Number, min: 0, default: 0 }, // "same" mode ki fee
        ageGroups: { type: [AgeGroupFeeSchema], default: [] }, // "per_age_group" mode ki fees
        // Sirf "same" mode ki jersey (sabki ek). "per_age_group" mein har group ki apni (ageGroups[].jerseyAmount).
        jerseyAmount: { type: Number, min: 0, default: 0 },
        // true: season ke beech mein join kare toh bache mahino ki fee (1200 saal, Nov mein join -> 9 mahine -> 900). Jersey poori.
        proRate: { type: Boolean, default: true },
        // Club admin chunta hai: one_time (sirf ek baar) | standing_order (sirf har mahine) | both
        paymentOptions: { type: String, enum: PAYMENT_OPTIONS, default: "both" },
        currency: { type: String, enum: CURRENCIES, default: "ILS" },
        dueDate: { type: Date, default: null },
        isActive: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

FeePlanSchema.index({ clubId: 1, season: 1, isActive: 1 });

// seasonal = sirf monthly, camp = sirf ek baar (+ camp mein jersey / pro-rate nahi, ek hi fee)
FeePlanSchema.pre("validate", function () {
    const forced = FORCED_PAYMENT_OPTIONS[this.productType];
    if (forced) this.paymentOptions = forced;
    if (this.productType === "camp") {
        this.pricingMode = "same";
        this.jerseyAmount = 0;
        this.proRate = false;
        (this.ageGroups || []).forEach((g) => (g.jerseyAmount = 0));
    }
});

// Camp ke din: start se start + days - 1 tak
FeePlanSchema.methods.campPeriod = function () {
    const start = this.camp?.startDate ? new Date(this.camp.startDate) : null;
    const days = this.camp?.days || DEFAULT_CAMP_DAYS;
    if (!start) return null;
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + days - 1);
    end.setHours(23, 59, 59, 999);
    return { unit: "day", start, end, units: days };
};

// Is age group (category) ki saal ki fee. "same" mode mein sabki ek.
FeePlanSchema.methods.subscriptionFor = function (categoryId) {
    if (this.pricingMode === "same") return this.subscriptionAmount || 0;
    if (!categoryId) return 0;
    const group = (this.ageGroups || []).find((g) => String(g.categoryId) === String(categoryId));
    return group ? group.amount : 0;
};

// Is age group ki jersey. "same" mode = sabki ek (plan ki jerseyAmount).
// "per_age_group" = sirf group ki apni jersey (amount jaisi), group nahi = 0.
// Sirf purane plan (group pe jersey kabhi save hi nahi hui, null) mein plan ki jerseyAmount, taaki purane plan na badlein.
FeePlanSchema.methods.jerseyFor = function (categoryId) {
    if (this.productType === "camp") return 0;
    if (this.pricingMode === "same") return this.jerseyAmount || 0;
    const group = categoryId ? (this.ageGroups || []).find((g) => String(g.categoryId) === String(categoryId)) : null;
    if (!group) return 0;
    if (group.jerseyAmount === null || group.jerseyAmount === undefined) return this.jerseyAmount || 0;
    return group.jerseyAmount;
};

// Is age group + join date ka hisaab. proRate on: saal ki fee / 12 x bache mahine (join wala mahina bhi).
// Saal 1200, Nov 2026 mein join ("2026 / 2027") -> 9 mahine x 100 = 900. Jersey hamesha poori.
FeePlanSchema.methods.quoteFor = function (categoryId, joinDate = new Date()) {
    const annualFee = this.subscriptionFor(categoryId) || 0;
    if (this.productType === "camp") {
        // Camp: poori fee, koi pro-rate / jersey nahi
        return { annualFee, monthlyRate: 0, months: 0, proRated: false, subscription: annualFee, jersey: 0, total: annualFee };
    }
    const months = this.proRate === false ? SEASON_MONTHS : monthsLeftInSeason(this.season, joinDate);
    const subscription = months < SEASON_MONTHS ? round((annualFee * months) / SEASON_MONTHS) : annualFee;
    const jersey = annualFee > 0 ? this.jerseyFor(categoryId) : 0; // age group ke hisaab se
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
    if (this.productType === "camp") return [{ type: "camp", name: this.name || "Camp", amount: quote.subscription }];
    const label = this.productType === "seasonal" ? "Seasonal training" : "Annual subscription";
    const name = categoryName ? `${label} - ${categoryName}` : label;
    return [
        { type: "season_registration", name: quote.proRated ? `${name} (${quote.months} of ${SEASON_MONTHS} months)` : name, amount: quote.subscription },
        ...(quote.jersey > 0 ? [{ type: "jersey", name: "Jersey", amount: quote.jersey }] : []),
    ];
};

/**
 * Is player ke bills: subscription aur jersey ALAG (alag pay, alag Standing Order, alag band).
 * return null (fee nahi) ya [{ category, title, items, servicePeriod }]  -> pehla hamesha subscription / camp
 */
FeePlanSchema.methods.chargesFor = function (categoryId, categoryName = "", joinDate = new Date()) {
    const items = this.itemsFor(categoryId, categoryName, joinDate);
    if (!items) return null;
    if (this.productType === "camp") return [{ category: "camp", title: this.name, items, servicePeriod: this.campPeriod() }];

    const quote = this.quoteFor(categoryId, joinDate);
    const end = seasonEnd(this.season);
    const start = end ? new Date(end.getFullYear(), end.getMonth() - quote.months + 1, 1) : null;
    const out = [
        {
            category: "subscription",
            title: this.name,
            items: items.filter((i) => i.type !== "jersey"),
            servicePeriod: start ? { unit: "month", start, end, units: quote.months } : null,
        },
    ];
    const jersey = items.filter((i) => i.type === "jersey");
    if (jersey.length) out.push({ category: "jersey", title: `${this.name} - Jersey`, items: jersey, servicePeriod: null });
    return out;
};

module.exports = mongoose.model("FeePlan", FeePlanSchema);
module.exports.PRICING_MODES = PRICING_MODES;
module.exports.PRODUCT_TYPES = PRODUCT_TYPES;
module.exports.SUBSCRIPTION_PRODUCTS = SUBSCRIPTION_PRODUCTS;
module.exports.FORCED_PAYMENT_OPTIONS = FORCED_PAYMENT_OPTIONS;
module.exports.DEFAULT_CAMP_DAYS = DEFAULT_CAMP_DAYS;
module.exports.PAYMENT_OPTIONS = PAYMENT_OPTIONS;
module.exports.planAllows = planAllows;
module.exports.allowedMethods = allowedMethods;
