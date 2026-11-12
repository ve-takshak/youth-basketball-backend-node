const crypto = require("crypto");

// Payment gateway keys / card tokens DB mein plain text nahi rakhte. AES-256-GCM se encrypt.
// Key .env ke PAYMENT_ENCRYPTION_KEY se aati hai: 32 bytes, hex (64 chars) ya base64.
//   Banane ke liye:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Dhyan do: key badli toh purane saved keys/tokens decrypt nahi honge (clubs ko dobara save karna padega).
const ALGO = "aes-256-gcm";
const PREFIX = "v1";

const getKey = () => {
    const raw = String(process.env.PAYMENT_ENCRYPTION_KEY || "").trim();
    if (!raw) throw new Error("PAYMENT_ENCRYPTION_KEY is not set in .env.");

    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error("PAYMENT_ENCRYPTION_KEY must be 32 bytes (64 hex characters).");
    return key;
};

// "v1:<iv>:<tag>:<data>" (sab base64)
const encrypt = (plain) => {
    if (plain === undefined || plain === null || plain === "") return "";
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
    const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
};

const decrypt = (box) => {
    if (!box) return "";
    const [prefix, iv, tag, data] = String(box).split(":");
    if (prefix !== PREFIX || !iv || !tag || data === undefined) throw new Error("Encrypted value is corrupted.");

    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
};

// Screen pe dikhane ke liye: "abcd1234xyz" -> "••••••4xyz"
const mask = (plain) => {
    const text = String(plain || "");
    if (!text) return "";
    return `••••••${text.slice(-4)}`;
};

module.exports = { encrypt, decrypt, mask };
