// SMS4Free (Israel) se SMS bhejna. Docs: https://sms4free.co.il/docs/otp-api.html
// Keys sirf .env mein: SMS4FREE_KEY, SMS4FREE_USER, SMS4FREE_PASS, SMS4FREE_SENDER
// Response { status, message }: status > 0 = itne SMS gaye, 0 / minus = error (HTTP 200 pe bhi)
const SEND_URL = "https://api.sms4free.co.il/ApiSMS/v2/SendSMS";
const BALANCE_URL = "https://api.sms4free.co.il/ApiSMS/AvailableSMS";
const TIMEOUT_MS = 10000;

const ERRORS = {
    0: "General error (contact SMS4Free).",
    "-1": "Wrong key, user or password.",
    "-2": "Sender is not valid.",
    "-3": "Recipient number is not valid.",
    "-4": "No SMS balance left.",
    "-5": "Message text is not valid.",
    "-6": "Sender number is not verified yet.",
};

const credentials = () => ({
    key: String(process.env.SMS4FREE_KEY || "").trim(),
    user: String(process.env.SMS4FREE_USER || "").trim(),
    pass: String(process.env.SMS4FREE_PASS || "").trim(),
});

// +972 + 5XXXXXXXX -> 05XXXXXXXX. SMS4Free sirf Israel ke number.
const toLocalNumber = (countryCode, mobileNumber) => {
    const code = String(countryCode || "").replace(/\D/g, "");
    let number = String(mobileNumber || "").replace(/\D/g, "");
    if (code && code !== "972") return null;
    if (number.startsWith("972")) number = number.slice(3);
    if (!number.startsWith("0")) number = `0${number}`;
    return /^05\d{8}$/.test(number) ? number : null;
};

const post = async (url, body) => {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`SMS4Free HTTP ${res.status}`);
    return res.text();
};

/**
 * Ek number pe SMS. Return { ok, status, message }. Kabhi throw nahi karta.
 * sendSms({ countryCode: "+972", mobileNumber: "523875508", msg: "..." })
 */
const sendSms = async ({ countryCode, mobileNumber, msg }) => {
    const recipient = toLocalNumber(countryCode, mobileNumber);
    if (!recipient) return { ok: false, status: -3, message: "Only Israeli mobile numbers are supported." };

    const creds = credentials();
    if (!creds.key || !creds.user || !creds.pass) return { ok: false, status: 0, message: "SMS4Free is not set in .env." };

    try {
        const text = await post(SEND_URL, { ...creds, sender: String(process.env.SMS4FREE_SENDER || creds.user).trim(), recipient, msg });
        let status;
        let message = "";
        try {
            const data = JSON.parse(text);
            status = Number(data.status);
            message = String(data.message || "");
        } catch {
            status = Number(text);
        }
        if (status > 0) return { ok: true, status, message: "Sent" };
        return { ok: false, status, message: message || ERRORS[String(status)] || `SMS4Free error ${text}` };
    } catch (e) {
        return { ok: false, status: 0, message: e.name === "TimeoutError" ? "SMS4Free timed out." : e.message };
    }
};

// Kitne SMS bache hain (minus = credentials galat)
const smsBalance = async () => Number(await post(BALANCE_URL, credentials()));

module.exports = { sendSms, smsBalance, toLocalNumber };
