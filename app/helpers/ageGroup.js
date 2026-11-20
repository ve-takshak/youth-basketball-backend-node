const Player = require("../models/Player");
const TeamCategory = require("../models/TeamCategory");
const { currentSeason, seasonStart } = require("./season");

// Player ka age group (team category) is season ke liye. Kram:
//   1. team        player ki team ki category
//   2. manual      player.categoryId (admin / parent ne khud chuna)
//   (1 / 2 ka group player ke gender ka na ho, jaise ladki U14 Boys team mein, toh usi umar ka uske gender wala: U14 Girls)
//   3. birthDate   date of birth + gender se apne aap (categories mein maxAge / gender set hon)
// Birth date wala har season naya nikalta hai (save nahi hota), isliye agle saal bachcha bada ho toh group bhi badal jaata hai.
//
// Birth date se kaise:
//   umar = season shuru (1 August) ko poore saal. Poore season wahi group rehta hai, birthday se nahi badalta.
//   category chalegi agar umar < maxAge ("U14" = maxAge 14 = 12 / 13 saal) aur gender match (category gender khaali = sabke liye).
//   sabse chhota maxAge jo fit ho. Same maxAge par gender wali category pehle (U14 Girls, phir mixed U14).
//   maxAge khaali wali category birth date se kabhi nahi chunti (Senior ke liye maxAge 99 rakho).

// birthDate par onDate ko kitne poore saal
const ageOn = (birthDate, onDate) => {
    const b = new Date(birthDate);
    if (!birthDate || Number.isNaN(b.getTime())) return null;
    let age = onDate.getFullYear() - b.getFullYear();
    if (onDate.getMonth() < b.getMonth() || (onDate.getMonth() === b.getMonth() && onDate.getDate() < b.getDate())) age -= 1;
    return age;
};

// categories: [{ _id, name, maxAge, gender }]. Fit nahi = null
const pickAgeGroup = (categories, { birthDate, gender = "" } = {}, season = currentSeason()) => {
    const age = ageOn(birthDate, seasonStart(season) || new Date());
    if (age === null || age < 0) return null;
    // Pehle umar se sabse chhota maxAge, phir usi maxAge mein gender. Gender match na ho toh bade group mein NAHI
    // bhejte (12 saal, gender khaali, U14 sirf Boys / Girls -> null, U16 nahi). Tab admin khud age group chunega.
    const byAge = categories.filter((c) => c.maxAge && age < c.maxAge);
    if (!byAge.length) return null;
    const min = Math.min(...byAge.map((c) => c.maxAge));
    const same = byAge.filter((c) => c.maxAge === min);
    return same.find((c) => c.gender && c.gender === gender) || same.find((c) => !c.gender) || null;
};

const loadAgeCategories = () => TeamCategory.find({ maxAge: { $ne: null } }).select("name maxAge gender").lean();

const brief = (category, source) => (category ? { _id: category._id || category, name: category.name || "", source } : null);

/**
 * Players ke age group ek saath. Return Map(playerId -> { _id, name, source: team | manual | birthDate } | null)
 */
const ageGroupsFor = async (playerIds, season = currentSeason()) => {
    const map = new Map();
    const ids = (playerIds || []).filter(Boolean);
    if (!ids.length) return map;

    const players = await Player.find({ _id: { $in: ids } })
        .select("teamId categoryId userId")
        .populate({ path: "teamId", select: "categoryId", populate: { path: "categoryId", select: "name maxAge gender" } })
        .populate({ path: "categoryId", select: "name maxAge gender" })
        .populate({ path: "userId", select: "birthDate gender" });

    let categories = null;
    const loadCategories = async () => (categories = categories || (await loadAgeCategories()));

    // Team / chuna hua group player ke gender ka nahi (ladki U14 Boys team mein): usi umar ka uske gender wala group
    // (U14 Girls). Woh na mile toh birth date se. Player ka gender khaali ho toh jo hai wahi.
    const fitGender = async (category, player, source) => {
        const gender = player.userId?.gender || "";
        if (!category.gender || !gender || category.gender === gender) return brief(category, source);
        const all = await loadCategories();
        const same = category.maxAge ? all.find((c) => c.maxAge === category.maxAge && c.gender === gender) : null;
        if (same) return brief(same, source);
        const picked = pickAgeGroup(all, { birthDate: player.userId?.birthDate, gender }, season);
        return picked ? brief(picked, "birthDate") : brief(category, source);
    };

    for (const player of players) {
        const key = String(player._id);
        if (player.teamId?.categoryId) {
            map.set(key, await fitGender(player.teamId.categoryId, player, "team"));
        } else if (player.categoryId) {
            map.set(key, await fitGender(player.categoryId, player, "manual"));
        } else {
            const picked = pickAgeGroup(await loadCategories(), { birthDate: player.userId?.birthDate, gender: player.userId?.gender }, season);
            map.set(key, brief(picked, "birthDate"));
        }
    }
    return map;
};

module.exports = { ageOn, pickAgeGroup, loadAgeCategories, ageGroupsFor };
