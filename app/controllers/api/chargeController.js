const mongoose = require("mongoose");
const moment = require("moment");
const Charge = require("../../models/Charge");
const Player = require("../../models/Player");
const Team = require("../../models/Team");
const Coach = require("../../models/Coach");
const FeePlan = require("../../models/FeePlan");
const { parseItems } = require("../../helpers/chargeItems");
const { CHARGE_ITEM_TYPES, CURRENCIES, PAYMENT_METHODS, UPFRONT_ITEM_TYPES } = require("../../models/Charge");
const { ROLES } = require("../../helpers/constants");
const { isValidId, getPagination } = require("../../helpers/common");
const { parseSeason } = require("../../helpers/season");
const { chargeBadge, playerBadge, jerseyPaid, amounts, round } = require("../../helpers/paymentStatus");
const { formatCharge, PLAYER_POPULATE } = require("../../helpers/chargeFormat");
const { providerForClub, addEvent, syncStandingOrder, latestReceipt } = require("../../payments/service");
const { PaymentError } = require("../../payments");
const { decrypt } = require("../../helpers/secretBox");

// Club owner / super admin ka payments section: bill banana, list, summary, refund, receipt.
//   POST /user/payments/charges/issue
//   GET  /user/payments/charges
//   GET  /user/payments/summary
//   GET  /user/payments/charges/:id
//   PUT  /user/payments/charges/:id/mark-paid
//   PUT  /user/payments/charges/:id/cancel
//   POST /user/payments/charges/:id/refund
//   GET  /user/payments/charges/:id/receipt
//   GET  /user/teams/:id/payment-status   (coach bhi: roster ke badges)

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

const sendServerError = (res, label, e) => {
    if (e instanceof PaymentError) {
        const status = e.code === "NOT_IMPLEMENTED" || e.code === "BAD_REQUEST" ? 400 : 502;
        return sendError(res, status, e.message, { code: e.code });
    }
    console.error(`${label} error:`, e);
    return res.status(500).json({ error: true, status: 500, message: "Something went wrong.", message_desc: e.message, data: {} });
};

const sendOk = (res, message, data = {}) => res.status(200).json({ error: false, status: 200, message, message_desc: message, data });

const isSuperAdmin = (req) => req.user.role === ROLES.SUPER_ADMIN;

// superAdmin ?clubId= / body.clubId se, clubAdmin ka apna
const resolveClubId = (req, value) => {
    if (!isSuperAdmin(req)) return { clubId: req.clubId };
    if (!value) return { message: "clubId is required." };
    if (!isValidId(value)) return { message: "Invalid club id." };
    return { clubId: value };
};

const findCharge = async (req, id, select = "") => {
    if (!isValidId(id)) return { status: 400, message: "Invalid charge id." };
    const charge = await Charge.findById(id).select(select).populate(PLAYER_POPULATE);
    if (!charge || (!isSuperAdmin(req) && String(charge.clubId) !== String(req.clubId))) {
        return { status: 404, message: "Charge not found." };
    }
    return { charge };
};

/**
 * Season registration bill banana: ek player = ek bill (items: season fee, jersey, Athlete Services Envelope...).
 * Do tarah se:
 *   feePlanId do  -> price / items / season / title / dueDate club ki price list (Fee Plan) se. teamId / playerIds
 *                    na do toh plan ki saari teams (plan "saari teams" ka ho toh teamId ya playerIds dena zaroori).
 *   items do      -> haath se price (purana tareeka).
 * teamId do toh poori team, playerIds do toh sirf wo. Jis player ka same plan (ya same season + title) ka bill pehle se hai, wo skip.
 * overrides: kisi player ki alag fee, [{ playerId, items: [{ type, name, amount }] }]. Baaki sab ko normal price.
 * body: { clubId?, feePlanId?, season?, title?, teamId?, playerIds?, items?: [{ type, name, amount }], overrides?, dueDate?, currency? }
 */
const issueCharges = async (req, res) => {
    try {
        const body = req.body || {};
        const { clubId, message } = resolveClubId(req, body.clubId);
        if (!clubId) return sendError(res, 400, message);

        let plan = null;
        if (body.feePlanId) {
            if (!isValidId(body.feePlanId)) return sendError(res, 400, "Invalid fee plan id.");
            plan = await FeePlan.findOne({ _id: body.feePlanId, clubId });
            if (!plan) return sendError(res, 404, "Fee plan not found.");
            if (!plan.isActive) return sendError(res, 400, "This fee plan is turned off.");
        }

        const season = parseSeason(plan ? plan.season : body.season);
        if (season.message) return sendError(res, 400, season.message);
        if (!season.value) return sendError(res, 400, "Season is required.");

        let items;
        let amount;
        if (plan) {
            items = plan.items.map((i) => ({ type: i.type, name: i.name, amount: i.amount }));
            amount = plan.amount;
        } else {
            const parsed = parseItems(body.items);
            if (parsed.message) return sendError(res, 400, parsed.message);
            items = parsed.items;
            amount = parsed.total;
        }

        const currency = plan ? plan.currency : String(body.currency || "ILS").toUpperCase();
        if (!CURRENCIES.includes(currency)) return sendError(res, 400, `Currency must be one of: ${CURRENCIES.join(", ")}.`);

        // body ki dueDate plan wali se upar
        let dueDate = plan?.dueDate || null;
        if (body.dueDate) {
            const m = moment(body.dueDate, ["YYYY-MM-DD", moment.ISO_8601], true);
            if (!m.isValid()) return sendError(res, 400, "Due date must be YYYY-MM-DD.");
            dueDate = m.endOf("day").toDate();
        }

        const title = String(plan ? plan.name : body.title || `Season registration ${season.value}`).trim().slice(0, 120);
        const planTeamIds = (plan?.teamIds || []).map(String);

        const filter = { clubId, status: { $nin: ["left", "inactive"] } };
        if (body.teamId) {
            if (!isValidId(body.teamId)) return sendError(res, 400, "Invalid team id.");
            if (!(await Team.exists({ _id: body.teamId, clubId }))) return sendError(res, 404, "Team not found.");
            if (planTeamIds.length && !planTeamIds.includes(String(body.teamId))) return sendError(res, 400, "This fee plan is not for this team.");
            filter.teamId = body.teamId;
        }
        let playerIds = body.playerIds;
        if (typeof playerIds === "string") playerIds = playerIds.split(",").map((s) => s.trim()).filter(Boolean);
        if (Array.isArray(playerIds) && playerIds.length) {
            if (!playerIds.every(isValidId)) return sendError(res, 400, "Invalid player id.");
            filter._id = { $in: playerIds };
            if (planTeamIds.length && !filter.teamId) filter.teamId = { $in: planTeamIds };
        }
        if (!filter.teamId && !filter._id && planTeamIds.length) filter.teamId = { $in: planTeamIds };
        if (!filter.teamId && !filter._id) return sendError(res, 400, "Choose a team or players.");

        const players = await Player.find(filter).select("_id season");
        if (!players.length) return sendError(res, 404, "No players found.");

        const existing = await Charge.find({
            clubId,
            playerId: { $in: players.map((p) => p._id) },
            status: { $nin: ["cancelled", "refunded"] },
            $or: [{ season: season.value, title }, ...(plan ? [{ feePlanId: plan._id }] : [])],
        }).select("playerId");
        const already = new Set(existing.map((c) => String(c.playerId)));

        // Kisi player ki alag fee (discount / scholarship / bhai-behen): baaki sab ko plan ya items wali price
        const overrides = new Map();
        let rawOverrides = body.overrides;
        if (typeof rawOverrides === "string") {
            try {
                rawOverrides = JSON.parse(rawOverrides);
            } catch (e) {
                return sendError(res, 400, "Overrides must be a list.");
            }
        }
        if (rawOverrides !== undefined && rawOverrides !== null) {
            if (!Array.isArray(rawOverrides)) return sendError(res, 400, "Overrides must be a list.");
            const selected = new Set(players.map((p) => String(p._id)));
            for (const o of rawOverrides) {
                if (!isValidId(o?.playerId)) return sendError(res, 400, "Invalid player id in overrides.");
                if (!selected.has(String(o.playerId))) return sendError(res, 400, `Player ${o.playerId} in overrides is not in this team / list.`);
                const parsedOverride = parseItems(o.items);
                if (parsedOverride.message) return sendError(res, 400, `Player ${o.playerId}: ${parsedOverride.message}`);
                overrides.set(String(o.playerId), parsedOverride);
            }
        }

        const created = [];
        for (const player of players) {
            if (already.has(String(player._id))) continue;
            const custom = overrides.get(String(player._id));
            const charge = await Charge.create({
                clubId,
                playerId: player._id,
                season: season.value,
                feePlanId: plan?._id || null,
                customAmount: Boolean(custom),
                title,
                items: custom ? custom.items : items,
                amount: custom ? custom.total : amount,
                currency,
                dueDate,
                createdBy: req.user._id,
            });
            created.push(charge._id);
        }

        return sendOk(res, `${created.length} charge(s) created.`, {
            created: created.length,
            skipped: players.length - created.length,
            customAmounts: [...overrides.keys()].filter((id) => !already.has(id)).length,
            chargeIds: created,
        });
    } catch (e) {
        return sendServerError(res, "issueCharges", e);
    }
};

// List / summary ka common filter
const buildFilter = async (req, query) => {
    const { clubId, message } = isSuperAdmin(req) && !query.clubId ? { clubId: null } : resolveClubId(req, query.clubId);
    if (message) return { message };

    const filter = {};
    if (clubId) filter.clubId = new mongoose.Types.ObjectId(String(clubId));
    if (query.season) {
        const season = parseSeason(query.season);
        if (season.message) return { message: season.message };
        filter.season = season.value;
    }
    if (query.plan) filter.plan = query.plan;
    if (query.playerId) {
        if (!isValidId(query.playerId)) return { message: "Invalid player id." };
        filter.playerId = query.playerId;
    }
    if (query.teamId) {
        if (!isValidId(query.teamId)) return { message: "Invalid team id." };
        const ids = await Player.find({ teamId: query.teamId }).distinct("_id");
        filter.playerId = { $in: ids };
    }
    if (query.itemType) filter["items.type"] = query.itemType;
    if (query.feePlanId) {
        if (!isValidId(query.feePlanId)) return { message: "Invalid fee plan id." };
        filter.feePlanId = new mongoose.Types.ObjectId(String(query.feePlanId));
    }
    return { filter };
};

/**
 * Club ke saare bills (history). badge filter: paid | unpaid | overdue | pending | refunded | cancelled
 * query: clubId? (superAdmin), season?, teamId?, playerId?, feePlanId?, plan?, itemType?, badge?, page?, limit?
 */
const listCharges = async (req, res) => {
    try {
        const { filter, message } = await buildFilter(req, req.query);
        if (!filter) return sendError(res, 400, message);
        const { page, limit, skip } = getPagination(req.query);

        // Badge DB mein nahi (date pe depend), isliye badge filter pe JS mein
        const badge = req.query.badge ? String(req.query.badge) : "";
        let charges;
        let total;
        if (badge) {
            const all = await Charge.find(filter).sort({ createdAt: -1 }).populate(PLAYER_POPULATE);
            const matched = all.filter((c) => chargeBadge(c) === badge);
            total = matched.length;
            charges = matched.slice(skip, skip + limit);
        } else {
            [charges, total] = await Promise.all([
                Charge.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate(PLAYER_POPULATE),
                Charge.countDocuments(filter),
            ]);
        }

        return sendOk(res, "Charges.", {
            charges: charges.map((c) => formatCharge(c)),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (e) {
        return sendServerError(res, "listCharges", e);
    }
};

/**
 * Club owner dashboard ke numbers: collected, pending, overdue, Standing Orders, jersey, aakhri payments
 * query: clubId? (superAdmin), season?
 */
const getPaymentsSummary = async (req, res) => {
    try {
        const { filter, message } = await buildFilter(req, req.query);
        if (!filter) return sendError(res, 400, message);

        const charges = await Charge.find(filter).populate(PLAYER_POPULATE);
        const totals = { collected: 0, outstanding: 0, overdueAmount: 0, refunded: 0 };
        const counts = { paid: 0, unpaid: 0, overdue: 0, pending: 0, refunded: 0, cancelled: 0 };
        const byType = Object.fromEntries(CHARGE_ITEM_TYPES.map((t) => [t, { billed: 0, paid: 0, outstanding: 0 }]));
        const standingOrders = { active: 0, inactive: 0, monthlyExpected: 0, missedInstallments: 0 };
        const jersey = { paid: 0, unpaid: 0 };

        charges.forEach((charge) => {
            const badge = chargeBadge(charge);
            counts[badge] = (counts[badge] || 0) + 1;
            if (badge === "cancelled") return;

            const money = amounts(charge);
            totals.collected += money.paid;
            totals.outstanding += money.outstanding;
            totals.refunded += charge.refundedAmount || 0;
            if (badge === "overdue") totals.overdueAmount += money.outstanding;

            const j = jerseyPaid(charge);
            if (j === true) jersey.paid += 1;
            if (j === false) jersey.unpaid += 1;

            // Item ke hisaab se: Standing Order mein upfront items poore paid, season fee kisht ke hisaab se
            const upfrontTotal = charge.items.filter((i) => UPFRONT_ITEM_TYPES.includes(i.type)).reduce((s, i) => s + i.amount, 0);
            const spreadTotal = charge.amount - upfrontTotal;
            const spreadPaidShare = spreadTotal > 0 ? Math.max(0, Math.min(1, (money.paid - upfrontTotal) / spreadTotal)) : 1;
            charge.items.forEach((item) => {
                const bucket = byType[item.type];
                bucket.billed += item.amount;
                let paid = 0;
                if (charge.status === "paid") {
                    paid = charge.plan === "standing_order" && !UPFRONT_ITEM_TYPES.includes(item.type) ? item.amount * spreadPaidShare : item.amount;
                }
                bucket.paid += paid;
                bucket.outstanding += badge === "refunded" ? 0 : item.amount - paid;
            });

            if (charge.plan === "standing_order" && charge.standingOrder && charge.status === "paid") {
                if (charge.standingOrder.stoStatus === "inactive") standingOrders.inactive += 1;
                else {
                    standingOrders.active += 1;
                    standingOrders.monthlyExpected += charge.standingOrder.monthlyAmount;
                }
            }
        });

        Object.keys(totals).forEach((k) => (totals[k] = round(totals[k])));
        Object.values(byType).forEach((b) => Object.keys(b).forEach((k) => (b[k] = round(b[k]))));
        standingOrders.monthlyExpected = round(standingOrders.monthlyExpected);

        const recent = charges
            .filter((c) => c.paidAt)
            .sort((a, b) => b.paidAt - a.paidAt)
            .slice(0, 10)
            .map((c) => formatCharge(c));

        return sendOk(res, "Payments summary.", { totals, counts, byType, jersey, standingOrders, recentPayments: recent });
    } catch (e) {
        return sendServerError(res, "getPaymentsSummary", e);
    }
};

/**
 * Ek bill + gateway log. Standing Order ho toh Tranzila se taaza sync.
 */
const getCharge = async (req, res) => {
    try {
        const { charge, status, message } = await findCharge(req, req.params.id, "+events");
        if (!charge) return sendError(res, status, message);
        await syncStandingOrder(charge, { force: true });
        return sendOk(res, "Charge.", { charge: formatCharge(charge, { events: true }) });
    } catch (e) {
        return sendServerError(res, "getCharge", e);
    }
};

/**
 * Bhejne ke baad bill badalna (ek player ki alag fee). Sirf jab tak pay nahi hua aur checkout chal nahi raha.
 * Parent agli baar checkout karega toh nayi amount / kisht se.
 * body: { items?: [{ type, name, amount }], dueDate?, title?, notes? }
 */
const updateCharge = async (req, res) => {
    try {
        const { charge, status, message } = await findCharge(req, req.params.id, "+events");
        if (!charge) return sendError(res, status, message);

        const badge = chargeBadge(charge);
        if (badge === "pending") return sendError(res, 409, "The parent is paying this charge right now. Try again in a few minutes.");
        // pending + 30 min nikal gaye = parent ne chhod diya, badal sakte hain
        if (!["unpaid", "failed", "pending"].includes(charge.status)) return sendError(res, 409, `This charge is ${charge.status} and can't be changed.`);
        if (charge.status === "pending") {
            charge.status = "unpaid";
            charge.checkoutStartedAt = null;
        }

        const body = req.body || {};
        const changes = [];
        if (body.items !== undefined) {
            const parsed = parseItems(body.items);
            if (parsed.message) return sendError(res, 400, parsed.message);
            changes.push(`amount ${charge.amount} -> ${parsed.total}`);
            charge.items = parsed.items;
            charge.amount = parsed.total;
            charge.customAmount = true;
            charge.standingOrder = null;
            charge.pendingPlan = "";
        }
        if (body.dueDate !== undefined) {
            if (body.dueDate === null || body.dueDate === "") charge.dueDate = null;
            else {
                const m = moment(body.dueDate, ["YYYY-MM-DD", moment.ISO_8601], true);
                if (!m.isValid()) return sendError(res, 400, "Due date must be YYYY-MM-DD.");
                charge.dueDate = m.endOf("day").toDate();
            }
            changes.push("due date");
        }
        if (body.title !== undefined) {
            const title = String(body.title).trim().slice(0, 120);
            if (!title) return sendError(res, 400, "Title can't be empty.");
            charge.title = title;
            changes.push("title");
        }
        if (body.notes !== undefined) charge.notes = String(body.notes).trim().slice(0, 500);
        if (!changes.length && body.notes === undefined) return sendError(res, 400, "Nothing to change.");

        if (changes.length) addEvent(charge, { kind: "manual", success: true, message: `Edited by admin: ${changes.join(", ")}.` });
        await charge.save();
        return sendOk(res, "Charge updated.", { charge: formatCharge(charge) });
    } catch (e) {
        return sendServerError(res, "updateCharge", e);
    }
};

/**
 * Gateway ke bahar mila paisa (cash / bank transfer / check) mark karna
 * body: { method, paidAt?, notes? }
 */
const markChargePaid = async (req, res) => {
    try {
        const { charge, status, message } = await findCharge(req, req.params.id, "+events");
        if (!charge) return sendError(res, status, message);
        if (["paid", "refunded", "cancelled"].includes(charge.status)) return sendError(res, 409, `This charge is already ${charge.status}.`);

        const body = req.body || {};
        const method = String(body.method || "cash").trim();
        const offline = PAYMENT_METHODS.filter((m) => !["card", "saved_card", "standing_order", ""].includes(m));
        if (!offline.includes(method)) return sendError(res, 400, `Method must be one of: ${offline.join(", ")}.`);

        let paidAt = new Date();
        if (body.paidAt) {
            const m = moment(body.paidAt, ["YYYY-MM-DD", moment.ISO_8601], true);
            if (!m.isValid()) return sendError(res, 400, "Paid date must be YYYY-MM-DD.");
            paidAt = m.toDate();
        }

        charge.status = "paid";
        charge.plan = "one_time";
        charge.pendingPlan = "";
        charge.method = method;
        charge.paidAt = paidAt;
        charge.paidBy = req.user._id;
        charge.checkoutStartedAt = null;
        if (body.notes !== undefined) charge.notes = String(body.notes).trim().slice(0, 500);
        addEvent(charge, { kind: "manual", success: true, message: `Marked paid (${method}) by admin.` });
        await charge.save();

        return sendOk(res, "Charge marked as paid.", { charge: formatCharge(charge) });
    } catch (e) {
        return sendServerError(res, "markChargePaid", e);
    }
};

/**
 * Bill cancel. Standing Order chal raha ho toh Tranzila mein bhi band hota hai (aage ki kisht nahi kategi).
 * Paid one-time bill cancel nahi hota, uska refund karo.
 * body: { reason? }
 */
const cancelCharge = async (req, res) => {
    try {
        const { charge, status, message } = await findCharge(req, req.params.id, "+events");
        if (!charge) return sendError(res, status, message);
        if (["cancelled", "refunded"].includes(charge.status)) return sendError(res, 409, `This charge is already ${charge.status}.`);

        const reason = String(req.body?.reason || "").trim().slice(0, 200);
        const so = charge.standingOrder;

        if (charge.status === "paid" && charge.plan === "standing_order" && so?.stoId) {
            if (so.stoStatus !== "inactive") {
                const { provider } = await providerForClub(charge.clubId, { requireActive: false });
                await provider.cancelStandingOrder({ stoId: so.stoId, terminal: so.terminal });
                so.stoStatus = "inactive";
                charge.markModified("standingOrder");
            }
            // Jo kisht kat chuki wo paid hi rahengi, aage ki "cancelled" dikhengi
            addEvent(charge, { kind: "manual", success: true, message: `Standing order stopped by admin. ${reason}`.trim() });
            await charge.save();
            return sendOk(res, "Standing order stopped. No more monthly payments will be taken.", { charge: formatCharge(charge) });
        }

        if (charge.status === "paid") return sendError(res, 409, "This charge is already paid. Refund it instead.");

        charge.status = "cancelled";
        charge.checkoutStartedAt = null;
        addEvent(charge, { kind: "manual", success: true, message: `Cancelled by admin. ${reason}`.trim() });
        await charge.save();
        return sendOk(res, "Charge cancelled.", { charge: formatCharge(charge) });
    } catch (e) {
        return sendServerError(res, "cancelCharge", e);
    }
};

/**
 * Refund (pura ya aadha). manual = true: paisa gateway ke bahar lauta diya (sirf record).
 * Standing Order ka refund sirf pehli kisht ka hota hai (baaki kisht My Tranzila se).
 * body: { amount?, reason?, manual? }
 */
const refundCharge = async (req, res) => {
    try {
        const { charge, status, message } = await findCharge(req, req.params.id, "+events +paymentToken +tokenExpMonth +tokenExpYear");
        if (!charge) return sendError(res, status, message);
        if (charge.status !== "paid") return sendError(res, 409, "Only paid charges can be refunded.");

        const body = req.body || {};
        const manual = [true, "true", "1", 1].includes(body.manual) || !["card", "standing_order"].includes(charge.method);
        const firstAmount = charge.plan === "standing_order" ? charge.standingOrder?.firstAmount || 0 : charge.amount;
        const refundable = round((manual ? amounts(charge).paid + (charge.refundedAmount || 0) : firstAmount) - (charge.refundedAmount || 0));

        const amount = body.amount === undefined || body.amount === "" ? refundable : round(Number(body.amount));
        if (!(amount > 0)) return sendError(res, 400, "Refund amount must be more than 0.");
        if (amount > refundable) return sendError(res, 400, `You can refund up to ${refundable}.`);
        const reason = String(body.reason || "").trim().slice(0, 200);

        let providerTxnId = "";
        if (!manual) {
            const { provider } = await providerForClub(charge.clubId, { requireActive: false });
            const token = charge.paymentToken ? { token: decrypt(charge.paymentToken), expMonth: charge.tokenExpMonth, expYear: charge.tokenExpYear } : null;
            const result = await provider.refund({
                amount,
                currency: charge.currency,
                providerTxnId: charge.providerTxnId,
                authNumber: charge.authNumber,
                token,
                reason: reason || `Refund ${charge.invoiceNumber}`,
            });
            addEvent(charge, { kind: "refund", success: result.success, message: result.message, raw: result.raw });
            if (!result.success) {
                await charge.save();
                return sendError(res, 402, `Refund failed: ${result.message}`);
            }
            providerTxnId = result.providerTxnId;
        } else {
            addEvent(charge, { kind: "refund", success: true, message: `Manual refund recorded by admin. ${reason}`.trim() });
        }

        charge.refunds.push({ amount, reason, providerTxnId, manual, by: req.user._id });
        charge.refundedAmount = round((charge.refundedAmount || 0) + amount);
        const fullyRefunded = charge.plan === "one_time" && charge.refundedAmount >= charge.amount;
        if (fullyRefunded) charge.status = "refunded";
        await charge.save();

        return sendOk(res, "Refund done.", { charge: formatCharge(charge) });
    } catch (e) {
        return sendServerError(res, "refundCharge", e);
    }
};

/**
 * Tranzila receipt ka link (aakhri wali). data.url browser / app mein kholo.
 */
const getChargeReceipt = async (req, res) => {
    try {
        const { charge, status, message } = await findCharge(req, req.params.id);
        if (!charge) return sendError(res, status, message);
        if (!["paid", "refunded"].includes(charge.status) || !["card", "standing_order"].includes(charge.method)) {
            return sendError(res, 404, "No Tranzila receipt for this charge.");
        }
        const receipt = await latestReceipt(charge, { email: req.query.email });
        if (!receipt) return sendError(res, 404, "Receipt is not ready yet. Please try again in a few minutes.");
        return sendOk(res, "Receipt.", { receipt: { number: receipt.number, url: receipt.url, createdAt: receipt.createdAt, amount: receipt.amount } });
    } catch (e) {
        return sendServerError(res, "getChargeReceipt", e);
    }
};

/**
 * Team roster ke payment badges (mobile coach app + admin). Coach sirf apni team.
 * query: season?
 */
const getTeamPaymentStatus = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid team id.");
        const team = await Team.findById(id).select("clubId coachId name season");
        if (!team) return sendError(res, 404, "Team not found.");

        const role = req.user.role;
        if (role === ROLES.COACH) {
            const coach = await Coach.findOne({ userId: req.user._id }).select("_id");
            if (!coach || String(team.coachId) !== String(coach._id)) return sendError(res, 404, "Team not found.");
        } else if (role === ROLES.CLUB_ADMIN) {
            if (String(team.clubId) !== String(req.clubId)) return sendError(res, 404, "Team not found.");
        } else if (role !== ROLES.SUPER_ADMIN) {
            return sendError(res, 403, "Access denied.");
        }

        const players = await Player.find({ teamId: team._id }).populate("userId", "firstname lastname profile_image");
        const filter = { playerId: { $in: players.map((p) => p._id) } };
        if (req.query.season) {
            const season = parseSeason(req.query.season);
            if (season.message) return sendError(res, 400, season.message);
            filter.season = season.value;
        }
        const charges = await Charge.find(filter);
        const byPlayer = new Map();
        charges.forEach((c) => byPlayer.set(String(c.playerId), [...(byPlayer.get(String(c.playerId)) || []), c]));

        const roster = players.map((player) => {
            const list = byPlayer.get(String(player._id)) || [];
            const jerseyStates = list.map(jerseyPaid).filter((j) => j !== null);
            return {
                playerId: player._id,
                firstname: player.userId?.firstname || "",
                lastname: player.userId?.lastname || "",
                profile_image: player.userId?.profile_image || "",
                shirtNumber: player.shirtNumber,
                badge: playerBadge(list), // paid | unpaid | overdue | pending | none
                jerseyPaid: jerseyStates.length ? jerseyStates.every(Boolean) : null,
                outstandingAmount: round(list.reduce((s, c) => s + amounts(c).outstanding, 0)),
            };
        });

        return sendOk(res, "Team payment status.", { team: { _id: team._id, name: team.name }, players: roster });
    } catch (e) {
        return sendServerError(res, "getTeamPaymentStatus", e);
    }
};

module.exports = {
    issueCharges,
    listCharges,
    getPaymentsSummary,
    getCharge,
    updateCharge,
    markChargePaid,
    cancelCharge,
    refundCharge,
    getChargeReceipt,
    getTeamPaymentStatus,
};
