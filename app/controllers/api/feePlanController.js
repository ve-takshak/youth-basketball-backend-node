const moment = require("moment");
const FeePlan = require("../../models/FeePlan");
const Charge = require("../../models/Charge");
const Team = require("../../models/Team");
const Club = require("../../models/Club");
const { CURRENCIES, UPFRONT_ITEM_TYPES } = require("../../models/Charge");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { parseSeason } = require("../../helpers/season");
const { parseItems } = require("../../helpers/chargeItems");
const { splitPlan } = require("../../helpers/paymentStatus");

// Club ki price list (Fee Plans). Club admin price set karta hai, bill banate waqt feePlanId bhejta hai.
//   GET    /user/payments/fee-plans
//   POST   /user/payments/fee-plans
//   GET    /user/payments/fee-plans/:id
//   PUT    /user/payments/fee-plans/:id
//   DELETE /user/payments/fee-plans/:id

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
    const plan = await FeePlan.findById(id).populate("teamIds", "name");
    if (!plan || (!isSuperAdmin(req) && String(plan.clubId) !== String(req.clubId))) return { status: 404, message: "Fee plan not found." };
    return { plan };
};

const hasAgeGroup = (plan) => Boolean(plan.ageGroup && plan.ageGroup.birthYearFrom && plan.ageGroup.birthYearTo);

// { name, birthYearFrom, birthYearTo } check. null / "" = age group hatao.
const parseAgeGroup = (raw) => {
    let value = raw;
    if (typeof value === "string") {
        if (!value.trim()) return { ageGroup: { name: "", birthYearFrom: null, birthYearTo: null } };
        try {
            value = JSON.parse(value);
        } catch (e) {
            return { message: "Age group must be an object: { name, birthYearFrom, birthYearTo }." };
        }
    }
    if (value === null) return { ageGroup: { name: "", birthYearFrom: null, birthYearTo: null } };
    if (typeof value !== "object" || Array.isArray(value)) return { message: "Age group must be an object: { name, birthYearFrom, birthYearTo }." };

    const name = String(value.name || "").trim();
    if (!name) return { message: "Age group name is required (for example U14)." };
    if (name.length > 30) return { message: "Age group name must be 30 characters or less." };

    const thisYear = new Date().getFullYear();
    const from = Number(value.birthYearFrom);
    const to = value.birthYearTo === undefined || value.birthYearTo === "" ? from : Number(value.birthYearTo);
    const validYear = (y) => Number.isInteger(y) && y >= 1950 && y <= thisYear;
    if (!validYear(from) || !validYear(to)) return { message: `Birth years must be between 1950 and ${thisYear}.` };
    if (from > to) return { message: "birthYearFrom must be the same as or before birthYearTo." };
    return { ageGroup: { name, birthYearFrom: from, birthYearTo: to } };
};

// Same club + season mein do chalu plans ke birth years ek doosre pe na chadhein (warna registration pe kaunsa?)
const findAgeOverlap = (clubId, season, ageGroup, excludeId = null) =>
    FeePlan.findOne({
        clubId,
        season,
        isActive: true,
        "ageGroup.birthYearFrom": { $ne: null, $lte: ageGroup.birthYearTo },
        "ageGroup.birthYearTo": { $ne: null, $gte: ageGroup.birthYearFrom },
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    }).select("name ageGroup");

const overlapMessage = (other) =>
    `"${other.name}" (${other.ageGroup.name}, born ${other.ageGroup.birthYearFrom}-${other.ageGroup.birthYearTo}) already covers these birth years for this season. Turn it off or change the years first.`;

// Standing Order mein parent ko kitna dikhega (preview). Club setting ke maxInstallments tak.
const installmentPreview = (plan, maxInstallments) => {
    const spreadTotal = plan.items.filter((i) => !UPFRONT_ITEM_TYPES.includes(i.type)).reduce((s, i) => s + i.amount, 0);
    if (!(spreadTotal > 0) || maxInstallments < 2) return [];
    return Array.from({ length: maxInstallments - 1 }, (_, i) => i + 2).map((n) => {
        const { firstAmount, monthlyAmount } = splitPlan(plan.items, n);
        return { installments: n, firstAmount, monthlyAmount };
    });
};

const formatPlan = (plan, { issuedCount, maxInstallments } = {}) => ({
    _id: plan._id,
    clubId: plan.clubId,
    name: plan.name,
    season: plan.season,
    ageGroup: hasAgeGroup(plan)
        ? { name: plan.ageGroup.name, birthYearFrom: plan.ageGroup.birthYearFrom, birthYearTo: plan.ageGroup.birthYearTo }
        : null,
    teams: (plan.teamIds || []).map((t) => (t && t.name !== undefined ? { _id: t._id, name: t.name } : { _id: t, name: "" })),
    allTeams: !(plan.teamIds || []).length,
    items: plan.items.map((i) => ({ _id: i._id, type: i.type, name: i.name, amount: i.amount })),
    amount: plan.amount,
    currency: plan.currency,
    dueDate: plan.dueDate,
    isActive: plan.isActive,
    ...(issuedCount !== undefined ? { issuedCount } : {}),
    ...(maxInstallments !== undefined ? { standingOrderPreview: installmentPreview(plan, maxInstallments) } : {}),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
});

// body se name / season / teamIds / items / currency / dueDate / isActive check. partial = PUT (jo aaya wahi badlo)
const parseBody = async (body, clubId, { partial = false } = {}) => {
    const out = {};

    if (!partial || body.name !== undefined) {
        const name = String(body.name || "").trim();
        if (!name) return { message: "Plan name is required." };
        if (name.length > 120) return { message: "Plan name must be 120 characters or less." };
        out.name = name;
    }
    if (!partial || body.season !== undefined) {
        const season = parseSeason(body.season);
        if (season.message) return { message: season.message };
        if (!season.value) return { message: "Season is required." };
        out.season = season.value;
    }
    if (!partial || body.items !== undefined) {
        const parsed = parseItems(body.items);
        if (parsed.message) return { message: parsed.message };
        out.items = parsed.items;
        out.amount = parsed.total;
    }
    if (!partial || body.currency !== undefined) {
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
    if (body.teamIds !== undefined) {
        let ids = body.teamIds;
        if (typeof ids === "string") ids = ids.split(",").map((s) => s.trim()).filter(Boolean);
        if (!Array.isArray(ids)) return { message: "teamIds must be a list." };
        ids = [...new Set(ids.map(String))];
        if (!ids.every(isValidId)) return { message: "Invalid team id." };
        if (ids.length) {
            const found = await Team.countDocuments({ _id: { $in: ids }, clubId });
            if (found !== ids.length) return { message: "Some teams were not found in this club." };
        }
        out.teamIds = ids;
    }
    if (body.ageGroup !== undefined) {
        const parsed = parseAgeGroup(body.ageGroup);
        if (parsed.message) return { message: parsed.message };
        out.ageGroup = parsed.ageGroup;
    }
    if (body.isActive !== undefined) out.isActive = [true, "true", 1, "1"].includes(body.isActive);
    return { data: out };
};

/**
 * Club ki price list
 * query: clubId? (superAdmin), season?, teamId?, birthYear? (2013 -> U14 plan), active? (true | false)
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
        if (req.query.teamId) {
            if (!isValidId(req.query.teamId)) return sendError(res, 400, "Invalid team id.");
            // Is team ke plan + "saari teams" wale plan
            filter.$or = [{ teamIds: req.query.teamId }, { teamIds: { $size: 0 } }];
        }
        // Is birth year ka plan (registration screen: 2013 mein paida hua -> U14 plan)
        if (req.query.birthYear) {
            const year = Number(req.query.birthYear);
            if (!Number.isInteger(year)) return sendError(res, 400, "birthYear must be a year, for example 2013.");
            filter["ageGroup.birthYearFrom"] = { $lte: year };
            filter["ageGroup.birthYearTo"] = { $gte: year };
        }

        const plans = await FeePlan.find(filter).sort({ createdAt: -1 }).populate("teamIds", "name");
        const counts = await Charge.aggregate([
            { $match: { feePlanId: { $in: plans.map((p) => p._id) }, status: { $nin: ["cancelled"] } } },
            { $group: { _id: "$feePlanId", n: { $sum: 1 } } },
        ]);
        const byPlan = new Map(counts.map((c) => [String(c._id), c.n]));

        return sendOk(res, "Fee plans.", { feePlans: plans.map((p) => formatPlan(p, { issuedCount: byPlan.get(String(p._id)) || 0 })) });
    } catch (e) {
        return sendServerError(res, "listFeePlans", e);
    }
};

/**
 * Naya price plan
 * ageGroup: { name: "U14", birthYearFrom: 2013, birthYearTo: 2014 } (player ki birth year se). Same season mein years overlap nahi.
 * body: { clubId?, name, season, items: [{ type, name, amount }], ageGroup?, teamIds?, currency?, dueDate?, isActive? }
 */
const createFeePlan = async (req, res) => {
    try {
        const body = req.body || {};
        const { clubId, message } = resolveClubId(req, body.clubId);
        if (!clubId) return sendError(res, 400, message);

        const parsed = await parseBody(body, clubId);
        if (parsed.message) return sendError(res, 400, parsed.message);

        const data = parsed.data;
        if (data.ageGroup?.birthYearFrom && data.isActive !== false) {
            const other = await findAgeOverlap(clubId, data.season, data.ageGroup);
            if (other) return sendError(res, 409, overlapMessage(other));
        }

        const plan = await FeePlan.create({ ...parsed.data, clubId, createdBy: req.user._id });
        await plan.populate("teamIds", "name");
        return sendOk(res, "Fee plan created.", { feePlan: formatPlan(plan, { issuedCount: 0 }) });
    } catch (e) {
        return sendServerError(res, "createFeePlan", e);
    }
};

// Ek plan + Standing Order ka preview (har kisht ka amount)
const getFeePlan = async (req, res) => {
    try {
        const { plan, status, message } = await findPlan(req, req.params.id);
        if (!plan) return sendError(res, status, message);
        const [issuedCount, club] = await Promise.all([
            Charge.countDocuments({ feePlanId: plan._id, status: { $nin: ["cancelled"] } }),
            Club.findById(plan.clubId).select("paymentSettings"),
        ]);
        const settings = club?.paymentSettings || {};
        const maxInstallments = settings.allowStandingOrder === false ? 0 : settings.maxInstallments || 10;
        return sendOk(res, "Fee plan.", { feePlan: formatPlan(plan, { issuedCount, maxInstallments }) });
    } catch (e) {
        return sendServerError(res, "getFeePlan", e);
    }
};

/**
 * Plan badalna (jo field bhejo wahi badlega). Pehle bane bills nahi badalte, sirf naye bills naye price se.
 * body: { name?, season?, items?, ageGroup? (null = hatao), teamIds?, currency?, dueDate?, isActive? }
 */
const updateFeePlan = async (req, res) => {
    try {
        const { plan, status, message } = await findPlan(req, req.params.id);
        if (!plan) return sendError(res, status, message);

        const parsed = await parseBody(req.body || {}, plan.clubId, { partial: true });
        if (parsed.message) return sendError(res, 400, parsed.message);

        Object.assign(plan, parsed.data, { updatedBy: req.user._id });
        if (hasAgeGroup(plan) && plan.isActive) {
            const other = await findAgeOverlap(plan.clubId, plan.season, plan.ageGroup, plan._id);
            if (other) return sendError(res, 409, overlapMessage(other));
        }
        await plan.save();
        await plan.populate("teamIds", "name");
        const issuedCount = await Charge.countDocuments({ feePlanId: plan._id, status: { $nin: ["cancelled"] } });
        return sendOk(res, issuedCount ? "Fee plan updated. Bills already sent keep the old price." : "Fee plan updated.", {
            feePlan: formatPlan(plan, { issuedCount }),
        });
    } catch (e) {
        return sendServerError(res, "updateFeePlan", e);
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

module.exports = { listFeePlans, createFeePlan, getFeePlan, updateFeePlan, deleteFeePlan };
