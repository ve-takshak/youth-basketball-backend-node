// Refund ka hisaab: player ne kitni service li, kitni bachi, kitna lautana banta hai.
//   Yearly (ek baar pay): mahine. 1200 saal ka, 3 mahine baad chhoda -> 9 bache -> 900.
//   Camp: din. 7 din ka 700, 4 din aaya -> 3 bache -> 300.
// Jo mahina / din chal raha hai woh "use hua" gina jaata hai. Jersey kabhi isme nahi (alag bill, refund nahi).
// Ye sirf suggestion hai: club owner approve karte waqt amount badal sakta hai (pura / aadha).
const { chargeCategory } = require("../models/Charge");
const { seasonEnd, SEASON_MONTHS } = require("./season");
const { round, startOfDay } = require("./paymentStatus");

const DAY_MS = 86400000;
const REFUNDABLE_CATEGORIES = ["subscription", "camp"];

// Bill ka service period. Purane bill (servicePeriod nahi): season ke aakhri N mahine (item ke naam se N).
const periodOf = (charge) => {
    const sp = charge.servicePeriod;
    if (sp?.start && sp?.units) return { unit: sp.unit, start: sp.start, end: sp.end, units: sp.units };
    if (chargeCategory(charge) !== "subscription") return null;
    const end = seasonEnd(charge.season);
    if (!end) return null;
    const item = (charge.items || []).find((i) => i.type === "season_registration");
    const months = Number(String(item?.name || "").match(/\((\d+) of 12 months\)/)?.[1]) || SEASON_MONTHS;
    return { unit: "month", start: new Date(end.getFullYear(), end.getMonth() - months + 1, 1), end, units: months };
};

// lastDay tak kitne mahine / din use hue (chalu wala bhi)
const usedUnits = (period, lastDay) => {
    const start = startOfDay(period.start);
    const day = startOfDay(lastDay);
    if (day < start) return 0;
    if (period.unit === "day") return Math.min(period.units, Math.round((day - start) / DAY_MS) + 1);
    const months = (day.getFullYear() - start.getFullYear()) * 12 + (day.getMonth() - start.getMonth()) + 1;
    return Math.min(period.units, months);
};

/**
 * charge: Charge doc. lastDay: player ka aakhri din (default aaj).
 * return { eligible, reason, unit, totalUnits, usedUnits, remainingUnits, serviceAmount, alreadyRefunded, maxRefundable, suggestedAmount }
 */
const refundQuote = (charge, lastDay = new Date()) => {
    const category = chargeCategory(charge);
    const alreadyRefunded = round(charge.refundedAmount || 0);
    const base = {
        eligible: false,
        reason: "",
        category,
        lastDay: startOfDay(lastDay),
        unit: null,
        totalUnits: 0,
        usedUnits: 0,
        remainingUnits: 0,
        serviceAmount: 0,
        alreadyRefunded,
        maxRefundable: 0,
        suggestedAmount: 0,
        currency: charge.currency,
    };

    if (charge.status !== "paid") return { ...base, reason: "Only paid charges can be refunded." };
    if (!REFUNDABLE_CATEGORIES.includes(category)) {
        return { ...base, reason: category === "jersey" ? "Jersey payments are not refunded." : "This charge can't be refunded from a request." };
    }
    if (charge.plan === "standing_order") {
        return { ...base, reason: "This is a monthly plan. The club stops the future monthly payments instead of a refund." };
    }

    const maxRefundable = round(charge.amount - alreadyRefunded);
    const serviceAmount = round((charge.items || []).filter((i) => i.type !== "jersey").reduce((s, i) => s + (i.amount || 0), 0));
    const period = periodOf(charge);
    if (!(maxRefundable > 0)) return { ...base, serviceAmount, reason: "This charge is already fully refunded." };
    if (!period) return { ...base, eligible: true, serviceAmount, maxRefundable }; // period pata nahi: owner khud amount daale

    const used = usedUnits(period, lastDay);
    const remaining = period.units - used;
    const prorated = round((serviceAmount * remaining) / period.units);
    return {
        ...base,
        eligible: true,
        unit: period.unit,
        periodStart: period.start,
        periodEnd: period.end,
        totalUnits: period.units,
        usedUnits: used,
        remainingUnits: remaining,
        serviceAmount,
        maxRefundable,
        suggestedAmount: Math.max(0, Math.min(maxRefundable, round(prorated - alreadyRefunded))),
    };
};

module.exports = { refundQuote, periodOf, usedUnits, REFUNDABLE_CATEGORIES };
