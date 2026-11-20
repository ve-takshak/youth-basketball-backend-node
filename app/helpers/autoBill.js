// Parent app khule toh bachche ka is season ka bill apne aap (admin ko "issue" nahi karna padta).
// Club ka chalu season ka Fee Plan (yearly / seasonal, camp nahi) + bachche ka age group -> fee (registration date se pro-rated) + jersey.
// Age group (helpers/ageGroup): team ki category, warna player ka chuna hua (categoryId), warna date of birth se apne aap.
// Subscription aur jersey ke ALAG bill bante hain (alag pay, alag Standing Order): subscription band ho toh jersey chalta rahe.
// Season ka bill pehle se hai (koi bhi status, cancelled bhi) toh naya nahi banta - admin ne cancel kiya toh wapas nahi aata.
// Har player ka result:
//   billed      bill hai (pehle se ya abhi bana)
//   no_plan     club ka is season ka chalu Fee Plan nahi
//   no_team     "per_age_group" plan, par bachche ka age group nahi nikla (na team, na categoryId, na birth date se)
//   no_fee      us age group ki fee plan mein 0
//   inactive    player left / inactive
//   senior      senior player: club ki season fee (Fee Plan) sirf youth deta hai, senior se nahi
//
// Price hamesha abhi ke plan ka (syncPlanBills): club admin kabhi bhi price badal sakta hai. Jab tak parent ne pay
// shuru nahi kiya, bill plan ke saath badalta rehta hai. Bill ki _id wahi rehti hai (app ke paas jo chargeId hai woh chalta rahe).
const Charge = require("../models/Charge");
const { chargeCategory } = require("../models/Charge");
const FeePlan = require("../models/FeePlan");
const { SUBSCRIPTION_PRODUCTS } = require("../models/FeePlan");
const Player = require("../models/Player");
const { currentSeason } = require("./season");
const { ageGroupsFor } = require("./ageGroup");
const { PENDING_TIMEOUT_MINUTES } = require("./paymentStatus");

const round = (n) => Math.round(n * 100) / 100;
const inFlight = new Set(); // ek hi player ke do request ek saath aayein toh do bill na banein

// Club ka chalu season Fee Plan (yearly / seasonal, camp nahi). Map(clubId -> plan)
const activePlans = async (clubIds, season) => {
    const plans = await FeePlan.find({ clubId: { $in: clubIds }, season, isActive: true, productType: { $in: [...SUBSCRIPTION_PRODUCTS, null] } }).sort({ createdAt: -1 });
    const byClub = new Map();
    plans.forEach((p) => !byClub.has(String(p.clubId)) && byClub.set(String(p.clubId), p));
    return { plans, byClub };
};

// Is player ke kaun se bill bane chahiye (abhi ke plan se). { reason } ya { plan, bills }
const expectedBills = (player, plan, category) => {
    if (["left", "inactive"].includes(player.status)) return { reason: "inactive" };
    if (player.playerType === "senior") return { reason: "senior" };
    if (!plan) return { reason: "no_plan" };
    if (plan.pricingMode === "per_age_group" && !category) return { reason: "no_team" };
    const bills = plan.chargesFor(category?._id, plan.pricingMode === "per_age_group" ? category?.name : "", player.createdAt || new Date());
    if (!bills) return { reason: "no_fee" };
    return { plan, bills };
};

// ---- Plan badla toh bill bhi (sirf jinhe parent ne chhua nahi) ----
const SYNC_CATEGORIES = ["subscription", "jersey"]; // camp / haath ke bill nahi badalte

// Untouched = plan se bana, admin ki custom fee nahi, koi paisa / refund / Standing Order nahi, abhi checkout nahi chal raha
const isUntouched = (c, now = Date.now()) => {
    if (!c.feePlanId || c.customAmount) return false;
    if (c.paidAt || c.refundedAmount > 0 || (c.refunds || []).length || c.standingOrder?.stoId || c.stopped?.at) return false;
    if (["unpaid", "failed"].includes(c.status)) return true;
    // pending: parent ne Tranzila page khola. 30 min tak mat chhedo (Tranzila wahi amount bhejega jo page pe tha)
    if (c.status === "pending") return !c.checkoutStartedAt || (now - new Date(c.checkoutStartedAt)) / 60000 >= PENDING_TIMEOUT_MINUTES;
    return false;
};

// Bill abhi bhi untouched hai tabhi likho (beech mein parent ne checkout khola ho toh kuch nahi)
const untouchedGuard = (c) => ({ _id: c._id, status: c.status, checkoutStartedAt: c.checkoutStartedAt || null, paidAt: null });

const sameBill = (c, bill, plan) =>
    String(c.feePlanId) === String(plan._id) &&
    c.title === bill.title &&
    round(c.amount) === round(bill.items.reduce((s, i) => s + i.amount, 0)) &&
    JSON.stringify((c.items || []).map((i) => [i.type, i.name, round(i.amount)])) === JSON.stringify(bill.items.map((i) => [i.type, i.name, round(i.amount)]));

/**
 * In players ke untouched bills ko abhi ke Fee Plan ke price pe le aao.
 *   price / naam badla -> wahi bill update (same _id)
 *   ab fee nahi (plan hata, age group ki fee 0, senior / inactive) -> untouched bill delete (paisa laga hi nahi)
 *   subscription untouched hai par jersey bill nahi aur plan mein jersey hai -> jersey bill ban jaata hai
 * Paid / Standing Order / abhi pay ho raha / refund / custom fee wale bill kabhi nahi chhedte.
 * Naya bill (season ka koi bill hi nahi) ensureSeasonCharges banata hai.
 * Return: kitne bill badle / hate / bane
 */
const syncPlanBills = async (playerIds, season = currentSeason()) => {
    const out = { updated: 0, removed: 0, created: 0 };
    const ids = (playerIds || []).filter(Boolean);
    if (!ids.length) return out;

    const all = await Charge.find({ playerId: { $in: ids }, season, feePlanId: { $ne: null } }).select(
        "playerId clubId feePlanId customAmount category items amount title status checkoutStartedAt paidAt refundedAmount refunds standingOrder stopped createdBy"
    );
    const untouched = new Map(); // playerId -> Map(category -> [bills])
    const touched = new Map(); // playerId -> Set(category) jinka bill paid / chal raha
    const subscriptionOf = new Map(); // playerId -> subscription bill _id (jersey link ke liye)
    for (const c of all) {
        const cat = chargeCategory(c);
        if (!SYNC_CATEGORIES.includes(cat)) continue;
        const key = String(c.playerId);
        if (cat === "subscription" && !subscriptionOf.has(key)) subscriptionOf.set(key, c._id);
        if (isUntouched(c)) {
            if (!untouched.has(key)) untouched.set(key, new Map());
            const byCat = untouched.get(key);
            byCat.set(cat, [...(byCat.get(cat) || []), c]);
        } else {
            if (!touched.has(key)) touched.set(key, new Set());
            touched.get(key).add(cat);
        }
    }
    if (!untouched.size) return out;

    const players = await Player.find({ _id: { $in: [...untouched.keys()] } }).select("_id clubId status playerType createdAt");
    const groups = await ageGroupsFor(players.map((p) => p._id), season);
    const { byClub } = await activePlans([...new Set(players.map((p) => String(p.clubId)))], season);

    const remove = async (c) => {
        const r = await Charge.deleteOne(untouchedGuard(c));
        out.removed += r.deletedCount || 0;
    };

    for (const player of players) {
        const key = String(player._id);
        const mine = untouched.get(key);
        const done = touched.get(key) || new Set();
        const { plan, bills } = expectedBills(player, byClub.get(String(player.clubId)), groups.get(key));
        const want = new Map((bills || []).map((b) => [b.category, b]));

        for (const cat of SYNC_CATEGORIES) {
            const list = mine.get(cat) || [];
            const target = want.get(cat);
            // Fee nahi rahi, ya isi cheez ka bill pehle se paid / chal raha: untouched wala hata do
            if (!target || done.has(cat)) {
                for (const c of list) await remove(c);
                continue;
            }
            const [keep, ...extra] = list;
            for (const c of extra) await remove(c);

            if (keep) {
                if (sameBill(keep, target, plan)) continue;
                const amount = round(target.items.reduce((s, i) => s + i.amount, 0));
                const r = await Charge.updateOne(untouchedGuard(keep), {
                    $set: {
                        feePlanId: plan._id,
                        category: cat,
                        title: target.title,
                        items: target.items,
                        amount,
                        servicePeriod: target.servicePeriod || null,
                        currency: plan.currency,
                        dueDate: plan.dueDate || null,
                        ...(cat === "jersey" && subscriptionOf.get(key) ? { linkedChargeId: subscriptionOf.get(key) } : {}),
                    },
                    $push: { events: { $each: [{ at: new Date(), kind: "manual", success: true, message: `Price updated from the fee plan: ${keep.amount} -> ${amount}.` }], $slice: -50 } },
                });
                out.updated += r.modifiedCount || 0;
            } else if (mine.size) {
                // Jersey (ya subscription) bill nahi tha aur ab plan mein hai, baaki bill untouched hai: bana do
                const charge = await Charge.create({
                    clubId: player.clubId,
                    playerId: player._id,
                    season,
                    feePlanId: plan._id,
                    customAmount: false,
                    category: cat,
                    linkedChargeId: cat === "jersey" ? subscriptionOf.get(key) || null : null,
                    servicePeriod: target.servicePeriod,
                    title: target.title,
                    items: target.items,
                    amount: round(target.items.reduce((s, i) => s + i.amount, 0)),
                    currency: plan.currency,
                    dueDate: plan.dueDate || null,
                    createdBy: plan.createdBy,
                });
                if (cat === "subscription") subscriptionOf.set(key, charge._id);
                out.created += 1;
            }
        }
    }
    return out;
};

// Plan bana / badla / band hua: us club + season ke saare untouched bills naye price pe
const syncClubSeason = async (clubId, season) => {
    try {
        const playerIds = await Charge.find({ clubId, season, feePlanId: { $ne: null }, status: { $in: ["unpaid", "failed", "pending"] } }).distinct("playerId");
        const out = await syncPlanBills(playerIds, season);
        if (out.updated || out.removed || out.created) console.log(`Fee plan sync ${season}: ${JSON.stringify(out)}`);
        return out;
    } catch (e) {
        console.error("Fee plan sync error:", e.message);
        return null;
    }
};

const ensureSeasonCharges = async (playerIds, season = currentSeason()) => {
    const result = new Map();
    if (!playerIds.length) return result;

    const players = await Player.find({ _id: { $in: playerIds } })
        .select("_id clubId teamId status playerType createdAt");
    const groups = await ageGroupsFor(players.map((p) => p._id), season);

    const { plans, byClub: planByClub } = await activePlans([...new Set(players.map((p) => String(p.clubId)))], season);

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
        const { reason, plan, bills } = expectedBills(player, planByClub.get(String(player.clubId)), groups.get(key));
        if (reason) {
            result.set(key, reason);
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
                let subscriptionId = null;
                for (const bill of bills) {
                    const charge = await Charge.create({
                        clubId: player.clubId,
                        playerId: player._id,
                        season,
                        feePlanId: plan._id,
                        customAmount: false,
                        category: bill.category,
                        linkedChargeId: bill.category === "jersey" ? subscriptionId : null,
                        servicePeriod: bill.servicePeriod,
                        title: bill.title,
                        items: bill.items,
                        amount: round(bill.items.reduce((s, i) => s + i.amount, 0)),
                        currency: plan.currency,
                        dueDate: plan.dueDate || null,
                        createdBy: plan.createdBy, // plan banane wala admin
                    });
                    if (bill.category === "subscription") subscriptionId = charge._id;
                }
            }
            result.set(key, "billed");
        } finally {
            inFlight.delete(key);
        }
    }
    return result;
};

// Player bana / parent link hua / team mili (age group badla ho sakta hai): pehle purana untouched bill naye hisaab se, phir naya bill.
// Bill na ban paaye toh bhi asli kaam fail nahi hona chahiye.
const billPlayersQuietly = async (playerIds) => {
    try {
        const ids = playerIds.filter(Boolean);
        await syncPlanBills(ids);
        await ensureSeasonCharges(ids);
    } catch (e) {
        console.error("Auto bill error:", e.message);
    }
};

module.exports = { ensureSeasonCharges, billPlayersQuietly, syncPlanBills, syncClubSeason, isUntouched };
