// Season ka ek standard format: "YYYY / YYYY" (jaise "2026 / 2027") - yahi mobile app bhejti hai aur uski dropdown mein dikhata hai.
// Khaali allowed hai. "2026/27", "2026-27", "2026/2027" bhi chalenge, par save "2026 / 2027" ke roop mein hota hai.
// Doosra saal pehle saal ke ek ke baad ka hona chahiye (2026/28 galat).
const SEASON_ERROR = "Season must be in the format YYYY / YYYY, for example 2026 / 2027.";

const parseSeason = (input) => {
    const raw = String(input ?? "").trim();
    if (!raw) return { value: "" };

    const match = raw.match(/^(\d{4})\s*[/-]\s*(\d{2}|\d{4})$/);
    if (!match) return { message: SEASON_ERROR };

    const start = Number(match[1]);
    const end = Number(match[2]);
    const endShort = match[2].length === 4 ? end % 100 : end;
    if (match[2].length === 4 && end !== start + 1) return { message: SEASON_ERROR };
    if (endShort !== (start + 1) % 100) return { message: SEASON_ERROR };

    return { value: `${start} / ${start + 1}` };
};

// Season = August se July tak, 12 mahine ("2026 / 2027" = Aug 2026 ... Jul 2027)
const SEASON_START_MONTH = 7; // August (0 = January)
const SEASON_MONTHS = 12;

// Chalu season (Nov 2026 -> "2026 / 2027", Mar 2027 -> "2026 / 2027", Aug 2027 -> "2027 / 2028")
const currentSeason = (date = new Date()) => {
    const start = date.getMonth() >= SEASON_START_MONTH ? date.getFullYear() : date.getFullYear() - 1;
    return `${start} / ${start + 1}`;
};

// Is date se season khatam (July) tak kitne mahine bache, join wala mahina bhi gina jaata hai.
// "2026 / 2027": Aug 2026 ya pehle -> 12, Nov 2026 -> 9 (Nov..Jul), Jul 2027 -> 1. Season ke baad bhi 1.
const monthsLeftInSeason = (season, date = new Date()) => {
    const match = String(season || "").match(/^(\d{4})/);
    const d = new Date(date);
    if (!match || Number.isNaN(d.getTime())) return SEASON_MONTHS;
    const passed = (d.getFullYear() - Number(match[1])) * 12 + (d.getMonth() - SEASON_START_MONTH);
    return Math.min(SEASON_MONTHS, Math.max(1, SEASON_MONTHS - passed));
};

module.exports = { parseSeason, currentSeason, monthsLeftInSeason, SEASON_MONTHS, SEASON_ERROR };
