// Mobile app / admin ke badge: paid | unpaid | overdue | pending (aur "none" = koi bill nahi)
// DB ka status + dueDate + checkout time + Standing Order sync se nikalta hai, isliye koi cron nahi chahiye.
const { UPFRONT_ITEM_TYPES } = require("../models/Charge");

// Checkout khola par itni der mein result nahi aaya = parent ne chhod diya, wapas unpaid/overdue
const PENDING_TIMEOUT_MINUTES = 30;

const round = (n) => Math.round(Number(n) * 100) / 100;

const startOfDay = (date = new Date()) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};

// 31 Jan + 1 = 28/29 Feb (3 March nahi): mahine ke aakhri din pe rukta hai
const addMonths = (date, months) => {
    const d = new Date(date);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
};

/**
 * Standing Order ka plan: pehli kisht mein upfront items (jersey) + mahine ki kisht.
 * season fee / installments = monthlyAmount (paise ka farak aakhri kisht mein nahi, pehli mein).
 */
const splitPlan = (items, installments) => {
    const upfront = round(items.filter((i) => UPFRONT_ITEM_TYPES.includes(i.type)).reduce((s, i) => s + i.amount, 0));
    const spread = round(items.filter((i) => !UPFRONT_ITEM_TYPES.includes(i.type)).reduce((s, i) => s + i.amount, 0));
    const monthly = Math.floor((spread / installments) * 100) / 100;
    const remainder = round(spread - monthly * installments);
    return { upfront, spread, monthlyAmount: monthly, firstAmount: round(upfront + monthly + remainder) };
};

/**
 * Standing Order ki har kisht: { number, amount, chargeDate, periodStart, periodEnd, status }
 * status: paid | upcoming | missed | cancelled
 */
const buildSchedule = (charge) => {
    const so = charge.standingOrder;
    if (charge.plan !== "standing_order" || !so) return [];

    const today = startOfDay();
    const lastCharged = so.lastChargeDate ? startOfDay(so.lastChargeDate) : null;
    const stopped = so.stoStatus === "inactive";
    const paidOnce = ["paid", "refunded"].includes(charge.status);

    return Array.from({ length: so.installments }, (_, index) => {
        const chargeDate = index === 0 ? so.firstChargeDate : addMonths(so.recurStartDate, index - 1);
        const day = startOfDay(chargeDate);

        let status;
        if (index === 0) status = paidOnce ? "paid" : "upcoming";
        else if (lastCharged && day <= lastCharged) status = "paid";
        else if (stopped) status = "cancelled";
        else if (day < today && (!lastCharged || day > lastCharged)) status = "missed";
        else status = "upcoming";

        const periodEnd = addMonths(day, 1);
        periodEnd.setDate(periodEnd.getDate() - 1);

        return {
            number: index + 1,
            amount: index === 0 ? so.firstAmount : so.monthlyAmount,
            chargeDate: day,
            periodStart: day,
            periodEnd,
            status,
        };
    });
};

// Ek bill ka badge. refunded / cancelled ka koi badge nahi (wo ginti mein nahi aate).
const chargeBadge = (charge, now = new Date()) => {
    if (charge.status === "refunded" || charge.status === "cancelled") return charge.status;

    if (charge.status === "paid") {
        // Standing Order: koi kisht chhoot gayi toh overdue
        if (charge.plan === "standing_order" && buildSchedule(charge).some((i) => i.status === "missed")) return "overdue";
        return "paid";
    }

    if (charge.status === "pending" && charge.checkoutStartedAt) {
        const age = (now - new Date(charge.checkoutStartedAt)) / 60000;
        if (age < PENDING_TIMEOUT_MINUTES) return "pending";
    }

    if (charge.dueDate && new Date(charge.dueDate) < startOfDay(now)) return "overdue";
    return "unpaid";
};

// Player ke saare bills ka ek badge: overdue > pending > unpaid > paid
const playerBadge = (charges = []) => {
    const badges = charges.map((c) => chargeBadge(c)).filter((b) => !["refunded", "cancelled"].includes(b));
    if (!badges.length) return "none";
    for (const badge of ["overdue", "pending", "unpaid"]) {
        if (badges.includes(badge)) return badge;
    }
    return "paid";
};

// Jersey ka paisa aa gaya? (Standing Order mein pehli kisht ke saath hi aata hai)
// null = is bill mein jersey hai hi nahi
const jerseyPaid = (charge) => {
    if (!charge.items.some((i) => i.type === "jersey")) return null;
    return charge.status === "paid";
};

// Kitna paisa aa chuka / kitna baaki
const amounts = (charge) => {
    const badge = chargeBadge(charge);
    if (["refunded", "cancelled"].includes(badge)) return { paid: 0, outstanding: 0 };
    if (charge.status !== "paid") return { paid: 0, outstanding: round(charge.amount) };

    if (charge.plan === "standing_order") {
        const schedule = buildSchedule(charge);
        const paid = round(schedule.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount, 0));
        const outstanding = round(schedule.filter((i) => ["upcoming", "missed"].includes(i.status)).reduce((s, i) => s + i.amount, 0));
        return { paid: round(paid - (charge.refundedAmount || 0)), outstanding };
    }
    return { paid: round(charge.amount - (charge.refundedAmount || 0)), outstanding: 0 };
};

module.exports = {
    chargeBadge,
    playerBadge,
    jerseyPaid,
    amounts,
    splitPlan,
    buildSchedule,
    addMonths,
    startOfDay,
    round,
    PENDING_TIMEOUT_MINUTES,
};
