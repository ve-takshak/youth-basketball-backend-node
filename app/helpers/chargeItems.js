// Bill / Fee Plan ke items ka common check: [{ type, name, amount }]
const { CHARGE_ITEM_TYPES } = require("../models/Charge");
const { round } = require("./paymentStatus");

const parseItems = (raw) => {
    let items = raw;
    if (typeof items === "string") {
        try {
            items = JSON.parse(items);
        } catch (e) {
            return { message: "Items must be a list." };
        }
    }
    if (!Array.isArray(items) || !items.length) return { message: "Add at least one item." };
    if (items.length > 10) return { message: "You can add up to 10 items." };

    const out = [];
    for (const item of items) {
        const type = String(item?.type || "other").trim();
        if (!CHARGE_ITEM_TYPES.includes(type)) return { message: `Item type must be one of: ${CHARGE_ITEM_TYPES.join(", ")}.` };
        const name = String(item?.name || "").trim();
        if (!name) return { message: "Every item needs a name." };
        if (name.length > 100) return { message: "Item name must be 100 characters or less." };
        const amount = Number(item?.amount);
        if (!Number.isFinite(amount) || amount < 0 || amount > 100000) return { message: `Amount for "${name}" is not valid.` };
        out.push({ type, name, amount: round(amount) });
    }
    const total = round(out.reduce((s, i) => s + i.amount, 0));
    if (!(total > 0)) return { message: "Total must be more than 0." };
    return { items: out, total };
};

module.exports = { parseItems };
