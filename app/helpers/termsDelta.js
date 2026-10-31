// Terms ka text rich-text editor (Quill / flutter_quill) ka "Delta" document hai: { ops: [{ insert, attributes? }] }.
// Web aur mobile dono yahi format bolte hain, isliye HTML save nahi hota (koi XSS nahi). Server sirf
// ye safe formatting aane deta hai, baaki sab hata deta hai (links, images, colors waghera nahi).
const MAX_TEXT_LENGTH = 50000;
const MAX_OPS = 5000;

const ALLOWED_ATTRIBUTES = {
    bold: (v) => v === true,
    italic: (v) => v === true,
    underline: (v) => v === true,
    strike: (v) => v === true,
    size: (v) => ["small", "large", "huge"].includes(v),
    header: (v) => Number.isInteger(v) && v >= 1 && v <= 6,
    list: (v) => ["ordered", "bullet"].includes(v),
    align: (v) => ["center", "right", "justify"].includes(v),
    direction: (v) => v === "rtl",
    indent: (v) => Number.isInteger(v) && v >= 1 && v <= 5,
};

const cleanAttributes = (attributes) => {
    if (!attributes || typeof attributes !== "object") return undefined;
    const clean = {};
    for (const [key, value] of Object.entries(attributes)) {
        if (ALLOWED_ATTRIBUTES[key]?.(value)) clean[key] = value;
    }
    return Object.keys(clean).length ? clean : undefined;
};

/**
 * raw: { ops } object ya uska JSON string.
 * Return { error } ya { delta: { ops }, plainText }.
 */
const normalizeDelta = (raw) => {
    let value = raw;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch (e) {
            return { error: "Terms must be an editor document." };
        }
    }
    if (!value || !Array.isArray(value.ops)) return { error: "Terms must be an editor document." };
    if (value.ops.length > MAX_OPS) return { error: "The terms are too long." };

    const ops = [];
    let plainText = "";
    for (const op of value.ops) {
        // Sirf text: images / video / formulas (insert object) allowed nahi
        if (!op || typeof op.insert !== "string") return { error: "Only text is allowed in the terms." };
        if (!op.insert) continue;
        plainText += op.insert;
        const attributes = cleanAttributes(op.attributes);
        ops.push(attributes ? { insert: op.insert, attributes } : { insert: op.insert });
    }

    plainText = plainText.replace(/\r\n/g, "\n");
    if (!plainText.trim()) return { error: "Terms text is required." };
    if (plainText.length > MAX_TEXT_LENGTH) return { error: `Terms text must be ${MAX_TEXT_LENGTH.toLocaleString("en-US")} characters or fewer.` };

    // Delta document hamesha newline pe khatam hota hai
    if (!plainText.endsWith("\n")) ops.push({ insert: "\n" });

    return { delta: { ops }, plainText: plainText.trim() };
};

module.exports = { normalizeDelta };
