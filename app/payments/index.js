const { PaymentError } = require("./IPaymentProvider");
const TranzilaProvider = require("./providers/TranzilaProvider");
const { CardcomProvider, PayPlusProvider, HypProvider } = require("./providers/pendingProviders");
const { decrypt } = require("../helpers/secretBox");

// Saare gateways. Naya gateway: class banao aur yahan jodo.
const PROVIDERS = [TranzilaProvider, CardcomProvider, PayPlusProvider, HypProvider];
const PROVIDER_IDS = PROVIDERS.map((P) => P.id);

const getProviderClass = (id) => PROVIDERS.find((P) => P.id === id) || null;

// Config screen ke liye: konse gateway, kaunse fields
const listProviders = () =>
    PROVIDERS.map((P) => ({
        id: P.id,
        label: P.label,
        implemented: P.implemented,
        credentialFields: P.credentialFields.map((f) => ({ type: f.secret ? "password" : "text", help: "", ...f })),
    }));

// PaymentGateway document -> ready provider (keys decrypt karke)
const buildProvider = (gateway) => {
    const Provider = getProviderClass(gateway.provider);
    if (!Provider) throw new PaymentError("BAD_REQUEST", `Unknown payment provider "${gateway.provider}".`);

    const credentials = {};
    const stored = gateway.credentials instanceof Map ? Object.fromEntries(gateway.credentials) : gateway.credentials || {};
    Object.entries(stored).forEach(([key, box]) => {
        credentials[key] = decrypt(box);
    });

    return new Provider(credentials, { mode: gateway.mode, gatewayId: String(gateway._id), webhookKey: gateway.webhookKey });
};

module.exports = { PROVIDERS, PROVIDER_IDS, getProviderClass, listProviders, buildProvider, PaymentError };
