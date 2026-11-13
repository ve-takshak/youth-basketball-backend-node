// Parent app khule toh bachche ka is season ka bill apne aap (admin ko "issue" nahi karna padta).
// Club ka chalu season ka Fee Plan + bachche ki team ka age group -> fee (registration date se pro-rated) + jersey.
// Season ka bill pehle se hai (koi bhi status, cancelled bhi) toh naya nahi banta - admin ne cancel kiya toh wapas nahi aata.
// Har player ka result:
//   billed      bill hai (pehle se ya abhi bana)
//   no_plan     club ka is season ka chalu Fee Plan nahi
//   no_team     "per_age_group" plan, par bachcha abhi kisi team mein nahi (coach / admin team de tab bill banega)
//   no_fee      us age group ki fee plan mein 0
//   inactive    player left / inactive
const Charge = require("../models/Charge");
const FeePlan = require("../models/FeePlan");
const Player = require("../models/Player");
const { currentSeason } = require("./season");

const round = (n) => Math.round(n * 100) / 100;
const inFlight = new Set(); // ek hi player ke do request ek saath aayein toh do bill na banein

const ensureSeasonCharges = async (playerIds, season = currentSeason()) => {
    const result = new Map();
    if (!playerIds.length) return result;

    const players = await Player.find({ _id: { $in: playerIds } })
        .select("_id clubId teamId status createdAt")
        .populate({ path: "teamId", select: "categoryId", populate: { path: "categoryId", select: "name" } });

    const clubIds = [...new Set(players.map((p) => String(p.clubId)))];
    const plans = await FeePlan.find({ clubId: { $in: clubIds }, season, isActive: true }).sort({ createdAt: -1 });
    const planByClub = new Map();
    plans.forEach((p) => !planByClub.has(String(p.clubId)) && planByClub.set(String(p.clubId), p));

    const billed = new Set(
        (
            await Charge.find({
                playerId: { $in: players.map((p) => p._id) },
                season,
                $or: [{ "items.type": "season_registration" }, { feePlanId: { $in: plans.map((p) => p._id) } }],
            }).distinct("playerId")
        ).map(String)
    );

    for (const player of players) {
        const key = String(player._id);
        if (billed.has(key)) {
            result.set(key, "billed");
            continue;
        }
        if (["left", "inactive"].includes(player.status)) {
            result.set(key, "inactive");
            continue;
        }
        const plan = planByClub.get(String(player.clubId));
        if (!plan) {
            result.set(key, "no_plan");
            continue;
        }
        const category = player.teamId?.categoryId;
        if (plan.pricingMode === "per_age_group" && !category) {
            result.set(key, "no_team");
            continue;
        }
        const items = plan.itemsFor(category?._id, plan.pricingMode === "per_age_group" ? category?.name : "", player.createdAt || new Date());
        if (!items) {
            result.set(key, "no_fee");
            continue;
        }

        if (inFlight.has(key)) {
            result.set(key, "billed");
            continue;
        }
        inFlight.add(key);
        try {
            // Lock milne tak kisi aur request ne bana diya ho
            const again = await Charge.exists({ playerId: player._id, season, "items.type": "season_registration" });
            if (!again) {
                await Charge.create({
                    clubId: player.clubId,
                    playerId: player._id,
                    season,
                    feePlanId: plan._id,
                    customAmount: false,
                    title: plan.name,
                    items,
                    amount: round(items.reduce((s, i) => s + i.amount, 0)),
                    currency: plan.currency,
                    dueDate: plan.dueDate || null,
                    createdBy: plan.createdBy, // plan banane wala admin
                });
            }
            result.set(key, "billed");
        } finally {
            inFlight.delete(key);
        }
    }
    return result;
};

module.exports = { ensureSeasonCharges };
