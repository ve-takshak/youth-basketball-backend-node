// Days / time blocks ki checking. Coach aur Team (aur aage Schedule) sab yahi use karein.
const WEEK_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_BLOCKS = 50;

// "HH:MM" (24 ghante). 00:00 se 23:59 tak
const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMinutes = (time) => {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
};

// JSON body mein array aata hai, form-data mein JSON string. Dono chalenge.
const toList = (raw) => {
    if (raw === null || raw === "") return { list: [] };
    if (typeof raw === "string") {
        const text = raw.trim();
        if (text.startsWith("[")) {
            try {
                return { list: JSON.parse(text) };
            } catch (e) {
                return { error: true };
            }
        }
        return { list: text.split(",") };
    }
    return { list: raw };
};

/**
 * Preferred training days. ["sun","tue"] / '["sun","tue"]' / "sun,tue". "" ya [] = koi din nahi.
 * Duplicate hat jaate hain, order hamesha Sun → Sat. Galti ho toh { message }, warna { days }
 */
const parseTrainingDays = (raw) => {
    const { list, error } = toList(raw);
    if (error) return { message: "Preferred training days must be a valid list." };
    if (!Array.isArray(list)) return { message: "Preferred training days must be a list." };

    const days = [...new Set(list.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean))];
    const invalid = days.find((d) => !WEEK_DAYS.includes(d));
    if (invalid) return { message: `Invalid training day "${invalid}". Use: ${WEEK_DAYS.join(", ")}.` };

    days.sort((a, b) => WEEK_DAYS.indexOf(a) - WEEK_DAYS.indexOf(b));
    return { days };
};

/**
 * Unavailable hours: [{ day: "mon", from: "16:00", to: "20:00" }, ...]. "" ya [] = koi block nahi.
 * Rules: sahi din, HH:MM time, from < to, ek din ke blocks aapas mein overlap na karein.
 * Bilkul same block do baar aaye toh ek hi rakha jaata hai. Order: din, phir time.
 * Galti ho toh { message }, warna { blocks }
 */
const parseUnavailableHours = (raw) => {
    const { list, error } = toList(raw);
    if (error) return { message: "Unavailable hours must be a valid list." };
    if (!Array.isArray(list)) return { message: "Unavailable hours must be a list." };
    if (list.length > MAX_BLOCKS) return { message: `You can add up to ${MAX_BLOCKS} unavailable blocks.` };

    const blocks = [];
    const seen = new Set();

    for (let i = 0; i < list.length; i += 1) {
        const item = list[i] || {};
        const label = `Unavailable block ${i + 1}`;
        const day = String(item.day || "").trim().toLowerCase();
        const from = String(item.from || "").trim();
        const to = String(item.to || "").trim();

        if (!WEEK_DAYS.includes(day)) return { message: `${label}: day must be one of ${WEEK_DAYS.join(", ")}.` };
        if (!TIME_RX.test(from) || !TIME_RX.test(to)) {
            return { message: `${label}: time must be in HH:MM format (00:00 - 23:59).` };
        }
        if (toMinutes(from) >= toMinutes(to)) return { message: `${label}: "from" must be before "to".` };

        const key = `${day}|${from}|${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blocks.push({ day, from, to });
    }

    blocks.sort(
        (a, b) => WEEK_DAYS.indexOf(a.day) - WEEK_DAYS.indexOf(b.day) || toMinutes(a.from) - toMinutes(b.from)
    );

    // Ek din ke blocks overlap toh nahi (sorted hain, toh sirf pichhle se milao)
    for (let i = 1; i < blocks.length; i += 1) {
        const prev = blocks[i - 1];
        const cur = blocks[i];
        if (prev.day === cur.day && toMinutes(cur.from) < toMinutes(prev.to)) {
            return {
                message: `Unavailable blocks overlap on ${cur.day}: ${prev.from}-${prev.to} and ${cur.from}-${cur.to}.`,
            };
        }
    }

    return { blocks };
};

module.exports = { WEEK_DAYS, TIME_RX, toMinutes, parseTrainingDays, parseUnavailableHours };