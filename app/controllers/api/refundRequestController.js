const mongoose = require("mongoose");
const Charge = require("../../models/Charge");
const RefundRequest = require("../../models/RefundRequest");
const { REFUND_REQUEST_STATUSES, OPEN_STATUSES } = require("../../models/RefundRequest");
const { ROLES } = require("../../helpers/constants");
const { isValidId, getPagination } = require("../../helpers/common");
const { refundQuote } = require("../../helpers/refundQuote");
const { formatCharge, PLAYER_POPULATE } = require("../../helpers/chargeFormat");
const { executeRefund, addEvent } = require("../../payments/service");
const { PaymentError } = require("../../payments");

// Club owner: parents ke refund requests review karna (yearly ek baar pay / camp, beech mein chhoda).
//   GET  /user/payments/refund-requests               list (?status=pending)
//   GET  /user/payments/refund-requests/:id           request + bill + aaj ka hisaab
//   PUT  /user/payments/refund-requests/:id/approve   gateway (Tranzila) se refund, pura ya aadha
//   PUT  /user/payments/refund-requests/:id/reject
// Parent request bhejta hai: POST /user/parent/payments/:id/refund-request (parentPaymentController)

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });
const sendOk = (res, message, data = {}) => res.status(200).json({ error: false, status: 200, message, message_desc: message, data });
const sendServerError = (res, label, e) => {
    if (e instanceof PaymentError) {
        const status = ["NOT_IMPLEMENTED", "BAD_REQUEST"].includes(e.code) ? 400 : 502;
        return sendError(res, status, e.message, { code: e.code });
    }
    console.error(`${label} error:`, e);
    return res.status(500).json({ error: true, status: 500, message: "Something went wrong.", message_desc: e.message, data: {} });
};

const isSuperAdmin = (req) => req.user.role === ROLES.SUPER_ADMIN;

const CHARGE_SUMMARY = "invoiceNumber title season amount currency category plan status refundedAmount items playerId";
const REQUEST_POPULATE = [
    { path: "chargeId", select: CHARGE_SUMMARY },
    { path: "playerId", select: "userId", populate: { path: "userId", select: "firstname lastname profile_image" } },
    { path: "requestedBy", select: "firstname lastname mobileNumber email" },
];

const formatRefundRequest = (r) => {
    const charge = r.chargeId && r.chargeId._id ? r.chargeId : null;
    const player = r.playerId && r.playerId._id ? r.playerId : null;
    const by = r.requestedBy && r.requestedBy._id ? r.requestedBy : null;
    return {
        _id: r._id,
        status: r.status, // pending | processing | refunded | rejected | failed
        reason: r.reason,
        lastDay: r.lastDay,
        quote: r.quote, // request ke waqt ka hisaab (bache mahine / din, suggestedAmount)
        currency: r.currency,
        charge: charge
            ? {
                  _id: charge._id,
                  invoiceNumber: charge.invoiceNumber,
                  title: charge.title,
                  season: charge.season,
                  amount: charge.amount,
                  category: charge.category,
                  plan: charge.plan,
                  status: charge.status,
                  refundedAmount: charge.refundedAmount || 0,
              }
            : { _id: r.chargeId },
        player: player ? { _id: player._id, firstname: player.userId?.firstname || "", lastname: player.userId?.lastname || "" } : { _id: r.playerId },
        requestedBy: by ? { _id: by._id, firstname: by.firstname || "", lastname: by.lastname || "" } : { _id: r.requestedBy },
        reviewedAt: r.reviewedAt,
        reviewNote: r.reviewNote,
        refundedAmount: r.refundedAmount || 0,
        manual: Boolean(r.manual),
        failureMessage: r.failureMessage || "",
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    };
};

const findRequest = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid refund request id." };
    const request = await RefundRequest.findById(id);
    if (!request || (!isSuperAdmin(req) && String(request.clubId) !== String(req.clubId))) return { status: 404, message: "Refund request not found." };
    return { request };
};

/**
 * Club ke refund requests, naye pehle.
 * query: clubId? (superAdmin), status? (pending | processing | refunded | rejected | failed), page?, limit?
 */
const listRefundRequests = async (req, res) => {
    try {
        const filter = {};
        if (isSuperAdmin(req)) {
            if (req.query.clubId) {
                if (!isValidId(req.query.clubId)) return sendError(res, 400, "Invalid club id.");
                filter.clubId = new mongoose.Types.ObjectId(String(req.query.clubId));
            }
        } else {
            filter.clubId = req.clubId;
        }
        if (req.query.status) {
            if (!REFUND_REQUEST_STATUSES.includes(String(req.query.status))) {
                return sendError(res, 400, `Status must be one of: ${REFUND_REQUEST_STATUSES.join(", ")}.`);
            }
            filter.status = String(req.query.status);
        }
        const { page, limit, skip } = getPagination(req.query);
        const [requests, total, pending] = await Promise.all([
            RefundRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate(REQUEST_POPULATE),
            RefundRequest.countDocuments(filter),
            RefundRequest.countDocuments({ ...filter, status: "pending" }),
        ]);
        return sendOk(res, "Refund requests.", {
            refundRequests: requests.map(formatRefundRequest),
            pendingCount: pending,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (e) {
        return sendServerError(res, "listRefundRequests", e);
    }
};

/**
 * Ek request: bill, request ke waqt ka hisaab, aur aaj ka hisaab (currentQuote: tab se kuch aur refund hua ho toh).
 */
const getRefundRequest = async (req, res) => {
    try {
        const { request, status, message } = await findRequest(req, req.params.id);
        if (!request) return sendError(res, status, message);
        await request.populate(REQUEST_POPULATE);
        const charge = await Charge.findById(request.chargeId?._id || request.chargeId).populate(PLAYER_POPULATE);
        return sendOk(res, "Refund request.", {
            refundRequest: formatRefundRequest(request),
            currentQuote: charge ? refundQuote(charge, request.lastDay) : null,
            charge: charge ? formatCharge(charge) : null,
        });
    } catch (e) {
        return sendServerError(res, "getRefundRequest", e);
    }
};

/**
 * Approve = isi waqt refund. Gateway (Tranzila credit) se, ya manual = true (cash / bank se lauta diya, sirf record).
 * amount na do = suggestedAmount (bache mahine / din ka). Pura refund: amount = bill ka bacha hua.
 * Gateway fail ho toh request "failed" (wajah ke saath), dobara approve kar sakte hain.
 * body: { amount?, manual?, note? }
 */
const approveRefundRequest = async (req, res) => {
    let locked = null;
    try {
        const { request, status, message } = await findRequest(req, req.params.id);
        if (!request) return sendError(res, status, message);
        if (!OPEN_STATUSES.includes(request.status)) return sendError(res, 409, `This request is already ${request.status}.`);

        const body = req.body || {};
        const note = String(body.note || "").trim().slice(0, 500);
        const manual = [true, "true", "1", 1].includes(body.manual);

        const charge = await Charge.findById(request.chargeId).select("+events +paymentToken +tokenExpMonth +tokenExpYear").populate(PLAYER_POPULATE);
        if (!charge) return sendError(res, 404, "The bill for this request was not found.");

        const quote = refundQuote(charge, request.lastDay);
        if (!quote.eligible) return sendError(res, 409, quote.reason);
        let amount = body.amount;
        if (amount === undefined || amount === null || amount === "") {
            amount = quote.suggestedAmount;
            if (!(amount > 0)) return sendError(res, 400, "Enter the refund amount.", { quote });
        }

        // Lock: do admin / double click se do refund na ho
        locked = await RefundRequest.findOneAndUpdate(
            { _id: request._id, status: { $in: OPEN_STATUSES } },
            { $set: { status: "processing" } },
            { new: true }
        );
        if (!locked) return sendError(res, 409, "This request is already being handled.");

        const reason = `Refund request${request.reason ? `: ${request.reason}` : ""}`.slice(0, 200);
        const result = await executeRefund(charge, { amount, reason, manual, userId: req.user._id });

        locked.reviewedBy = req.user._id;
        locked.reviewedAt = new Date();
        locked.reviewNote = note;
        if (!result.ok) {
            locked.status = "failed";
            locked.failureMessage = result.message;
            await locked.save();
            return sendError(res, result.status || 400, result.message, { refundable: result.refundable, refundRequest: formatRefundRequest(locked) });
        }

        locked.status = "refunded";
        locked.refundedAmount = result.amount;
        locked.manual = result.manual;
        locked.providerTxnId = result.providerTxnId || "";
        locked.failureMessage = "";
        await locked.save();

        // Player ne chhod diya: bill pe "band" ka record (jersey ka bill alag hai, use kuch nahi hota)
        if (!charge.stopped?.at) {
            charge.stopped = { at: new Date(), by: req.user._id, reason: "Refund request approved" };
            addEvent(charge, { kind: "manual", success: true, message: `Refund request approved (${result.amount}).` });
            await charge.save();
        }

        await locked.populate(REQUEST_POPULATE);
        return sendOk(res, result.manual ? "Refund recorded." : "Refund sent through the payment gateway.", {
            refundRequest: formatRefundRequest(locked),
            charge: formatCharge(charge),
        });
    } catch (e) {
        // Gateway exception: lock khol do taaki dobara try ho sake
        if (locked) {
            await RefundRequest.updateOne({ _id: locked._id, status: "processing" }, { $set: { status: "failed", failureMessage: e.message } }).catch(() => {});
        }
        return sendServerError(res, "approveRefundRequest", e);
    }
};

/**
 * Mana karna. Parent ko reviewNote dikhta hai.
 * body: { note? }
 */
const rejectRefundRequest = async (req, res) => {
    try {
        const { request, status, message } = await findRequest(req, req.params.id);
        if (!request) return sendError(res, status, message);

        const updated = await RefundRequest.findOneAndUpdate(
            { _id: request._id, status: { $in: OPEN_STATUSES } },
            { $set: { status: "rejected", reviewedBy: req.user._id, reviewedAt: new Date(), reviewNote: String(req.body?.note || "").trim().slice(0, 500) } },
            { new: true }
        ).populate(REQUEST_POPULATE);
        if (!updated) return sendError(res, 409, `This request is already ${request.status}.`);
        return sendOk(res, "Refund request rejected.", { refundRequest: formatRefundRequest(updated) });
    } catch (e) {
        return sendServerError(res, "rejectRefundRequest", e);
    }
};

module.exports = { listRefundRequests, getRefundRequest, approveRefundRequest, rejectRefundRequest, formatRefundRequest, REQUEST_POPULATE };
