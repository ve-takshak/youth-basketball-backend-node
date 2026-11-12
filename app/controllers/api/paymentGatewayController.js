const Club = require("../../models/Club");
const PaymentGateway = require("../../models/PaymentGateway");
const { GATEWAY_MODES } = require("../../models/PaymentGateway");
const { listProviders, getProviderClass, PaymentError } = require("../../payments");
const { webhookUrl } = require("../../payments/service");
const { encrypt, decrypt, mask } = require("../../helpers/secretBox");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");

// Club ka payment gateway (Tranzila / Cardcom / PayPlus / HYP) + test console + club ki payment settings.
//   GET  /user/payments/providers
//   GET  /user/clubs/:id/payment-gateway
//   PUT  /user/clubs/:id/payment-gateway
//   POST /user/clubs/:id/payment-gateway/test
//   PUT  /user/clubs/:id/payment-settings

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

const sendServerError = (res, label, e) => {
    console.error(`${label} error:`, e);
    return res.status(500).json({ error: true, status: 500, message: "Something went wrong.", message_desc: e.message, data: {} });
};

const sendOk = (res, message, data = {}) => res.status(200).json({ error: false, status: 200, message, message_desc: message, data });

// clubAdmin sirf apna club, superAdmin sab
const findClub = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid club id." };
    if (req.user.role !== ROLES.SUPER_ADMIN && String(req.clubId) !== String(id)) return { status: 404, message: "Club not found." };
    const club = await Club.findById(id);
    if (!club) return { status: 404, message: "Club not found." };
    return { club };
};

const storedCredentials = (gateway) => {
    const out = {};
    const map = gateway?.credentials instanceof Map ? Object.fromEntries(gateway.credentials) : gateway?.credentials || {};
    Object.entries(map).forEach(([key, box]) => {
        try {
            out[key] = decrypt(box);
        } catch (e) {
            out[key] = ""; // key badal gayi: dobara save karna padega
        }
    });
    return out;
};

// Secret kabhi wapas nahi jaata: sirf "set hai" + mask
const formatGateway = (gateway) => {
    if (!gateway) return null;
    const Provider = getProviderClass(gateway.provider);
    const plain = storedCredentials(gateway);
    const credentials = {};
    (Provider?.credentialFields || []).forEach((field) => {
        const value = plain[field.key] || "";
        credentials[field.key] = field.secret ? { set: !!value, value: mask(value) } : { set: !!value, value };
    });

    return {
        _id: gateway._id,
        clubId: gateway.clubId,
        provider: gateway.provider,
        providerLabel: Provider?.label || gateway.provider,
        implemented: !!Provider?.implemented,
        mode: gateway.mode,
        isActive: gateway.isActive,
        credentials,
        // Tranzila My Billing > Settings mein "notification URL" yahi daalna (Standing Order ki har mahine wali payment)
        webhookUrl: webhookUrl(gateway),
        lastTest: gateway.lastTest?.at ? gateway.lastTest : null,
        updatedAt: gateway.updatedAt,
    };
};

/**
 * Saare payment gateways aur unke key fields (config screen ka form inhi se banta hai)
 */
const listPaymentProviders = async (req, res) => {
    try {
        return sendOk(res, "Payment providers.", { providers: listProviders(), modes: GATEWAY_MODES });
    } catch (e) {
        return sendServerError(res, "listPaymentProviders", e);
    }
};

/**
 * Club ka gateway config (secret keys masked). Gateway nahi joda toh data.gateway = null
 */
const getPaymentGateway = async (req, res) => {
    try {
        const { club, status, message } = await findClub(req, req.params.id);
        if (!club) return sendError(res, status, message);

        const gateway = await PaymentGateway.findOne({ clubId: club._id });
        return sendOk(res, "Payment gateway.", {
            gateway: formatGateway(gateway),
            paymentSettings: club.paymentSettings,
            providers: listProviders(),
        });
    } catch (e) {
        return sendServerError(res, "getPaymentGateway", e);
    }
};

// Body ki credentials + purani saved (secret khaali bheja = purana hi rakho, sirf same provider pe)
const mergeCredentials = (Provider, body = {}, previous = {}) => {
    const merged = {};
    Provider.credentialFields.forEach((field) => {
        const sent = body[field.key];
        if (sent === undefined || (field.secret && String(sent).trim() === "")) {
            merged[field.key] = previous[field.key] || "";
        } else {
            merged[field.key] = typeof sent === "boolean" ? String(sent) : String(sent).trim();
        }
    });
    return merged;
};

/**
 * Gateway jodna / badalna. Secret field khaali chhodo toh purani value rehti hai.
 * body: { provider, mode?, isActive?, credentials: { terminalName, appKey, secretKey, ... } }
 */
const savePaymentGateway = async (req, res) => {
    try {
        const { club, status, message } = await findClub(req, req.params.id);
        if (!club) return sendError(res, status, message);

        const body = req.body || {};
        const providerId = String(body.provider || "").trim().toLowerCase();
        const Provider = getProviderClass(providerId);
        if (!Provider) return sendError(res, 400, `Provider must be one of: ${listProviders().map((p) => p.id).join(", ")}.`);

        const mode = body.mode === undefined ? undefined : String(body.mode).trim().toLowerCase();
        if (mode !== undefined && !GATEWAY_MODES.includes(mode)) return sendError(res, 400, `Mode must be one of: ${GATEWAY_MODES.join(", ")}.`);

        let credentialsBody = body.credentials;
        if (typeof credentialsBody === "string") {
            try {
                credentialsBody = JSON.parse(credentialsBody);
            } catch (e) {
                return sendError(res, 400, "Credentials must be an object.");
            }
        }
        if (credentialsBody !== undefined && (typeof credentialsBody !== "object" || credentialsBody === null)) {
            return sendError(res, 400, "Credentials must be an object.");
        }

        let gateway = await PaymentGateway.findOne({ clubId: club._id });
        const previous = gateway && gateway.provider === providerId ? storedCredentials(gateway) : {};
        const merged = mergeCredentials(Provider, credentialsBody || {}, previous);

        const invalid = Provider.validateCredentials(merged);
        if (invalid) return sendError(res, 400, invalid);

        const encrypted = {};
        Object.entries(merged).forEach(([key, value]) => {
            if (value) encrypted[key] = encrypt(value);
        });

        if (!gateway) gateway = new PaymentGateway({ clubId: club._id, provider: providerId });
        const changedProvider = gateway.provider !== providerId;
        gateway.provider = providerId;
        gateway.credentials = encrypted;
        if (mode !== undefined) gateway.mode = mode;
        if (body.isActive !== undefined) gateway.isActive = [true, "true", "1", 1].includes(body.isActive);
        // Keys badli toh purana test result ab sach nahi
        gateway.lastTest = { at: null, ok: null, message: "", checks: [] };
        if (changedProvider) gateway.isActive = body.isActive === undefined ? true : gateway.isActive;
        gateway.updatedBy = req.user._id;
        await gateway.save();

        return sendOk(res, "Payment gateway saved.", { gateway: formatGateway(gateway) });
    } catch (e) {
        if (e.message?.includes("PAYMENT_ENCRYPTION_KEY")) return sendError(res, 500, e.message);
        return sendServerError(res, "savePaymentGateway", e);
    }
};

/**
 * Test console: terminal se baat hoti hai? keys sahi? Koi paisa nahi katta.
 * Body mein provider + credentials bhejo toh bina save kiye unhe test karta hai, warna saved config.
 * body: { provider?, credentials? }
 */
const testPaymentGateway = async (req, res) => {
    try {
        const { club, status, message } = await findClub(req, req.params.id);
        if (!club) return sendError(res, status, message);

        const body = req.body || {};
        const gateway = await PaymentGateway.findOne({ clubId: club._id });
        const providerId = String(body.provider || gateway?.provider || "").trim().toLowerCase();
        const Provider = getProviderClass(providerId);
        if (!Provider) return sendError(res, 400, "Choose a payment provider first.");

        const draft = body.credentials && typeof body.credentials === "object";
        const previous = gateway && gateway.provider === providerId ? storedCredentials(gateway) : {};
        const credentials = draft ? mergeCredentials(Provider, body.credentials, previous) : previous;

        const started = Date.now();
        let result;
        try {
            result = await new Provider(credentials, { mode: gateway?.mode }).testConnection();
        } catch (e) {
            if (!(e instanceof PaymentError)) throw e;
            result = { ok: false, checks: [{ name: "Connection", ok: false, message: e.message }], message: e.message };
        }
        result.durationMs = Date.now() - started;
        result.testedDraft = !!draft;

        // Saved config ka result yaad rakho (draft ka nahi)
        if (gateway && !draft && gateway.provider === providerId) {
            gateway.lastTest = { at: new Date(), ok: result.ok, message: result.message, checks: result.checks };
            await gateway.save();
        }

        return sendOk(res, result.message, { result });
    } catch (e) {
        return sendServerError(res, "testPaymentGateway", e);
    }
};

/**
 * Club ki payment settings (club owner dashboard)
 * body: { allowAppWithUnpaidJersey?, allowStandingOrder?, maxInstallments? }
 */
const updatePaymentSettings = async (req, res) => {
    try {
        const { club, status, message } = await findClub(req, req.params.id);
        if (!club) return sendError(res, status, message);

        const body = req.body || {};
        const bool = (v) => [true, "true", "1", 1].includes(v);
        const settings = club.paymentSettings || {};

        if (body.allowAppWithUnpaidJersey !== undefined) settings.allowAppWithUnpaidJersey = bool(body.allowAppWithUnpaidJersey);
        if (body.allowStandingOrder !== undefined) settings.allowStandingOrder = bool(body.allowStandingOrder);
        if (body.maxInstallments !== undefined) {
            const n = Number(body.maxInstallments);
            if (!Number.isInteger(n) || n < 2 || n > 12) return sendError(res, 400, "Max installments must be a whole number from 2 to 12.");
            settings.maxInstallments = n;
        }

        club.paymentSettings = settings;
        await club.save();
        return sendOk(res, "Payment settings saved.", { paymentSettings: club.paymentSettings });
    } catch (e) {
        return sendServerError(res, "updatePaymentSettings", e);
    }
};

module.exports = { listPaymentProviders, getPaymentGateway, savePaymentGateway, testPaymentGateway, updatePaymentSettings };
