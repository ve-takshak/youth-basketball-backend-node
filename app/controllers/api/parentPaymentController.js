const Charge = require("../../models/Charge");
const Club = require("../../models/Club");
const Parent = require("../../models/Parent");
const Player = require("../../models/Player");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { chargeBadge, amounts, splitPlan, round } = require("../../helpers/paymentStatus");
const { formatCharge, PLAYER_POPULATE } = require("../../helpers/chargeFormat");
const { providerForClub, returnUrls, addEvent, syncStandingOrder, planDates, latestReceipt } = require("../../payments/service");
const { PaymentError } = require("../../payments");

// Parent (mobile app): apne bachchon ke bills dekhna aur pay karna. Senior player apna khud.
//   GET  /user/parent/payments
//   POST /user/parent/payments/:id/checkout
//   GET  /user/parent/payments/:id/receipt
//
// Pay ka flow:
//   1. App checkout call karti hai -> data.checkout.url milta hai
//   2. App ye URL WebView / browser mein kholti hai (Tranzila ka page, card wahi bharta hai)
//   3. Tranzila hamare webhook pe result bhejta hai -> bill "paid"
//   4. Tranzila .../api/payments/return?result=success|fail pe bhejta hai -> app WebView band karke list refresh kare

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

const sendServerError = (res, label, e) => {
    if (e instanceof PaymentError) {
        const status = ["NOT_IMPLEMENTED", "BAD_REQUEST"].includes(e.code) ? 400 : 502;
        return sendError(res, status, e.message, { code: e.code });
    }
    console.error(`${label} error:`, e);
    return res.status(500).json({ error: true, status: 500, message: "Something went wrong.", message_desc: e.message, data: {} });
};

const sendOk = (res, message, data = {}) => res.status(200).json({ error: false, status: 200, message, message_desc: message, data });

// Is user ke player ids (parent: bachche, senior: khud)
const myPlayerIds = async (user) => {
    if (user.role === ROLES.PARENT) {
        const parent = await Parent.findOne({ userId: user._id }).select("_id");
        if (!parent) return [];
        return Player.find({ "parents.parentId": parent._id }).distinct("_id");
    }
    if (user.role === ROLES.SENIOR_PLAYER) {
        return Player.find({ userId: user._id }).distinct("_id");
    }
    return null;
};

const findMyCharge = async (req, id, select = "") => {
    const ids = await myPlayerIds(req.user);
    if (ids === null) return { status: 403, message: "Only parents and senior players can pay." };
    if (!isValidId(id)) return { status: 400, message: "Invalid charge id." };

    const charge = await Charge.findOne({ _id: id, playerId: { $in: ids } }).select(select).populate(PLAYER_POPULATE);
    if (!charge) return { status: 404, message: "Charge not found." };
    return { charge };
};

/**
 * Mere bachchon ke saare bills: items, badge, jersey paid, Standing Order schedule, total baaki.
 * Har bill ke saath data.options: pay once / standing order (kitni kisht tak, har mahine kitna).
 * query: season?
 */
const listMyPayments = async (req, res) => {
    try {
        const ids = await myPlayerIds(req.user);
        if (ids === null) return sendError(res, 403, "Only parents and senior players can see payments.");

        const filter = { playerId: { $in: ids }, status: { $ne: "cancelled" } };
        if (req.query.season) filter.season = String(req.query.season);
        const charges = await Charge.find(filter).sort({ createdAt: -1 }).populate(PLAYER_POPULATE);

        // Standing Order wale bills Tranzila se refresh (ghante mein ek baar)
        await Promise.all(charges.filter((c) => c.plan === "standing_order").map((c) => syncStandingOrder(c)));

        const clubIds = [...new Set(charges.map((c) => String(c.clubId)))];
        const clubs = await Club.find({ _id: { $in: clubIds } }).select("paymentSettings");
        const settingsByClub = new Map(clubs.map((c) => [String(c._id), c.paymentSettings || {}]));

        const list = charges.map((charge) => {
            const out = formatCharge(charge);
            const settings = settingsByClub.get(String(charge.clubId)) || {};
            const canPay = ["unpaid", "overdue", "pending"].includes(out.badge) || charge.status === "failed";
            const max = settings.maxInstallments || 10;
            out.options = canPay
                ? {
                      oneTime: { amount: charge.amount },
                      standingOrder:
                          settings.allowStandingOrder !== false && max >= 2
                              ? {
                                    maxInstallments: max,
                                    // App dropdown ke liye: har option pe pehli aur mahine ki kisht
                                    choices: Array.from({ length: max - 1 }, (_, i) => {
                                        const n = i + 2;
                                        const split = splitPlan(charge.items, n);
                                        return { installments: n, firstAmount: split.firstAmount, monthlyAmount: split.monthlyAmount };
                                    }),
                                }
                              : null,
                  }
                : null;
            return out;
        });

        const outstanding = round(charges.reduce((s, c) => s + amounts(c).outstanding, 0));
        return sendOk(res, "My payments.", { charges: list, totalOutstanding: outstanding });
    } catch (e) {
        return sendServerError(res, "listMyPayments", e);
    }
};

/**
 * Pay karna shuru. data.checkout.url app mein kholo (Tranzila ka page). Result webhook se aata hai.
 * plan "one_time" = poora ek baar mein. plan "standing_order" = jersey + pehli kisht aaj, baaki har mahine.
 * body: { plan, installments?, language? }
 */
const checkoutCharge = async (req, res) => {
    try {
        const { charge, status, message } = await findMyCharge(req, req.params.id, "+events");
        if (!charge) return sendError(res, status, message);

        const badge = chargeBadge(charge);
        if (!["unpaid", "overdue", "pending"].includes(badge) && charge.status !== "failed") {
            return sendError(res, 409, `This charge is ${badge}.`);
        }

        const body = req.body || {};
        const plan = String(body.plan || "one_time").trim();
        if (!["one_time", "standing_order"].includes(plan)) return sendError(res, 400, "Plan must be one_time or standing_order.");
        const language = body.language === "he" ? "he" : "en";

        const club = await Club.findById(charge.clubId).select("name paymentSettings");
        const settings = club?.paymentSettings || {};
        const { gateway, provider } = await providerForClub(charge.clubId);

        const user = req.user;
        const playerName = [charge.playerId?.userId?.firstname, charge.playerId?.userId?.lastname].filter(Boolean).join(" ");
        const customer = {
            name: [user.firstname, user.lastname].filter(Boolean).join(" "),
            email: user.email || "",
            phone: user.mobileNumber || "",
            idNumber: user.idNumber || "",
        };
        const description = `${charge.title}${playerName ? ` - ${playerName}` : ""}`;
        const urls = returnUrls(gateway, charge._id);

        let checkout;
        if (plan === "standing_order") {
            if (settings.allowStandingOrder === false) return sendError(res, 400, "Your club doesn't offer monthly payments.");
            const max = settings.maxInstallments || 10;
            const installments = Number(body.installments);
            if (!Number.isInteger(installments) || installments < 2 || installments > max) {
                return sendError(res, 400, `Installments must be a whole number from 2 to ${max}.`);
            }

            const split = splitPlan(charge.items, installments);
            if (!(split.monthlyAmount > 0)) return sendError(res, 400, "This charge can't be split into monthly payments.");
            const dates = planDates();

            checkout = await provider.createStandingOrder({
                firstAmount: split.firstAmount,
                monthlyAmount: split.monthlyAmount,
                installments,
                recurStartDate: dates.recurStartDate,
                currency: charge.currency,
                description,
                customer,
                urls,
                language,
            });
            charge.standingOrder = {
                installments,
                firstAmount: split.firstAmount,
                monthlyAmount: split.monthlyAmount,
                firstChargeDate: dates.firstChargeDate,
                recurStartDate: dates.recurStartDate,
            };
        } else {
            checkout = await provider.createCharge({
                amount: charge.amount,
                currency: charge.currency,
                description,
                items: charge.items,
                customer,
                urls,
                ref: String(charge._id),
                language,
            });
            charge.standingOrder = null;
        }

        charge.status = "pending";
        charge.pendingPlan = plan;
        charge.checkoutStartedAt = new Date();
        charge.paidBy = user._id;
        addEvent(charge, { kind: "checkout", success: null, message: `Checkout started (${plan}) by ${user.role}.` });
        await charge.save();

        return sendOk(res, "Open the payment page to pay.", {
            checkout: {
                url: checkout.url, // WebView / browser mein kholo
                method: checkout.method, // "GET"
                action: checkout.action, // web: POST form ka action
                fields: checkout.fields, // web: POST form ke hidden fields
                successUrlPrefix: urls.success.split("?")[0], // is URL pe aate hi WebView band karo
                expiresInMinutes: 20,
            },
            plan,
            amountToday: plan === "standing_order" ? charge.standingOrder.firstAmount : charge.amount,
            charge: formatCharge(charge),
        });
    } catch (e) {
        return sendServerError(res, "checkoutCharge", e);
    }
};

/**
 * Aakhri Tranzila receipt ka link. App data.receipt.url browser mein khole (PDF / page).
 */
const getMyReceipt = async (req, res) => {
    try {
        const { charge, status, message } = await findMyCharge(req, req.params.id);
        if (!charge) return sendError(res, status, message);
        if (!["paid", "refunded"].includes(charge.status) || !["card", "standing_order"].includes(charge.method)) {
            return sendError(res, 404, "There is no receipt for this charge yet.");
        }

        const receipt = await latestReceipt(charge, { email: req.user.email });
        if (!receipt) return sendError(res, 404, "Your receipt is not ready yet. Please try again in a few minutes.");
        return sendOk(res, "Receipt.", { receipt: { number: receipt.number, url: receipt.url, createdAt: receipt.createdAt, amount: receipt.amount } });
    } catch (e) {
        return sendServerError(res, "getMyReceipt", e);
    }
};

module.exports = { listMyPayments, checkoutCharge, getMyReceipt };
