// Har payment gateway (Tranzila, Cardcom, PayPlus, HYP) isi class ko extend karta hai.
// Controllers sirf in methods ko call karte hain, kaunsa gateway hai isse unhe fark nahi padta.
//
// Card number kabhi hamare server pe nahi aata (PCI). Card wala kaam gateway ke hosted page (iframe) pe hota hai,
// hamare paas sirf token aata hai. Isliye createCharge / tokenizeCard do tarah ka result dete hain:
//   { kind: "redirect", url, method, fields }   -> app ye page kholegi, result webhook pe aayega
//   { kind: "completed", ...ChargeResult }       -> saved token se seedha charge ho gaya
//
// ChargeResult:   { success, providerTxnId, authNumber, amount, currency, token?, card?: { last4, expMonth, expYear, brand }, message, raw }
// WebhookResult:  { ok, purpose: "charge" | "tokenize", ref, success, amount, currency, providerTxnId, authNumber, token?, card?, message, raw }

class PaymentError extends Error {
    /**
     * code: NOT_IMPLEMENTED | INVALID_CREDENTIALS | GATEWAY_UNREACHABLE | DECLINED | BAD_REQUEST | GATEWAY_ERROR
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = "PaymentError";
        this.code = code;
        this.details = details;
    }
}

class IPaymentProvider {
    // Registry / config screen ke liye. Subclass override kare.
    static id = "";
    static label = "";
    static implemented = false;
    // Config screen ka form isi se banta hai. secret: true = save ke baad wapas nahi dikhta (sirf mask)
    // [{ key, label, required, secret, help }]
    static credentialFields = [];

    /**
     * credentials: decrypted { key: value } (PaymentGateway.credentials se)
     * options:     { mode: "test" | "live", gatewayId, webhookKey }
     */
    constructor(credentials = {}, options = {}) {
        this.credentials = credentials;
        this.options = options;
    }

    get id() {
        return this.constructor.id;
    }

    notImplemented(method) {
        return new PaymentError("NOT_IMPLEMENTED", `${this.constructor.label}: ${method} is not available yet.`);
    }

    /**
     * Ek baar ka charge.
     * input: { amount, currency, description, items: [{ name, amount }], customer: { name, email, phone, idNumber },
     *          token?: { token, expMonth, expYear }, urls: { success, fail, notify }, ref }
     * token ho toh seedha charge ({ kind: "completed" }), warna hosted page ({ kind: "redirect" }).
     */
    async createCharge(input) {
        throw this.notImplemented("createCharge");
    }

    /**
     * Card save karna (bina charge). Hosted page deta hai, token webhook pe aata hai.
     * input: { customer, urls, ref }
     */
    async tokenizeCard(input) {
        throw this.notImplemented("tokenizeCard");
    }

    /**
     * Gateway ki notification (POST) padhna. Galat / forged request ho toh { ok: false, message }.
     * input: { body, query, headers, expected?: { amount, currency } }
     */
    async handleWebhook(input) {
        throw this.notImplemented("handleWebhook");
    }

    /**
     * Refund (pura ya aadha).
     * input: { amount, currency, providerTxnId, authNumber, token?: { token, expMonth, expYear }, reason }
     */
    async refund(input) {
        throw this.notImplemented("refund");
    }

    /**
     * Standing Order (har mahine apne aap charge). Hosted page pe pehli kisht katti hai, baaki gateway khud.
     * input: { firstAmount, monthlyAmount, installments, recurStartDate, currency, description, customer, urls, language }
     */
    async createStandingOrder(input) {
        throw this.notImplemented("createStandingOrder");
    }

    /**
     * Standing Order dhoondhna / padhna. input: { stoId } ya { token }
     * return: null ya { stoId, status, paymentsNumber, chargeAmount, firstChargeDate, lastChargeDate, nextChargeDate, terminal }
     */
    async getStandingOrder(input) {
        throw this.notImplemented("getStandingOrder");
    }

    async cancelStandingOrder({ stoId }) {
        throw this.notImplemented("cancelStandingOrder");
    }

    /**
     * Aakhri receipt. input: { providerTxnIds?, email?, from, to }
     * return: null ya { documentId, number, retrievalKey, url, createdAt, amount }
     */
    async getReceipt(input) {
        throw this.notImplemented("getReceipt");
    }

    /**
     * Test console: keys sahi hain? terminal se baat ho rahi hai? Koi paisa nahi katta.
     * return: { ok, checks: [{ name, ok, message }], message }
     */
    async testConnection() {
        throw this.notImplemented("testConnection");
    }

    // Save se pehle required fields check. Galti ho toh message string, warna null.
    static validateCredentials(credentials = {}) {
        const missing = this.credentialFields.filter((f) => f.required && !String(credentials[f.key] || "").trim());
        if (missing.length) return `Missing: ${missing.map((f) => f.label).join(", ")}.`;
        return null;
    }
}

module.exports = { IPaymentProvider, PaymentError };
