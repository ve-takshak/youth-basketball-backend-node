// Player ka saal ka subscription active hai ya nahi + kitna dena hai (player list / detail ke liye).
// Subscription = "season_registration" item wala bill. Sabse naye season ka bill dekhte hain.
//   active   = bill paid (Standing Order mein pehli kisht aa gayi aur koi kisht chhooti nahi)
//   inactive = bill nahi bana / unpaid / pending / overdue / refunded
// Bill nahi bana toh amount chalu season ke Fee Plan se (source "plan") - sirf dikhane ke liye, bill nahi banta.
const Charge = require("../models/Charge");
const FeePlan = require("../models/FeePlan");
const Player = require("../models/Player");
const { chargeBadge, amounts } = require("./paymentStatus");
const { currentSeason } = require("./season");

const round = (n) => Math.round(n * 100) / 100;

const NO_SUBSCRIPTION = {
    status: "inactive",
    badge: "none", // paid | unpaid | overdue | pending | refunded | none (bill hi nahi)
    source: "none", // bill | plan (bill nahi, Fee Plan se andaza) | none
    season: "",
    chargeId: null,
    amount: 0, // kul (subscription + jersey)
    subscriptionAmount: 0,
    jerseyAmount: 0,
    paidAmount: 0,
    outstandingAmount: 0,
    months: 0, // kitne mahine ki fee (12 = poora saal)
    currency: "ILS",
    plan: "",
    paidAt: null,
    noBillReason: null, // bill nahi: no_plan | no_team | no_fee
};

const sumOf = (items, type) => round((items || []).filter((i) => i.type === type).reduce((s, i) => s + (i.amount || 0), 0));

const formatSubscription = (charge) => {
    if (!charge) return { ...NO_SUBSCRIPTION };
    const badge = chargeBadge(charge);
    const { outstanding } = amounts(charge);
    const subItem = (charge.items || []).find((i) => i.type === "season_registration");
    const months = Number((subItem?.name || "").match(/\((\d+) of 12 months\)/)?.[1]) || 12;
    return {
        ...NO_SUBSCRIPTION,
        status: badge === "paid" ? "active" : "inactive",
        badge,
        source: "bill",
        season: charge.season,
        chargeId: charge._id,
        amount: charge.amount,
        subscriptionAmount: sumOf(charge.items, "season_registration"),
        jerseyAmount: sumOf(charge.items, "jersey"),
        paidAmount: round(charge.amount - outstanding),
        outstandingAmount: outstanding,
        months,
        currency: charge.currency,
        plan: charge.status === "paid" ? charge.plan : "", // one_time | standing_order
        paidAt: charge.paidAt,
    };
};

// Bill nahi: chalu season ka Fee Plan + team ka age group + registration date se kitna banega
const plannedFor = async (playerIds) => {
    const map = new Map();
    if (!playerIds.length) return map;
    const season = currentSeason();
    const players = await Player.find({ _id: { $in: playerIds } })
        .select("clubId teamId createdAt")
        .populate({ path: "teamId", select: "categoryId" });
    const plans = await FeePlan.find({ clubId: { $in: [...new Set(players.map((p) => String(p.clubId)))] }, season, isActive: true }).sort({ createdAt: -1 });
    const planByClub = new Map();
    plans.forEach((p) => !planByClub.has(String(p.clubId)) && planByClub.set(String(p.clubId), p));

    players.forEach((player) => {
        const plan = planByClub.get(String(player.clubId));
        const base = { ...NO_SUBSCRIPTION, season };
        if (!plan) return map.set(String(player._id), { ...base, noBillReason: "no_plan" });
        const categoryId = player.teamId?.categoryId || null;
        if (plan.pricingMode === "per_age_group" && !categoryId) {
            return map.set(String(player._id), { ...base, currency: plan.currency, noBillReason: "no_team" });
        }
        const q = plan.quoteFor(categoryId, player.createdAt || new Date());
        if (!(q.annualFee > 0)) return map.set(String(player._id), { ...base, currency: plan.currency, noBillReason: "no_fee" });
        map.set(String(player._id), {
            ...base,
            source: "plan",
            amount: q.total,
            subscriptionAmount: q.subscription,
            jerseyAmount: q.jersey,
            outstandingAmount: q.total,
            months: q.months,
            currency: plan.currency,
        });
    });
    return map;
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
        if (!map.has(key)) map.set(key, formatSubscription(c));
    });
    const missing = playerIds.filter((id) => !map.has(String(id)));
    (await plannedFor(missing)).forEach((value, key) => map.set(key, value));
    return map;
};

// formatted players [{ _id, ... }] mein "subscription" jodna
const withSubscriptions = async (players) => {
    const map = await subscriptionsFor(players.map((p) => p._id));
    return players.map((p) => ({ ...p, subscription: map.get(String(p._id)) || { ...NO_SUBSCRIPTION } }));
};

module.exports = { subscriptionsFor, withSubscriptions, formatSubscription };
