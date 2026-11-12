const { chargeBadge, jerseyPaid, amounts, buildSchedule } = require("./paymentStatus");

// Charge ko admin / parent / coach sab jagah ek hi shape mein bhejna.

// Charge.find().populate(PLAYER_POPULATE)
const PLAYER_POPULATE = {
    path: "playerId",
    select: "userId teamId season registrationNumber parents",
    populate: [
        { path: "userId", select: "firstname lastname profile_image" },
        { path: "teamId", select: "name season coachId" },
    ],
};

const playerSummary = (player) => {
    if (!player || !player._id) return null;
    return {
        _id: player._id,
        firstname: player.userId?.firstname || "",
        lastname: player.userId?.lastname || "",
        profile_image: player.userId?.profile_image || "",
        registrationNumber: player.registrationNumber || "",
        team: player.teamId && player.teamId._id ? { _id: player.teamId._id, name: player.teamId.name } : null,
    };
};

/**
 * options.events = true -> gateway log bhi (sirf admin)
 */
const formatCharge = (charge, options = {}) => {
    const money = amounts(charge);
    const so = charge.standingOrder;

    return {
        _id: charge._id,
        invoiceNumber: charge.invoiceNumber,
        title: charge.title,
        season: charge.season,
        feePlanId: charge.feePlanId || null,
        customAmount: Boolean(charge.customAmount),
        player: playerSummary(charge.playerId),
        items: charge.items.map((i) => ({ _id: i._id, type: i.type, name: i.name, amount: i.amount })),
        amount: charge.amount,
        currency: charge.currency,
        dueDate: charge.dueDate,

        // App ka badge: paid | unpaid | overdue | pending (refunded / cancelled bhi)
        badge: chargeBadge(charge),
        status: charge.status,
        jerseyPaid: jerseyPaid(charge), // null = is bill mein jersey nahi
        paidAmount: money.paid,
        outstandingAmount: money.outstanding,

        plan: charge.plan,
        standingOrder:
            charge.plan === "standing_order" && so
                ? {
                      installments: so.installments,
                      firstAmount: so.firstAmount,
                      monthlyAmount: so.monthlyAmount,
                      status: so.stoStatus || "",
                      nextChargeDate: so.nextChargeDate,
                      lastChargeDate: so.lastChargeDate,
                      // Har kisht: amount, kab katega, kaunsa period cover karti hai, status
                      schedule: buildSchedule(charge),
                  }
                : null,

        paidAt: charge.paidAt,
        method: charge.method,
        card: charge.card?.last4 ? { last4: charge.card.last4, brand: charge.card.brand } : null,
        refundedAmount: charge.refundedAmount || 0,
        refunds: (charge.refunds || []).map((r) => ({ amount: r.amount, reason: r.reason, manual: r.manual, at: r.at })),
        receiptAvailable: charge.status === "paid" || charge.status === "refunded",
        lastReminderAt: charge.lastReminderAt,
        notes: options.events ? charge.notes : undefined,
        events: options.events ? charge.events || [] : undefined,
        createdAt: charge.createdAt,
        updatedAt: charge.updatedAt,
    };
};

module.exports = { formatCharge, playerSummary, PLAYER_POPULATE };
