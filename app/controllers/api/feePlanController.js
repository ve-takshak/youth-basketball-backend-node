const moment = require("moment");
const mongoose = require("../../../config/database");
const FeePlan = require("../../models/FeePlan");
const { PRICING_MODES } = require("../../models/FeePlan");
const Charge = require("../../models/Charge");
const Team = require("../../models/Team");
const Player = require("../../models/Player");
const TeamCategory = require("../../models/TeamCategory");
const Club = require("../../models/Club");
const { CURRENCIES } = require("../../models/Charge");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { parseSeason } = require("../../helpers/season");
const { splitPlan, round } = require("../../helpers/paymentStatus");

// Club ka saal ka Fee Plan (Subscription Plan screen). Ek club + season ka ek hi chalu plan.
//   GET    /user/payments/fee-plans          list + saare age groups (naya plan banane ke liye)
//   POST   /user/payments/fee-plans          ek call mein: same / har age group ki fee + jersey
//   GET    /user/payments/fee-plans/:id      + monthly (Standing Order) preview
//   PUT    /user/payments/fee-plans/:id
//   DELETE /user/payments/fee-plans/:id
//   GET    /user/payments/fee-plans/:id/quote   join date se kitna dena (bache mahine)
// Age group = team category (U12 Minis, U14 Boys...). Player ka age group = uski team ki category.

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });
const sendOk = (res, message, data = {}) => res.status(200).json({ error: false, status: 200, message, message_desc: message, data });
const sendServerError = (res, label, e) => {
    console.error(`${label} error:`, e);
    return res.status(500).json({ error: true, status: 500, message: "Something went wrong.", message_desc: e.message, data: {} });
};

const isSuperAdmin = (req) => req.user.role === ROLES.SUPER_ADMIN;

const resolveClubId = (req, value) => {
    if (!isSuperAdmin(req)) return { clubId: req.clubId };
    if (!value) return { message: "clubId is required." };
    if (!isValidId(value)) return { message: "Invalid club id." };
    return { clubId: value };
};

const findPlan = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid fee plan id." };
    const plan = await FeePlan.findById(id);
    if (!plan || (!isSuperAdmin(req) && String(plan.clubId) !== String(req.clubId))) return { status: 404, message: "Fee plan not found." };
    return { plan };
};

// Saari age groups (team categories) + is club mein har group ki teams
const clubAgeGroups = async (clubId) => {
    const [categories, counts] = await Promise.all([
        TeamCategory.find().select("name").collation({ locale: "en", numericOrdering: true }).sort({ name: 1 }),
        Team.aggregate([
            { $match: { clubId: new mongoose.Types.ObjectId(String(clubId)) } },
            { $group: { _id: "$categoryId", n: { $sum: 1 } } },
        ]),
    ]);
    const teams = new Map(counts.map((c) => [String(c._id), c.n]));
    return categories.map((c) => ({ categoryId: c._id, name: c.name, teamsCount: teams.get(String(c._id)) || 0 }));
};

// Monthly (Standing Order) mein pehli aur har mahine ki kisht. Club setting ke maxInstallments tak.
const installmentPreview = (subscription, jersey, maxInstallments) => {
    if (!(subscription > 0) || maxInstallments < 2) return [];
    const items = [
        { type: "season_registration", amount: subscription },
        { type: "jersey", amount: jersey || 0 },
    ];
    return Array.from({ length: maxInstallments - 1 }, (_, i) => i + 2).map((n) => {
        const { firstAmount, monthlyAmount } = splitPlan(items, n);
        return { installments: n, firstAmount, monthlyAmount };
    });
};

// groups = clubAgeGroups(). maxInstallments diya ho toh har fee ke saath monthly preview bhi.
const formatPlan = (plan, { groups = [], issuedCount, maxInstallments } = {}) => {
    const jersey = plan.jerseyAmount || 0;
    const withTotal = (subscription) => ({
        totalAmount: subscription > 0 ? round(subscription + jersey) : 0, // parent ka bill (subscription + jersey)
        ...(maxInstallments !== undefined ? { standingOrderPreview: installmentPreview(subscription, jersey, maxInstallments) } : {}),
    });
    const stored = new Map((plan.ageGroups || []).map((g) => [String(g.categoryId), g.amount]));
    // Saari age groups (screen ki list), jinki fee nahi unka amount 0. Purane / hata diye group bhi jo plan mein hain.
    const listed = new Set(groups.map((g) => String(g.categoryId)));
    const extra = (plan.ageGroups || []).filter((g) => !listed.has(String(g.categoryId))).map((g) => ({ categoryId: g.categoryId, name: "", teamsCount: 0 }));

    return {
        _id: plan._id,
        clubId: plan.clubId,
        name: plan.name,
        season: plan.season,
        pricingMode: plan.pricingMode, // same | per_age_group
        subscriptionAmount: plan.subscriptionAmount || 0, // "same" mode ki fee
        jerseyAmount: jersey,
        proRate: plan.proRate !== false, // true = beech season join par bache mahino ki fee
        ...(plan.pricingMode === "same" ? withTotal(plan.subscriptionAmount || 0) : {}),
        ageGroups: [...groups, ...extra].map((g) => {
            const amount = stored.get(String(g.categoryId)) || 0;
            return { ...g, amount, ...(plan.pricingMode === "per_age_group" ? withTotal(amount) : {}) };
        }),
        currency: plan.currency,
        dueDate: plan.dueDate,
        isActive: plan.isActive,
        ...(issuedCount !== undefined ? { issuedCount } : {}),
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
    };
};

const parseAmount = (value, label) => {
    const amount = Number(value);
    if (value === "" || value === null || value === undefined || !Number.isFinite(amount) || amount < 0 || amount > 100000) {
        return { message: `${label} must be a number from 0 to 100000.` };
    }
    return { value: round(amount) };
};

const parseList = (value) => {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return null;
    }
};

// body check. partial = PUT (jo aaya wahi badlo)
const parseBody = async (body, { partial = false } = {}) => {
    const out = {};

    if (!partial || body.season !== undefined) {
        const season = parseSeason(body.season);
        if (season.message) return { message: season.message };
        if (!season.value) return { message: "Season is required." };
        out.season = season.value;
    }
    if (body.name !== undefined) {
        const name = String(body.name || "").trim();
        if (name.length > 120) return { message: "Plan name must be 120 characters or less." };
        if (name) out.name = name;
    }
    if (!partial || body.pricingMode !== undefined) {
        const mode = String(body.pricingMode || "").trim();
        if (!PRICING_MODES.includes(mode)) return { message: `pricingMode must be one of: ${PRICING_MODES.join(", ")}.` };
        out.pricingMode = mode;
    }
    if (body.subscriptionAmount !== undefined) {
        const parsed = parseAmount(body.subscriptionAmount, "Annual fee");
        if (parsed.message) return { message: parsed.message };
        out.subscriptionAmount = parsed.value;
    }
    if (body.jerseyAmount !== undefined && body.jerseyAmount !== "") {
        const parsed = parseAmount(body.jerseyAmount, "Jersey amount");
        if (parsed.message) return { message: parsed.message };
        out.jerseyAmount = parsed.value;
    }
    if (body.ageGroups !== undefined) {
        const groups = parseList(body.ageGroups);
        if (!Array.isArray(groups)) return { message: "ageGroups must be a list: [{ categoryId, amount }]." };
        const ids = groups.map((g) => String(g?.categoryId || ""));
        if (!ids.every(isValidId)) return { message: "Invalid age group id." };
        if (new Set(ids).size !== ids.length) return { message: "Each age group can appear only once." };
        const categories = await TeamCategory.find({ _id: { $in: ids } }).select("name");
        if (categories.length !== ids.length) return { message: "Some age groups were not found." };
        const nameOf = new Map(categories.map((c) => [String(c._id), c.name]));

        out.ageGroups = [];
        for (const g of groups) {
            const parsed = parseAmount(g.amount, `Fee for ${nameOf.get(String(g.categoryId))}`);
            if (parsed.message) return { message: parsed.message };
            out.ageGroups.push({ categoryId: String(g.categoryId), amount: parsed.value });
        }
    }
    if (body.currency !== undefined || !partial) {
        const currency = String(body.currency || "ILS").toUpperCase();
        if (!CURRENCIES.includes(currency)) return { message: `Currency must be one of: ${CURRENCIES.join(", ")}.` };
        out.currency = currency;
    }
    if (body.dueDate !== undefined) {
        if (body.dueDate === null || body.dueDate === "") out.dueDate = null;
        else {
            const m = moment(body.dueDate, ["YYYY-MM-DD", moment.ISO_8601], true);
            if (!m.isValid()) return { message: "Due date must be YYYY-MM-DD." };
            out.dueDate = m.endOf("day").toDate();
        }
    }
    if (body.isActive !== undefined) out.isActive = [true, "true", 1, "1"].includes(body.isActive);
    if (body.proRate !== undefined) out.proRate = [true, "true", 1, "1"].includes(body.proRate);
    return { data: out };
};

// Mode ke hisaab se fee bhari hai? (plan = save hone wala final roop)
const checkFees = (plan) => {
    if (plan.pricingMode === "same" && !(plan.subscriptionAmount > 0)) return "Enter the annual fee (more than 0).";
    if (plan.pricingMode === "per_age_group" && !(plan.ageGroups || []).some((g) => g.amount > 0)) {
        return "Enter a fee (more than 0) for at least one age group.";
    }
    return "";
};

const findDuplicate = (clubId, season, excludeId = null) =>
    FeePlan.findOne({ clubId, season, isActive: true, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select("name");

const maxInstallmentsFor = async (clubId) => {
    const club = await Club.findById(clubId).select("paymentSettings");
    const settings = club?.paymentSettings || {};
    return settings.allowStandingOrder === false ? 0 : settings.maxInstallments || 10;
};

/**
 * Club ke Fee Plans. data.ageGroups = saari age groups + teams ki ginti (plan na ho tab screen isi se banao).
 * query: clubId? (superAdmin), season?, active? (true | false)
 */
const listFeePlans = async (req, res) => {
    try {
        const { clubId, message } = resolveClubId(req, req.query.clubId);
        if (!clubId) return sendError(res, 400, message);

        const filter = { clubId };
        if (req.query.season) {
            const season = parseSeason(req.query.season);
            if (season.message) return sendError(res, 400, season.message);
            filter.season = season.value;
        }
        if (req.query.active !== undefined && req.query.active !== "") filter.isActive = req.query.active === "true";

        const [plans, groups] = await Promise.all([FeePlan.find(filter).sort({ isActive: -1, createdAt: -1 }), clubAgeGroups(clubId)]);
        const counts = await Charge.aggregate([
            { $match: { feePlanId: { $in: plans.map((p) => p._id) }, status: { $nin: ["cancelled"] } } },
            { $group: { _id: "$feePlanId", n: { $sum: 1 } } },
        ]);
        const byPlan = new Map(counts.map((c) => [String(c._id), c.n]));

        return sendOk(res, "Fee plans.", {
            feePlans: plans.map((p) => formatPlan(p, { groups, issuedCount: byPlan.get(String(p._id)) || 0 })),
            ageGroups: groups,
        });
    } catch (e) {
        return sendServerError(res, "listFeePlans", e);
    }
};

/**
 * Season ka Fee Plan ek call mein (Subscription Plan screen ka Save).
 * pricingMode "same": subscriptionAmount. "per_age_group": ageGroups [{ categoryId, amount }] (0 = is group ki fee nahi).
 * proRate (default true): season (Aug-Jul) ke beech join kare toh bache mahino ki fee. false = hamesha poore saal ki.
 * body: { clubId?, season, pricingMode, subscriptionAmount?, ageGroups?, jerseyAmount?, proRate?, name?, currency?, dueDate? }
 */
const createFeePlan = async (req, res) => {
    try {
        const body = req.body || {};
        const { clubId, message } = resolveClubId(req, body.clubId);
        if (!clubId) return sendError(res, 400, message);

        const parsed = await parseBody(body);
        if (parsed.message) return sendError(res, 400, parsed.message);
        const data = { name: `Annual subscription ${parsed.data.season}`, ...parsed.data };

        const feeError = checkFees(data);
        if (feeError) return sendError(res, 400, feeError);

        if (data.isActive !== false) {
            const other = await findDuplicate(clubId, data.season);
            if (other) return sendError(res, 409, `A fee plan for ${data.season} already exists. Edit it instead.`, { feePlanId: other._id });
        }

        const plan = await FeePlan.create({ ...data, clubId, createdBy: req.user._id });
        return sendOk(res, "Fee plan created.", { feePlan: formatPlan(plan, { groups: await clubAgeGroups(clubId), issuedCount: 0 }) });
    } catch (e) {
        return sendServerError(res, "createFeePlan", e);
    }
};

// Ek plan: har age group ki fee, total (subscription + jersey) aur monthly preview
const getFeePlan = async (req, res) => {
    try {
        const { plan, status, message } = await findPlan(req, req.params.id);
        if (!plan) return sendError(res, status, message);
        const [issuedCount, groups, maxInstallments] = await Promise.all([
            Charge.countDocuments({ feePlanId: plan._id, status: { $nin: ["cancelled"] } }),
            clubAgeGroups(plan.clubId),
            maxInstallmentsFor(plan.clubId),
        ]);
        return sendOk(res, "Fee plan.", { feePlan: formatPlan(plan, { groups, issuedCount, maxInstallments }) });
    } catch (e) {
        return sendServerError(res, "getFeePlan", e);
    }
};

/**
 * Plan badalna (jo field bhejo wahi badlega). ageGroups bhejo toh poori list badal jaati hai.
 * Pehle bane bills nahi badalte, sirf naye bills naye price se.
 * body: { season?, pricingMode?, subscriptionAmount?, ageGroups?, jerseyAmount?, proRate?, name?, currency?, dueDate?, isActive? }
 */
const updateFeePlan = async (req, res) => {
    try {
        const { plan, status, message } = await findPlan(req, req.params.id);
        if (!plan) return sendError(res, status, message);

        const parsed = await parseBody(req.body || {}, { partial: true });
        if (parsed.message) return sendError(res, 400, parsed.message);

        Object.assign(plan, parsed.data, { updatedBy: req.user._id });
        const feeError = checkFees(plan);
        if (feeError) return sendError(res, 400, feeError);

        if (plan.isActive) {
            const other = await findDuplicate(plan.clubId, plan.season, plan._id);
            if (other) return sendError(res, 409, `Another active fee plan for ${plan.season} already exists.`, { feePlanId: other._id });
        }
        await plan.save();

        const [issuedCount, groups] = await Promise.all([
            Charge.countDocuments({ feePlanId: plan._id, status: { $nin: ["cancelled"] } }),
            clubAgeGroups(plan.clubId),
        ]);
        return sendOk(res, issuedCount ? "Fee plan updated. Bills already sent keep the old price." : "Fee plan updated.", {
            feePlan: formatPlan(plan, { groups, issuedCount }),
        });
    } catch (e) {
        return sendServerError(res, "updateFeePlan", e);
    }
};

/**
 * Kisi player / age group ko kitna dena hoga (join date ke hisaab se bache mahine). Kuch save nahi hota.
 * query: playerId? (uski team ka age group + registration date) ya categoryId?, date? (YYYY-MM-DD, default aaj)
 * Saal 1200, date 2026-11-10, season "2026 / 2027" -> months 9, subscription 900 (+ jersey).
 */
const quoteFeePlan = async (req, res) => {
    try {
        const { plan, status, message } = await findPlan(req, req.params.id);
        if (!plan) return sendError(res, status, message);
        const query = req.query || {};

        let categoryId = null;
        let categoryName = "";
        let joinDate = null;
        let player = null;
        if (query.playerId) {
            if (!isValidId(query.playerId)) return sendError(res, 400, "Invalid player id.");
            player = await Player.findOne({ _id: query.playerId, clubId: plan.clubId })
                .select("teamId createdAt")
                .populate({ path: "teamId", select: "name categoryId", populate: { path: "categoryId", select: "name" } });
            if (!player) return sendError(res, 404, "Player not found.");
            categoryId = player.teamId?.categoryId?._id || null;
            categoryName = player.teamId?.categoryId?.name || "";
            joinDate = player.createdAt;
        }
        if (query.categoryId) {
            if (!isValidId(query.categoryId)) return sendError(res, 400, "Invalid age group id.");
            const category = await TeamCategory.findById(query.categoryId).select("name");
            if (!category) return sendError(res, 404, "Age group not found.");
            categoryId = category._id;
            categoryName = category.name;
        }
        if (query.date) {
            const m = moment(query.date, ["YYYY-MM-DD", moment.ISO_8601], true);
            if (!m.isValid()) return sendError(res, 400, "Date must be YYYY-MM-DD.");
            joinDate = m.toDate();
        }
        if (plan.pricingMode === "per_age_group" && !categoryId) {
            return sendError(res, 400, player ? "This player has no team, so no age group fee." : "Send playerId or categoryId.");
        }
        joinDate = joinDate || new Date();

        const quote = plan.quoteFor(categoryId, joinDate);
        return sendOk(res, quote.annualFee > 0 ? "Fee quote." : "No fee set for this age group.", {
            feePlanId: plan._id,
            season: plan.season,
            proRate: plan.proRate !== false,
            playerId: player?._id || null,
            categoryId,
            ageGroup: categoryName,
            joinDate: moment(joinDate).format("YYYY-MM-DD"),
            currency: plan.currency,
            ...quote,
            items: plan.itemsFor(categoryId, plan.pricingMode === "per_age_group" ? categoryName : "", joinDate) || [],
        });
    } catch (e) {
        return sendServerError(res, "quoteFeePlan", e);
    }
};

// Bill nahi bane toh delete, bane hain toh sirf band (isActive false) taaki history rahe
const deleteFeePlan = async (req, res) => {
    try {
        const { plan, status, message } = await findPlan(req, req.params.id);
        if (!plan) return sendError(res, status, message);

        const used = await Charge.exists({ feePlanId: plan._id });
        if (used) {
            plan.isActive = false;
            plan.updatedBy = req.user._id;
            await plan.save();
            return sendOk(res, "This plan already has bills, so it was turned off instead of deleted.", { deleted: false, isActive: false });
        }
        await plan.deleteOne();
        return sendOk(res, "Fee plan deleted.", { deleted: true });
    } catch (e) {
        return sendServerError(res, "deleteFeePlan", e);
    }
};

module.exports = { listFeePlans, createFeePlan, getFeePlan, updateFeePlan, deleteFeePlan, quoteFeePlan };
