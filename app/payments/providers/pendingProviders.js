const { IPaymentProvider } = require("../IPaymentProvider");

// Ye gateways config screen pe dikhte hain aur club apni keys save kar sakta hai,
// par adapter abhi bana nahi hai: har method NOT_IMPLEMENTED deta hai.
// Adapter banane ke liye: class ko apni file mein le jao, methods likho, implemented = true karo
// (TranzilaProvider.js jaisa).

class CardcomProvider extends IPaymentProvider {
    static id = "cardcom";
    static label = "Cardcom";
    static credentialFields = [
        { key: "terminalNumber", label: "Terminal number", required: true, secret: false },
        { key: "apiName", label: "API name (username)", required: true, secret: false },
        { key: "apiPassword", label: "API password", required: false, secret: true, help: "Needed for refunds." },
    ];
}

class PayPlusProvider extends IPaymentProvider {
    static id = "payplus";
    static label = "PayPlus";
    static credentialFields = [
        { key: "apiKey", label: "API key", required: true, secret: false },
        { key: "secretKey", label: "Secret key", required: true, secret: true },
        { key: "paymentPageUid", label: "Payment page UID", required: true, secret: false },
        { key: "terminalUid", label: "Terminal UID", required: false, secret: false },
    ];
}

class HypProvider extends IPaymentProvider {
    static id = "hyp";
    static label = "HYP (Pelecard / Meshulam)";
    static credentialFields = [
        { key: "terminalNumber", label: "Terminal number", required: true, secret: false },
        { key: "username", label: "Username", required: true, secret: false },
        { key: "password", label: "Password", required: true, secret: true },
        { key: "apiKey", label: "API key / page code", required: false, secret: true },
    ];
}

module.exports = { CardcomProvider, PayPlusProvider, HypProvider };
