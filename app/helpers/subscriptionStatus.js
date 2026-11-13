// Player ka saal ka subscription active hai ya nahi (youth player list / detail ke liye).
// Subscription = "season_registration" item wala bill. Sabse naye season ka bill dekhte hain.
//   active   = bill paid (Standing Order mein pehli kisht aa gayi aur koi kisht chhooti nahi)
//   inactive = bill nahi bana / unpaid / pending / overdue / refunded
const Charge = require("../models/Charge");
const { chargeBadge, amounts } = require("./paymentStatus");

const NO_SUBSCRIPTION = {
    status: "inactive",
    badge: "none", // paid | unpaid | overdue | pending | refunded | none (bill hi nahi)
    season: "",
    chargeId: null,
    amount: 0,
    currency: "ILS",
    plan: "",
    paidAt: null,
    outstandingAmount: 0,
};

const formatSubscription = (charge) => {
    if (!charge) return { ...NO_SUBSCRIPTION };
    const badge = chargeBadge(charge);
    return {
        status: badge === "paid" ? "active" : "inactive",
        badge,
        season: charge.season,
        chargeId: charge._id,
        amount: charge.amount,
        currency: charge.currency,
        plan: charge.status === "paid" ? charge.plan : "", // one_time | standing_order
        paidAt: charge.paidAt,
        outstandingAmount: amounts(charge).outstanding,
    };
};

// playerIds -> Map(playerId string -> subscription)
const subscriptionsFor = async (playerIds) => {
    const map = new Map();
    if (!playerIds.length) return map;
    const charges = await Charge.find({
        playerId: { $in: playerIds },
        "items.type": "season_registration",
        status: { $ne: "cancelled" },
    }).sort({ season: -1, createdAt: -1 });
    // Har player ka sabse naye season ka (sort ki wajah se pehla wala)
    charges.forEach((c) => {
        const key = String(c.playerId);
        if (!map.has(key)) map.set(key, c);
    });
    return new Map([...map].map(([k, c]) => [k, formatSubscription(c)]));
};

// formatted players [{ _id, ... }] mein "subscription" jodna
const withSubscriptions = async (players) => {
    const map = await subscriptionsFor(players.map((p) => p._id));
    return players.map((p) => ({ ...p, subscription: map.get(String(p._id)) || { ...NO_SUBSCRIPTION } }));
};

module.exports = { subscriptionsFor, withSubscriptions, formatSubscription };
