const Charge = require("../models/Charge");
const FeePlan = require("../models/FeePlan");
const { SUBSCRIPTION_PRODUCTS } = require("../models/FeePlan");
const TeamCategory = require("../models/TeamCategory");
const { isValidId } = require("./common");
const { currentSeason } = require("./season");

// Youth player: pehle season ki fee, phir team.
//   - Rok sirf PEHLI baar team milne par (player abhi kisi team mein nahi). Pehle se team wale players move ho sakte hain.
//   - Senior player par rok nahi.
//   - Club ka chalu season ka Fee Plan nahi / us age group ki fee 0 = rok nahi (paisa lena hi nahi).
//   - Paid = subscription bill "paid": ek baar pura, Standing Order ki pehli kisht, ya admin ka mark-paid (cash).
//   - Jersey ka bill zaroori nahi.

// Player ka age group: team ho toh team ki category, warna player ki apni (categoryId)
const ageGroupOf = (player) => player?.teamId?.categoryId || player?.categoryId || null;

// body ka categoryId check. undefined = bheja hi nahi, "" / null = hatao
const resolveAgeGroup = async (value) => {
    if (value === undefined) return {};
    if (value === null || String(value).trim() === "") return { categoryId: null };
    if (!isValidId(value)) return { status: 400, message: "Invalid age group." };
    const category = await TeamCategory.findById(value).select("name");
    if (!category) return { status: 404, message: "Age group not found." };
    return { categoryId: category._id, name: category.name };
};

const PAYMENT_REQUIRED = "PAYMENT_REQUIRED";

/**
 * Is youth player ko is team mein daal sakte hain?
 * player: Player document (naya player ho toh { playerType, categoryId, clubId } bhi chalega, _id nahi)
 * Return null = theek hai, warna { status, message, code }
 */
const checkTeamPayment = async (player, team) => {
    if (!player || !team) return null;
    if ((player.playerType || "youth") !== "youth") return null;
    if (player.teamId) return null; // pehle se kisi team mein: move par rok nahi

    const season = currentSeason();
    const plan = await FeePlan.findOne({
        clubId: team.clubId,
        season,
        isActive: true,
        productType: { $in: [...SUBSCRIPTION_PRODUCTS, null] },
    }).sort({ createdAt: -1 });
    if (!plan) return null;

    const categoryId = player.categoryId?._id || player.categoryId || team.categoryId;
    if (!(plan.subscriptionFor(categoryId) > 0)) return null;

    if (player._id) {
        const paid = await Charge.exists({
            playerId: player._id,
            season,
            status: "paid",
            $or: [{ category: "subscription" }, { "items.type": "season_registration" }],
        });
        if (paid) return null;
    }

    return {
        status: 409,
        code: PAYMENT_REQUIRED,
        message: "This youth player can join a team only after the season fee is paid. The bill is in the parent's app.",
    };
};

module.exports = { ageGroupOf, resolveAgeGroup, checkTeamPayment, PAYMENT_REQUIRED };
