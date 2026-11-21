const { buildSchedule, round } = require("./paymentStatus");
const { chargeCategory } = require("../models/Charge");
const { playerSummary } = require("./chargeFormat");

// Bills se asli lene-dene (transactions) ki list: paisa aaya ya gaya.
//   payment      ek baar pura pay (card / cash / bank) ya Standing Order ki pehli kisht
//   installment  Standing Order ki baad wali kisht (Tranzila ne har mahine kaati)
//   refund       club ne paisa lautaya (Tranzila se ya manual)
// Unpaid / cancelled bill ka koi transaction nahi.

// Charge.find() mein ye fields chahiye
const TRANSACTION_FIELDS =
    "clubId playerId invoiceNumber title season category items currency plan status amount paidAt method card providerTxnId authNumber standingOrder refunds refundedAmount";

const cardOf = (charge) => (charge.card?.last4 ? { last4: charge.card.last4, brand: charge.card.brand || "" } : null);

// Ek bill ke saare transactions (naye pehle nahi, bill ke andar kram se)
const transactionsOf = (charge) => {
    const base = {
        chargeId: charge._id,
        invoiceNumber: charge.invoiceNumber,
        title: charge.title,
        category: chargeCategory(charge), // subscription | jersey | camp | other
        season: charge.season,
        currency: charge.currency,
        player: playerSummary(charge.playerId),
    };
    const out = [];
    const id = (suffix) => `${charge._id}-${suffix}`;

    if (charge.plan === "standing_order" && charge.standingOrder) {
        const total = charge.standingOrder.installments;
        buildSchedule(charge)
            .filter((s) => s.status === "paid")
            .forEach((s) => {
                const first = s.number === 1;
                out.push({
                    _id: id(`p${s.number}`),
                    type: first ? "payment" : "installment",
                    date: first ? charge.paidAt || s.chargeDate : s.chargeDate,
                    amount: round(s.amount),
                    installment: { number: s.number, of: total, periodStart: s.periodStart, periodEnd: s.periodEnd },
                    method: "standing_order",
                    card: cardOf(charge),
                    providerTxnId: first ? charge.providerTxnId || "" : "",
                    ...base,
                });
            });
    } else if (charge.paidAt) {
        out.push({
            _id: id("p1"),
            type: "payment",
            date: charge.paidAt,
            amount: round(charge.amount),
            installment: null,
            method: charge.method || "", // card | saved_card | cash | bank_transfer | check | other
            card: cardOf(charge),
            providerTxnId: charge.providerTxnId || "",
            ...base,
        });
    }

    (charge.refunds || []).forEach((r, i) => {
        out.push({
            _id: id(`r${i + 1}`),
            type: "refund",
            date: r.at,
            amount: round(r.amount), // hamesha positive, type "refund" se pata chalta hai paisa gaya
            installment: null,
            method: r.manual ? "manual" : "card",
            card: r.manual ? null : cardOf(charge),
            providerTxnId: r.providerTxnId || "",
            reason: r.reason || "",
            ...base,
        });
    });

    // Receipt: Tranzila card / Standing Order payment ki banata hai (cash / manual ki nahi)
    const receiptAvailable = ["paid", "refunded"].includes(charge.status) && ["card", "standing_order", "saved_card"].includes(charge.method);
    return out.map((t) => ({ ...t, receiptAvailable: t.type !== "refund" && receiptAvailable }));
};

/**
 * Bahut saare bills -> transactions, filter + naye pehle + pagination
 * filters: { type?: payment | installment | refund, from?: Date, to?: Date }
 */
const listTransactions = (charges, { type, from, to, page = 1, limit = 20 } = {}) => {
    let all = charges.flatMap(transactionsOf);
    if (type) all = all.filter((t) => t.type === type);
    if (from) all = all.filter((t) => new Date(t.date) >= from);
    if (to) all = all.filter((t) => new Date(t.date) <= to);
    all.sort((a, b) => new Date(b.date) - new Date(a.date));

    const paid = round(all.filter((t) => t.type !== "refund").reduce((s, t) => s + t.amount, 0));
    const refunded = round(all.filter((t) => t.type === "refund").reduce((s, t) => s + t.amount, 0));
    const start = (page - 1) * limit;
    return {
        transactions: all.slice(start, start + limit),
        totals: { paid, refunded, net: round(paid - refunded), count: all.length },
        pagination: { page, limit, total: all.length, totalPages: Math.ceil(all.length / limit) },
    };
};

// Jin bills mein koi lena-dena hua (paid / Standing Order / refund)
const MONEY_FILTER = { $or: [{ paidAt: { $ne: null } }, { "refunds.0": { $exists: true } }, { plan: "standing_order", "standingOrder.lastChargeDate": { $ne: null } }] };

module.exports = { transactionsOf, listTransactions, TRANSACTION_FIELDS, MONEY_FILTER };
