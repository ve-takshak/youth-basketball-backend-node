const crypto = require("crypto");
const { IPaymentProvider, PaymentError } = require("../IPaymentProvider");

// Tranzila adapter. Docs: https://docs.tranzila.com
//   Hosted page (iframe): https://directng.tranzila.com/<terminal>/iframenew.php  -> card yahin bharta hai
//   API (server se):      https://api.tranzila.com  (app key + HMAC headers)
//     POST /v2/handshake/create                 -> thtk (amount lock, Token module chahiye)
//     POST /v1/transaction/credit_card/create   -> token se charge (debit) / refund (credit)
//   Result notify_url_address pe POST hota hai (Response = "000" matlab success).
const API_BASE = "https://api.tranzila.com";
const HOSTED_BASE = "https://directng.tranzila.com";
const TIMEOUT_MS = 20000;

// Hosted page ka currency code
const IFRAME_CURRENCY = { ILS: "1", USD: "2", EUR: "978", GBP: "826" };
const IFRAME_CURRENCY_REVERSE = Object.fromEntries(Object.entries(IFRAME_CURRENCY).map(([k, v]) => [v, k]));

const money = (value) => Math.round(Number(value) * 100) / 100;

// Local date "YYYY-MM-DD" (toISOString UTC mein badal ke ek din peeche kar deta tha)
const ymd = (value) => {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

class TranzilaProvider extends IPaymentProvider {
    static id = "tranzila";
    static label = "Tranzila";
    static implemented = true;
    static credentialFields = [
        { key: "terminalName", label: "Terminal name", required: true, secret: false, help: "Hosted payment page terminal (e.g. myclub)." },
        { key: "tokenTerminalName", label: "Token terminal name", required: false, secret: false, help: "Terminal for charging saved cards (often <terminal>tok). Empty = same as terminal name." },
        { key: "appKey", label: "API app key", required: true, secret: false, help: "My Tranzila > Settings > API keys." },
        { key: "secretKey", label: "API secret key", required: true, secret: true, help: "Never shown again after save." },
        { key: "useHandshake", label: "Use handshake (amount lock)", required: false, secret: false, type: "toggle", help: "Needs the Tranzila Token module. Stops buyers from changing the amount." },
    ];

    get terminal() {
        return String(this.credentials.terminalName || "").trim().toLowerCase();
    }

    get tokenTerminal() {
        return String(this.credentials.tokenTerminalName || "").trim().toLowerCase() || this.terminal;
    }

    get useHandshake() {
        return ["true", "1", "yes", "on"].includes(String(this.credentials.useHandshake || "").toLowerCase());
    }

    // Docs: access_token = HMAC-SHA256(message = appKey, key = secret + time + nonce), hex
    authHeaders() {
        const appKey = String(this.credentials.appKey || "").trim();
        const secret = String(this.credentials.secretKey || "").trim();
        const time = String(Math.floor(Date.now() / 1000));
        const nonce = crypto.randomBytes(40).toString("hex");
        const token = crypto.createHmac("sha256", secret + time + nonce).update(appKey).digest("hex");

        return {
            "Content-Type": "application/json",
            "X-tranzila-api-app-key": appKey,
            "X-tranzila-api-request-time": time,
            "X-tranzila-api-nonce": nonce,
            "X-tranzila-api-access-token": token,
        };
    }

    async api(path, body) {
        let response;
        try {
            response = await fetch(`${API_BASE}${path}`, {
                method: "POST",
                headers: this.authHeaders(),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (e) {
            throw new PaymentError("GATEWAY_UNREACHABLE", `Could not reach Tranzila: ${e.message}`);
        }

        const text = await response.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (e) {
            data = { raw: text.slice(0, 500) };
        }

        if (response.status === 401 || response.status === 403) {
            throw new PaymentError("INVALID_CREDENTIALS", "Tranzila rejected the API keys.", { httpStatus: response.status, data });
        }
        if (!response.ok) {
            throw new PaymentError("GATEWAY_ERROR", data.message || `Tranzila returned HTTP ${response.status}.`, {
                httpStatus: response.status,
                data,
            });
        }
        return data;
    }

    async createHandshake(amount) {
        const data = await this.api("/v2/handshake/create", { terminal_name: this.terminal, sum: money(amount) });
        if (Number(data.error_code) !== 0 || !data.thtk) {
            throw new PaymentError("GATEWAY_ERROR", `Handshake failed: ${data.message || "unknown error"}`, { data });
        }
        return data.thtk;
    }

    hostedUrl(terminal = this.terminal) {
        return `${HOSTED_BASE}/${encodeURIComponent(terminal)}/iframenew.php`;
    }

    // Hosted page ke fields. App GET url khol sakti hai, ya web POST form bana sakta hai.
    async hostedSession({ amount, currency = "ILS", tranmode, description, customer = {}, urls = {}, language }) {
        const fields = {
            sum: money(amount).toFixed(2),
            currency: IFRAME_CURRENCY[currency] || IFRAME_CURRENCY.ILS,
            tranmode,
            pdesc: String(description || "").slice(0, 100),
            contact: customer.name || "",
            email: customer.email || "",
            phone: customer.phone || "",
            myid: customer.idNumber || "",
            notify_url_address: urls.notify,
            success_url_address: urls.success,
            fail_url_address: urls.fail,
        };
        if (language === "he") fields.lang = "il";
        if (this.useHandshake && tranmode === "A") fields.thtk = await this.createHandshake(amount);

        Object.keys(fields).forEach((key) => {
            if (fields[key] === undefined || fields[key] === "") delete fields[key];
        });

        const url = `${this.hostedUrl()}?${new URLSearchParams(fields).toString()}`;
        return { kind: "redirect", method: "GET", url, action: this.hostedUrl(), fields };
    }

    // Transactions API ka result -> ChargeResult
    parseTxnResult(data, fallbackAmount, currency) {
        const result = data.transaction_result || {};
        const success = Number(data.error_code) === 0 && String(result.processor_response_code) === "000";
        return {
            success,
            providerTxnId: result.transaction_id ? String(result.transaction_id) : "",
            authNumber: result.auth_number ? String(result.auth_number) : "",
            amount: result.amount !== undefined ? money(result.amount) : money(fallbackAmount),
            currency: result.currency_code || currency,
            token: result.token || "",
            card: {
                last4: result.last_4 || "",
                expMonth: result.expiry_month ? Number(result.expiry_month) : null,
                expYear: result.expiry_year ? Number(result.expiry_year) : null,
                brand: result.card_type_name || "",
            },
            message: success ? "Approved" : data.message || `Declined (${result.processor_response_code || "no code"})`,
            raw: { error_code: data.error_code, message: data.message, processor_response_code: result.processor_response_code },
        };
    }

    async createCharge({ amount, currency = "ILS", description, items = [], customer, token, urls, ref, language }) {
        if (!(Number(amount) > 0)) throw new PaymentError("BAD_REQUEST", "Amount must be more than 0.");

        if (!token) {
            return this.hostedSession({ amount, currency, tranmode: "A", description, customer, urls, language });
        }

        // Saved card (token) se seedha charge
        const lines = items.length ? items : [{ name: description || "Payment", amount }];
        const data = await this.api("/v1/transaction/credit_card/create", {
            terminal_name: this.tokenTerminal,
            txn_type: "debit",
            card_number: token.token,
            expire_month: Number(token.expMonth),
            expire_year: Number(token.expYear),
            txn_currency_code: currency,
            items: lines.map((line) => ({
                name: String(line.name).slice(0, 100),
                units_number: 1,
                unit_price: money(line.amount),
                type: "S",
                price_type: "G",
            })),
            user_defined_fields: ref ? [{ name: "ref", value: String(ref) }] : undefined,
            response_language: "english",
            created_by_system: "courtside",
        });

        return { kind: "completed", ...this.parseTxnResult(data, amount, currency) };
    }

    async tokenizeCard({ customer, urls, language }) {
        // tranmode K = sirf token banao, card charge nahi hota
        return this.hostedSession({ amount: 1, tranmode: "K", description: "Save card", customer, urls, language });
    }

    async handleWebhook({ body = {}, expected }) {
        const supplier = String(body.supplier || "").trim().toLowerCase();
        if (supplier && ![this.terminal, this.tokenTerminal].includes(supplier)) {
            return { ok: false, message: `Notification is for another terminal (${supplier}).` };
        }

        const responseCode = String(body.Response ?? "").trim();
        const currency = IFRAME_CURRENCY_REVERSE[String(body.currency || "")] || String(body.currency || "") || "ILS";
        const amount = money(body.sum);

        // Expiry: expmonth/expyear ya expdate "MMYY"
        let expMonth = Number(body.expmonth) || null;
        let expYear = Number(body.expyear) || null;
        if ((!expMonth || !expYear) && /^\d{4}$/.test(String(body.expdate || ""))) {
            expMonth = Number(String(body.expdate).slice(0, 2));
            expYear = 2000 + Number(String(body.expdate).slice(2));
        }
        if (expYear && expYear < 100) expYear += 2000;

        const result = {
            ok: true,
            success: responseCode === "000",
            amount,
            currency,
            providerTxnId: String(body.index || body.transaction_id || ""),
            authNumber: String(body.ConfirmationCode || body.authnr || ""),
            token: String(body.TranzilaTK || ""),
            card: { last4: String(body.ccno || "").slice(-4), expMonth, expYear, brand: String(body.cardtype || "") },
            message: responseCode === "000" ? "Approved" : `Declined (Response ${responseCode || "missing"})`,
            raw: {
                Response: responseCode,
                index: body.index,
                sum: body.sum,
                currency: body.currency,
                supplier: body.supplier,
                tranmode: body.tranmode,
                ConfirmationCode: body.ConfirmationCode,
            },
        };

        // Buyer ne URL mein amount badal diya ho toh pakdo
        if (expected && result.success) {
            if (money(expected.amount) !== amount) {
                return { ...result, ok: false, success: false, message: `Amount mismatch: expected ${expected.amount}, got ${amount}.` };
            }
            if (expected.currency && expected.currency !== currency) {
                return { ...result, ok: false, success: false, message: `Currency mismatch: expected ${expected.currency}, got ${currency}.` };
            }
        }
        return result;
    }

    async refund({ amount, currency = "ILS", providerTxnId, authNumber, token, reason }) {
        if (!token?.token || !providerTxnId || !authNumber) {
            throw new PaymentError(
                "BAD_REQUEST",
                "This payment has no saved card token, so it can't be refunded from here. Refund it in My Tranzila and mark it refunded."
            );
        }

        const data = await this.api("/v1/transaction/credit_card/create", {
            terminal_name: this.tokenTerminal,
            txn_type: "credit",
            card_number: token.token,
            expire_month: Number(token.expMonth),
            expire_year: Number(token.expYear),
            reference_txn_id: Number(providerTxnId),
            authorization_number: String(authNumber),
            txn_currency_code: currency,
            items: [{ name: String(reason || "Refund").slice(0, 100), units_number: 1, unit_price: money(amount), type: "S", price_type: "G" }],
            response_language: "english",
            created_by_system: "courtside",
        });

        return this.parseTxnResult(data, amount, currency);
    }

    // Hosted page pe pehli kisht + My Billing STO (recur_*). Tranzila STO token terminal pe banata hai.
    async createStandingOrder({ firstAmount, monthlyAmount, installments, recurStartDate, currency = "ILS", description, customer, urls, language }) {
        if (!(Number(firstAmount) > 0) || !(Number(monthlyAmount) > 0)) {
            throw new PaymentError("BAD_REQUEST", "Standing order amounts must be more than 0.");
        }
        if (!(installments >= 2)) throw new PaymentError("BAD_REQUEST", "A standing order needs at least 2 payments.");

        const session = await this.hostedSession({ amount: firstAmount, currency, tranmode: "A", description, customer, urls, language });
        // 4_approved = monthly, buyer badal nahi sakta. recur_payments = pehli ke baad kitni.
        Object.assign(session.fields, {
            recur_transaction: "4_approved",
            recur_sum: money(monthlyAmount).toFixed(2),
            recur_payments: String(installments - 1),
            recur_start_date: ymd(recurStartDate),
        });
        session.url = `${this.hostedUrl()}?${new URLSearchParams(session.fields).toString()}`;
        return session;
    }

    formatSto(sto) {
        const date = (value) => (value ? new Date(value) : null);
        return {
            stoId: String(sto.sto_id),
            terminal: sto.terminal_name || this.tokenTerminal,
            status: sto.sto_status || "",
            paymentsNumber: Number(sto.sto_payments_number) || null,
            chargeAmount: sto.charge_amount !== undefined ? money(sto.charge_amount) : null,
            firstChargeDate: date(sto.first_charge_date),
            lastChargeDate: date(sto.last_charge_date),
            nextChargeDate: date(sto.next_charge_date),
        };
    }

    async getStandingOrder({ stoId, token }) {
        if (!stoId && !token) return null;
        const filter = stoId ? { sto_id: Number(stoId) } : { token };

        for (const terminal of [...new Set([this.tokenTerminal, this.terminal])]) {
            const data = await this.api("/v1/stos/get", { terminal_name: terminal, ...filter });
            const stos = data.stos || [];
            if (Number(data.error_code) === 0 && stos.length) {
                // Ek token ke kai STO ho sakte hain: sabse naya
                stos.sort((a, b) => String(b.create_date).localeCompare(String(a.create_date)));
                return this.formatSto({ terminal_name: terminal, ...stos[0] });
            }
        }
        return null;
    }

    async cancelStandingOrder({ stoId, terminal }) {
        const data = await this.api("/v2/sto/update", {
            terminal_name: terminal || this.tokenTerminal,
            sto_id: Number(stoId),
            sto_status: "inactive",
            updated_by_user: "courtside",
        });
        if (Number(data.error_code) !== 0) {
            throw new PaymentError("GATEWAY_ERROR", `Could not stop the standing order: ${data.message || data.error_code}`, { data });
        }
        return { ok: true };
    }

    // Tranzila har payment pe receipt (RE) khud banata hai. Yahan sirf dhoondhte hain.
    async getReceipt({ providerTxnIds = [], email, from, to }) {
        const body = {
            terminal_names: [...new Set([this.terminal, this.tokenTerminal])],
            start_date: ymd(from || Date.now() - 400 * 86400000),
            end_date: ymd(to || Date.now() + 86400000),
        };
        const ids = providerTxnIds.map(Number).filter(Boolean);
        if (ids.length) body.transaction_ids = ids;
        else if (email) body.client_email = email;
        else return null;

        let response;
        try {
            response = await fetch("https://billing5.tranzila.com/api/documents_db/get_documents", {
                method: "POST",
                headers: this.authHeaders(),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (e) {
            throw new PaymentError("GATEWAY_UNREACHABLE", `Could not reach Tranzila invoices: ${e.message}`);
        }
        if (response.status === 401 || response.status === 403) {
            throw new PaymentError("INVALID_CREDENTIALS", "Tranzila rejected the API keys.");
        }
        const data = await response.json().catch(() => ({}));
        const docs = (data.documents || []).filter((d) => d.retrieval_key);
        if (!docs.length) return null;

        docs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const doc = docs[0];
        return {
            documentId: String(doc.id),
            number: String(doc.number || ""),
            retrievalKey: doc.retrieval_key,
            url: `https://my.tranzila.com/api/get_financial_document/${encodeURIComponent(doc.retrieval_key)}`,
            createdAt: doc.created_at || null,
            amount: doc.total_charge_amount !== undefined ? money(doc.total_charge_amount) : null,
        };
    }

    async testConnection() {
        const checks = [];
        const missing = this.constructor.validateCredentials(this.credentials);
        checks.push({ name: "Credentials filled", ok: !missing, message: missing || "All required fields are set." });
        if (missing) return { ok: false, checks, message: missing };

        // 1. Hosted page: terminal exist karta hai?
        try {
            const response = await fetch(this.hostedUrl(), { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
            const ok = response.status < 400;
            checks.push({
                name: "Payment page reachable",
                ok,
                message: ok ? `Terminal "${this.terminal}" page answered (HTTP ${response.status}).` : `HTTP ${response.status}. Check the terminal name.`,
            });
        } catch (e) {
            checks.push({ name: "Payment page reachable", ok: false, message: `Could not reach Tranzila: ${e.message}` });
        }

        // 2. API keys: handshake banake dekho (koi charge nahi hota)
        try {
            const data = await this.api("/v2/handshake/create", { terminal_name: this.terminal, sum: 1 });
            if (Number(data.error_code) === 0) {
                checks.push({ name: "API keys", ok: true, message: "Keys accepted. Handshake created (no charge)." });
            } else {
                // Auth paas ho gaya par module / terminal mein dikkat
                checks.push({
                    name: "API keys",
                    ok: !this.useHandshake,
                    message: `Keys accepted, but handshake returned: ${data.message || data.error_code}.${
                        this.useHandshake ? " Turn off handshake or enable the Token module." : ""
                    }`,
                });
            }
        } catch (e) {
            checks.push({ name: "API keys", ok: false, message: e.message });
        }

        const ok = checks.every((check) => check.ok);
        return { ok, checks, message: ok ? "Tranzila terminal is connected." : "Some checks failed." };
    }
}

module.exports = TranzilaProvider;
