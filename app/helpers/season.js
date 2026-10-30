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

module.exports = { parseSeason, SEASON_ERROR };
