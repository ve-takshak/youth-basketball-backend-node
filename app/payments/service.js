const PaymentGateway = require("../models/PaymentGateway");
const Charge = require("../models/Charge");
const { buildProvider, PaymentError } = require("./index");
const { encrypt, decrypt } = require("../helpers/secretBox");
const { round, addMonths, startOfDay } = require("../helpers/paymentStatus");

// Controllers aur gateway adapters ke beech ki layer: club ka gateway, URLs, webhook apply, STO sync, receipt.

const MAX_EVENTS = 50;
const STO_SYNC_MINUTES = 60; // Tranzila se STO itni der mein ek baar refresh

// Tranzila ko ye URL internet se dikhna chahiye (localhost nahi). PAYMENT_PUBLIC_URL, warna BASE_URL.
const publicBase = () => String(process.env.PAYMENT_PUBLIC_URL || process.env.BASE_URL || "").replace(/\/+$/, "");

const webhookUrl = (gateway, params = {}) => {
    const query = new URLSearchParams(params).toString();
    return `${publicBase()}/api/payments/webhook/${gateway._id}/${gateway.webhookKey}${query ? `?${query}` : ""}`;
};

const returnUrls = (gateway, chargeId) => ({
    success: `${publicBase()}/api/payments/return?result=success&charge=${chargeId}`,
    fail: `${publicBase()}/api/payments/return?result=fail&charge=${chargeId}`,
    notify: webhookUrl(gateway, { ref: String(chargeId) }),
});

// Club ka active gateway + provider. Nahi hai toh PaymentError.
const providerForClub = async (clubId, { requireActive = true } = {}) => {
    const gateway = await PaymentGateway.findOne({ clubId });
    if (!gateway) throw new PaymentError("BAD_REQUEST", "Online payments are not set up for this club yet.");
    if (requireActive && !gateway.isActive) throw new PaymentError("BAD_REQUEST", "Online payments are turned off for this club.");
    return { gateway, provider: buildProvider(gateway) };
};

const addEvent = (charge, event) => {
    charge.events = [...(charge.events || []), { at: new Date(), ...event }].slice(-MAX_EVENTS);
};

// STO ki Tranzila wali details charge pe copy
const applySto = (charge, sto) => {
    if (!sto) return;
    const so = charge.standingOrder;
    so.stoId = sto.stoId;
    so.terminal = sto.terminal;
    so.stoStatus = sto.status;
    so.lastChargeDate = sto.lastChargeDate;
    so.nextChargeDate = sto.nextChargeDate;
    so.syncedAt = new Date();
    charge.markModified("standingOrder");
};

/**
 * Tranzila se STO refresh (har STO_SYNC_MINUTES mein ek baar, ya force).
 * Fail ho toh chup-chaap purana data rehne do: parent screen ruki nahi chahiye.
 */
const syncStandingOrder = async (charge, { force = false, provider = null } = {}) => {
    const so = charge.standingOrder;
    if (charge.plan !== "standing_order" || !so) return charge;
    if (!force && so.syncedAt && Date.now() - new Date(so.syncedAt) < STO_SYNC_MINUTES * 60000) return charge;

    try {
        const p = provider || (await providerForClub(charge.clubId, { requireActive: false })).provider;
        let sto = null;
        if (so.stoId) {
            sto = await p.getStandingOrder({ stoId: so.stoId });
        } else {
            const withToken = await Charge.findById(charge._id).select("+paymentToken");
            const token = withToken?.paymentToken ? decrypt(withToken.paymentToken) : "";
            if (token) sto = await p.getStandingOrder({ token });
        }
        if (sto) {
            applySto(charge, sto);
            await charge.save();
        }
    } catch (e) {
        console.warn(`STO sync failed for charge ${charge._id}:`, e.message);
    }
    return charge;
};

/**
 * Gateway notification. Sirf yahi charge ko "paid" karta hai (success_url pe bharosa nahi).
 * return: { status, message } (HTTP status gateway ko)
 */
const applyWebhook = async (gatewayId, key, { body, query, headers }) => {
    const gateway = await PaymentGateway.findById(gatewayId).catch(() => null);
    if (!gateway || !key || gateway.webhookKey !== key) return { status: 404, message: "Unknown endpoint." };

    const provider = buildProvider(gateway);
    const ref = String(query.ref || body.ref || "");

    // My Billing ki mahine wali notification (ref nahi hota): STO id se charge dhoondho, sync karo
    if (!ref) {
        const stoId = String(body.sto_external_id || body.sto_id || "");
        if (!stoId) return { status: 200, message: "Ignored: no reference." };
        const charge = await Charge.findOne({ clubId: gateway.clubId, "standingOrder.stoId": stoId });
        if (!charge) return { status: 200, message: "Ignored: unknown standing order." };

        const result = await provider.handleWebhook({ body, query, headers });
        addEvent(charge, { kind: "sto_webhook", success: result.success, message: result.message, raw: result.raw });
        await charge.save();
        await syncStandingOrder(charge, { force: true, provider });
        return { status: 200, message: "OK" };
    }

    const charge = await Charge.findOne({ _id: ref, clubId: gateway.clubId }).catch(() => null);
    if (!charge) return { status: 200, message: "Ignored: unknown charge." };

    const isSto = charge.pendingPlan === "standing_order";
    const expectedAmount = isSto ? charge.standingOrder?.firstAmount : charge.amount;
    const result = await provider.handleWebhook({ body, query, headers, expected: { amount: expectedAmount, currency: charge.currency } });
    addEvent(charge, { kind: "webhook", success: result.success, message: result.message, raw: result.raw });

    // Same transaction dobara aaye (Tranzila retry) toh kuch mat badlo
    if (charge.status === "paid") {
        await charge.save();
        return { status: 200, message: "Already paid." };
    }

    if (!result.ok || !result.success) {
        charge.status = "failed";
        charge.checkoutStartedAt = null;
        await charge.save();
        return { status: 200, message: result.message };
    }

    charge.status = "paid";
    charge.plan = isSto ? "standing_order" : "one_time";
    charge.pendingPlan = "";
    charge.paidAt = new Date();
    charge.method = isSto ? "standing_order" : "card";
    charge.provider = gateway.provider;
    charge.providerTxnId = result.providerTxnId;
    charge.authNumber = result.authNumber;
    charge.card = { last4: result.card?.last4 || "", brand: result.card?.brand || "" };
    charge.checkoutStartedAt = null;
    if (result.token) {
        charge.paymentToken = encrypt(result.token);
        charge.tokenExpMonth = result.card?.expMonth || null;
        charge.tokenExpYear = result.card?.expYear || null;
    }
    await charge.save();

    if (isSto) await syncStandingOrder(charge, { force: true, provider });
    return { status: 200, message: "OK" };
};

/**
 * Standing Order checkout ke liye dates / amounts. Pehli kisht aaj, baaki har mahine.
 * charge_dom 1-28 hi ho sakta hai (Tranzila), isliye 29-31 ko 28 kar dete hain.
 */
const planDates = () => {
    const first = startOfDay();
    const next = new Date(first.getFullYear(), first.getMonth() + 1, Math.min(first.getDate(), 28));
    return { firstChargeDate: first, recurStartDate: next };
};

/**
 * Aakhri receipt (Tranzila RE). Pehle transaction id se, Standing Order mein email se (har mahine nayi receipt).
 */
const latestReceipt = async (charge, { email } = {}) => {
    const { provider } = await providerForClub(charge.clubId, { requireActive: false });
    const from = addMonths(charge.paidAt || charge.createdAt, -1);

    let receipt = null;
    if (charge.plan === "standing_order" && email) receipt = await provider.getReceipt({ email, from });
    if (!receipt && charge.providerTxnId) receipt = await provider.getReceipt({ providerTxnIds: [charge.providerTxnId], from });
    if (!receipt) return null;

    charge.receipt = { documentId: receipt.documentId, number: receipt.number, retrievalKey: receipt.retrievalKey };
    await charge.save();
    return receipt;
};

module.exports = {
    publicBase,
    webhookUrl,
    returnUrls,
    providerForClub,
    addEvent,
    applyWebhook,
    syncStandingOrder,
    planDates,
    latestReceipt,
    round,
};
