const { applyWebhook } = require("../../payments/service");

// Gateway (Tranzila) se aane wali calls. Inpe token nahi hota.
//   POST /payments/webhook/:gatewayId/:key   -> payment ka asli result (yahi bill "paid" karta hai)
//   GET  /payments/return?result=success|fail -> parent ka browser yahan aata hai (sirf message page)

/**
 * Tranzila notify_url_address. URL ka :key secret hai, galat key = 404.
 */
const paymentWebhook = async (req, res) => {
    try {
        const result = await applyWebhook(req.params.gatewayId, req.params.key, {
            body: req.body || {},
            query: req.query || {},
            headers: req.headers,
        });
        if (result.status !== 200) console.warn(`Payment webhook rejected: ${result.message}`);
        return res.status(result.status).type("text/plain").send(result.message);
    } catch (e) {
        console.error("paymentWebhook error:", e);
        // 500 = Tranzila dobara bhejega
        return res.status(500).type("text/plain").send("Error");
    }
};

/**
 * Payment ke baad ka page. App WebView is URL ko dekh ke band ho jaye aur list refresh kare.
 * Yahan status nahi badalta (browser ki baat pe bharosa nahi), sirf webhook badalta hai.
 */
const paymentReturn = async (req, res) => {
    const success = req.query.result === "success";
    const title = success ? "Payment received" : "Payment not completed";
    const text = success
        ? "Thank you! You can go back to the app. It may take a moment for the payment to show."
        : "The payment was not completed. You can go back to the app and try again.";
    return res
        .status(200)
        .type("html")
        .send(
            `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
                `<title>${title}</title></head><body style="font-family:Arial,sans-serif;text-align:center;padding:48px 16px;background:#fff;color:#222">` +
                `<h2>${title}</h2><p>${text}</p></body></html>`
        );
};

module.exports = { paymentWebhook, paymentReturn };
