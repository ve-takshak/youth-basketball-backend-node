const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

// Form 101 ka PDF, poora memory mein (Buffer).
// Layout official טופס 101 jaisa (2 page: א-ז, phir ח-י + דברי הסבר), khud draw karte hain, template ki zarurat nahi.
// Font: Alef (OFL, assets/form101). Pages: form (2 page) + ID / documents aakhri pages mein.

class Form101PdfNotReady extends Error {}
class Form101AttachmentError extends Error {}

const ASSET_DIR = path.resolve(__dirname, "../../assets/form101");
let fontBytes = null;
const loadFonts = () => {
    if (!fontBytes) {
        try {
            fontBytes = {
                regular: fs.readFileSync(path.join(ASSET_DIR, "Alef-Regular.ttf")),
                bold: fs.readFileSync(path.join(ASSET_DIR, "Alef-Bold.ttf")),
            };
        } catch (e) {
            throw new Form101PdfNotReady("Form 101 fonts are missing (assets/form101).");
        }
    }
    return fontBytes;
};

// ---------- Hebrew RTL ----------
// pdf-lib text ko left-to-right likhta hai, aur andar fontkit string ka pehla letter Hebrew ho toh
// POORI string ulti kar deta hai (mixed Hebrew + English/number string ke saath ye galat ho jaata hai).
// Isliye text ko runs mein todte hain (Hebrew / Latin+digits; space-punctuation dono taraf Latin ho toh Latin
// warna Hebrew), runs ko screen order (right se left) mein rakhte hain, aur HAR run alag draw karte hain:
//   Hebrew run  -> fontkit khud ulta karta hai, hum sirf brackets mirror karke bhejte hain
//   Latin run   -> jaisa hai waisa (numbers, email, dates)
const HEBREW = /[֐-׿]/;
const LATIN = /[A-Za-z0-9]/;
const MIRROR = { "(": ")", ")": "(", "[": "]", "]": "[", "<": ">", ">": "<", "{": "}", "}": "{" };
const mirror = (s) => [...s].map((c) => MIRROR[c] || c).join("");

// -> screen pe left se right jaane wale segments (har ek seedha drawText ko diya ja sakta hai)
const segments = (input) => {
    const text = String(input ?? "");
    if (!text) return [];
    if (!HEBREW.test(text)) return [text];

    // R = Hebrew, L = English letter, E = digit, N = space / punctuation
    const runs = [];
    for (const ch of text) {
        const dir = HEBREW.test(ch) ? "R" : LATIN.test(ch) ? (/\d/.test(ch) ? "E" : "L") : "N";
        const last = runs[runs.length - 1];
        if (last && last.dir === dir) last.text += ch;
        else runs.push({ dir, text: ch });
    }
    // Do numbers ke beech akela / . , : - number ka hissa (dates 14/05/2010, amounts 3,000)
    runs.forEach((run, i) => {
        if (run.dir === "N" && /^[/.,:-]$/.test(run.text) && runs[i - 1]?.dir === "E" && runs[i + 1]?.dir === "E") run.dir = "E";
    });
    // English letter ke baad wala number English ka hissa ("Form 101")
    let lastStrong = "R";
    runs.forEach((run) => {
        if (run.dir === "E" && lastStrong === "L") run.dir = "L";
        if (run.dir === "R" || run.dir === "L") lastStrong = run.dir;
    });
    // Space / punctuation: dono taraf English ho toh English, warna Hebrew (number yahan Hebrew jaisa)
    const strongOf = (run) => (!run ? "R" : run.dir === "E" ? "R" : run.dir);
    runs.forEach((run, i) => {
        if (run.dir !== "N") return;
        const prev = strongOf(runs[i - 1]);
        const next = strongOf(runs.slice(i + 1).find((r) => r.dir !== "N"));
        run.dir = prev === "L" && next === "L" ? "L" : "R";
    });

    const merged = [];
    runs.forEach((run) => {
        const last = merged[merged.length - 1];
        if (last && last.dir === run.dir) last.text += run.text;
        else merged.push({ ...run });
    });

    return merged.reverse().map((run) => {
        if (run.dir === "L" || run.dir === "E") return run.text;
        // Hebrew letter wala run: fontkit ulta karega. Sirf space/punctuation: fontkit nahi karega, hum ulta karte hain.
        return HEBREW.test(run.text) ? mirror(run.text) : mirror([...run.text].reverse().join(""));
    });
};

const textWidth = (text, size, font) => segments(text).reduce((w, s) => w + font.widthOfTextAtSize(s, size), 0);

// xRight pe khatam hone wala text. Return: width
const drawRtl = (page, text, xRight, y, { size, font, color }) => {
    const parts = segments(text);
    const total = parts.reduce((w, s) => w + font.widthOfTextAtSize(s, size), 0);
    let x = xRight - total;
    parts.forEach((s) => {
        page.drawText(s, { x, y, size, font, color });
        x += font.widthOfTextAtSize(s, size);
    });
    return total;
};

// ---------- labels ----------
const INCOME_LABELS = {
    monthly: "משכורת חודש (2)",
    additional: "משכורת בעד משרה נוספת (3)",
    partial: "משכורת חלקית (4)",
    daily: "שכר עבודה (עובד יומי) (5)",
    allowance: "קצבה (6)",
    scholarship: "מלגה (1)",
};
const HEALTH_FUND_LABELS = { clalit: "כללית", maccabi: "מכבי", meuhedet: "מאוחדת", leumit: "לאומית" };
// "מספר דרכון / מדינה"
const passportText = (p) => (p?.passportNumber ? [p.passportNumber, p.passportCountry].filter(Boolean).join(" / ") : "");
const AGE_GROUP_TEXT = {
    bornThisYear: "מספר ילדים שנולדו בשנת המס",
    age1to2: "מספר ילדים שימלאו להם שנה אחת עד שנתיים בשנת המס",
    age3: "מספר ילדים שימלאו להם 3 שנים בשנת המס",
    age4to5: "מספר ילדים שימלאו להם 4 שנים עד 5 שנים בשנת המס",
    age6to17: "מספר ילדים שימלאו להם 6 שנים עד 17 שנים בשנת המס",
    age18: "מספר ילדים שימלאו להם 18 שנים בשנת המס",
};

// "2026-05-14" -> "14/05/2026"
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
// "2026-05-14" -> "14052026" (digit boxes ke liye)
const dateDigits = (iso) => (iso ? `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}` : "");
const digitsOf = (v) => String(v ?? "").replace(/\D/g, "");
// Khaali value -> "______" (official form ki khaali line)
const fill = (v, len = 10) => (v === undefined || v === null || v === "" ? "_".repeat(len) : String(v));

// ---------- official טופס 101 jaisa layout: 2 page, har cheez ki jagah fix ----------
// Page 1: header, א, ב, ג (right column) + ד / ה (left column), ו, ז
// Page 2: ח (1-16), ט, י, דברי הסבר. Official form ka logo nahi banate, sirf text + layout.
const A4 = [595.28, 841.89];
const M = 28; // margin
const L = M;
const R = A4[0] - M;
const W = R - L;
const COLORS = {
    text: rgb(0, 0, 0),
    label: rgb(0.32, 0.32, 0.32),
    line: rgb(0.15, 0.15, 0.15),
    value: rgb(0.05, 0.2, 0.6),
};
const CHILD_ROWS = 13; // official form mein 13 lines; zyada bachche ho toh alag "המשך" page

class Sheet {
    constructor(page, fonts) {
        this.page = page;
        this.font = fonts.regular;
        this.bold = fonts.bold;
    }

    width(text, size, font = this.font) {
        return textWidth(text, size, font);
    }

    // maxW mein na aaye toh font chhota (min 5.5), phir bhi na aaye toh kaat do
    fit(text, maxW, size, font = this.font) {
        const str = String(text ?? "");
        let s = size;
        while (s > 5.5 && this.width(str, s, font) > maxW) s -= 0.25;
        if (this.width(str, s, font) <= maxW) return { str, s };
        let t = str;
        while (t.length > 1 && this.width(`${t}..`, s, font) > maxW) t = t.slice(0, -1);
        return { str: `${t}..`, s };
    }

    // RTL text, xRight pe khatam. Return: width
    t(text, xRight, y, { size = 8, font = this.font, color = COLORS.text, maxW } = {}) {
        if (text === undefined || text === null || text === "") return 0;
        let str = String(text);
        let s = size;
        if (maxW) ({ str, s } = this.fit(str, maxW, size, font));
        return drawRtl(this.page, str, xRight, y, { size: s, font, color });
    }

    // xLeft se shuru
    tl(text, xLeft, y, opts = {}) {
        const { size = 8, font = this.font, maxW } = opts;
        let str = String(text ?? "");
        let s = size;
        if (maxW) ({ str, s } = this.fit(str, maxW, size, font));
        return this.t(str, xLeft + this.width(str, s, font), y, { ...opts, size: s, maxW: undefined });
    }

    // beech mein
    tc(text, xCenter, y, opts = {}) {
        const { size = 8, font = this.font, maxW } = opts;
        let str = String(text ?? "");
        let s = size;
        if (maxW) ({ str, s } = this.fit(str, maxW, size, font));
        const w = this.width(str, s, font);
        this.t(str, xCenter + w / 2, y, { ...opts, size: s, maxW: undefined });
        return w;
    }

    rect(x, y, w, h, { fill: color, border = COLORS.line, bw = 0.6 } = {}) {
        this.page.drawRectangle({ x, y, width: w, height: h, ...(color ? { color } : {}), ...(border ? { borderColor: border, borderWidth: bw } : {}) });
    }

    line(x1, y1, x2, y2, { color = COLORS.line, th = 0.6 } = {}) {
        this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: th, color });
    }

    // X wala checkbox (official jaisa). Return: kitni jagah li
    cb(xRight, y, checked, size = 6.5) {
        const x = xRight - size;
        this.rect(x, y, size, size, { bw: 0.6 });
        if (checked) {
            this.line(x + 1.2, y + 1.2, x + size - 1.2, y + size - 1.2, { color: COLORS.value, th: 1 });
            this.line(x + 1.2, y + size - 1.2, x + size - 1.2, y + 1.2, { color: COLORS.value, th: 1 });
        }
        return size + 3;
    }

    wrap(text, maxW, size, font = this.font) {
        const words = String(text ?? "").split(/\s+/).filter(Boolean);
        const lines = [];
        let line = "";
        words.forEach((word) => {
            const next = line ? `${line} ${word}` : word;
            if (line && this.width(next, size, font) > maxW) {
                lines.push(line);
                line = word;
            } else line = next;
        });
        if (line) lines.push(line);
        return lines.length ? lines : [""];
    }

    // Lines likho. Return: aakhri line ka baseline
    para(text, xRight, y, maxW, { size = 7, lh = 8.4, font = this.font, color = COLORS.text } = {}) {
        const lines = this.wrap(text, maxW, size, font);
        lines.forEach((ln, i) => this.t(ln, xRight, y - i * lh, { size, font, color }));
        return y - (lines.length - 1) * lh;
    }

    // Number boxes (ID, date, deduction file, zip). Digits left se right; boxes xRight pe khatam, y = neeche wali line.
    digits(value, xRight, y, n, { cell = 10, groups = [], size = 9.5 } = {}) {
        const x0 = xRight - n * cell;
        this.line(x0, y, xRight, y);
        for (let i = 0; i <= n; i += 1) {
            const tall = i === 0 || i === n || groups.includes(i);
            this.line(x0 + i * cell, y, x0 + i * cell, y + (tall ? 6 : 3.5));
        }
        [...digitsOf(value).slice(0, n)].forEach((c, i) => this.tc(c, x0 + i * cell + cell / 2, y + 2, { size, color: COLORS.value }));
        return n * cell;
    }

    // Section heading (bold) + chhota sub text. Return: heading ki width
    heading(text, y, { xRight = R, sub = "", size = 10 } = {}) {
        const w = this.t(text, xRight, y, { size, font: this.bold });
        if (sub) this.t(sub, xRight - w - 5, y, { size: 6.6, color: COLORS.label });
        return w;
    }
}

// Ek row ke cells (right se left). cell: { w (hissa), label, value | digits: n | draw(xR, top, w, h) }
const cellRow = (s, top, h, cells, { xRight = R, total = W } = {}) => {
    let xR = xRight;
    cells.forEach((c) => {
        const w = c.w * total;
        s.rect(xR - w, top - h, w, h);
        if (c.label) s.t(c.label, xR - 3, top - 7.5, { size: 6.2, color: COLORS.label, maxW: w - 6 });
        const raw = digitsOf(c.value);
        if (c.draw) c.draw(xR, top, w, h);
        else if (c.digits && raw.length <= c.digits) {
            const cell = Math.min(c.cell || 10.5, (w - 8) / c.digits);
            s.digits(raw, xR - 4, top - h + 3.5, c.digits, { cell, groups: c.groups || [] });
        } else if (c.value) s.t(c.value, xR - 4, top - h + 5, { size: 9, color: COLORS.value, maxW: w - 8 });
        xR -= w;
    });
    return top - h;
};

// Cell ke andar checkbox options. rows = [[{ label, checked, value }]]
const optionRows = (s, rows, xR, top, { size = 6.8, lh = 9.5, first = 17 } = {}) => {
    rows.forEach((row, i) => {
        let x = xR - 4;
        const y = top - first - i * lh;
        row.forEach((o) => {
            x -= s.cb(x, y - 1, o.checked);
            x -= s.t(o.label, x, y, { size }) + 3;
            if (o.value) x -= s.t(o.value, x, y, { size: 8, color: COLORS.value }) + 3;
            x -= 5;
        });
    });
};

// Checkbox + wrap hone wala text. y = pehli line ka baseline. Return: aakhri line ka baseline
const checkPara = (s, checked, text, xRight, y, maxW, { size = 7, lh = 8.4, font } = {}) => {
    const cbw = s.cb(xRight, y - 1, checked);
    return s.para(text, xRight - cbw, y, maxW - cbw, { size, lh, font });
};

const dateCell = (label, iso, w) => ({ w, label, value: dateDigits(iso), digits: 8, groups: [2, 4] });

// ג table (page 1 aur "המשך" page dono)
const childTable = (s, top, xRight, width, children, rows) => {
    const cols = [
        { w: 0.07, label: "1" },
        { w: 0.07, label: "2" },
        { w: 0.3, label: "שם" },
        { w: 0.29, label: "מספר זהות" },
        { w: 0.27, label: "תאריך לידה" },
    ];
    const headH = 12;
    const rowH = 16.6;
    let xR = xRight;
    cols.forEach((c) => {
        const w = c.w * width;
        s.rect(xR - w, top - headH, w, headH);
        s.tc(c.label, xR - w / 2, top - 8.5, { size: 7, font: s.bold });
        xR -= w;
    });
    for (let r = 0; r < rows; r += 1) {
        const child = children[r];
        const rowTop = top - headH - r * rowH;
        xR = xRight;
        cols.forEach((c, i) => {
            const w = c.w * width;
            s.rect(xR - w, rowTop - rowH, w, rowH, { bw: 0.4 });
            if (child) {
                const base = rowTop - rowH + 4;
                if (i === 0 && child.inCustody) s.cb(xR - w / 2 + 3.25, base, true);
                if (i === 1 && child.receivesAllowance) s.cb(xR - w / 2 + 3.25, base, true);
                if (i === 2) s.t(child.firstName, xR - 4, base + 1, { size: 9, color: COLORS.value, maxW: w - 8 });
                if (i === 3) s.digits(child.idNumber, xR - 3, base - 0.5, 9, { cell: Math.min(9.8, (w - 6) / 9), size: 9 });
                if (i === 4) s.digits(dateDigits(child.birthDate), xR - 3, base - 0.5, 8, { cell: Math.min(10, (w - 6) / 8), groups: [2, 4], size: 9 });
            }
            xR -= w;
        });
    }
    return top - headH - rows * rowH;
};

// ---------- page 1 ----------
const drawPage1 = (s, form, employer) => {
    const e = form.employee;
    const cx = A4[0] / 2;

    // Header
    s.tl("0101/130", L, 806, { size: 11, font: s.bold });
    s.tl("דף 1 מתוך 2", L + 100, 806, { size: 7.5 });
    s.t("רשות המסים בישראל", R, 806, { size: 8, font: s.bold });
    const tw = s.tc("כרטיס עובד", cx, 795, { size: 22, font: s.bold });
    s.t("(1)", cx - tw / 2 - 1, 806, { size: 7 });
    s.tc("ובקשה להקלה ולתיאום מס על ידי המעסיק (1)", cx, 780, { size: 10.5, font: s.bold });
    s.tc('לפי תקנות מס הכנסה (ניכוי ממשכורת ומשכר עבודה), התשנ"ג - 1993', cx, 769, { size: 7.2 });
    const yearLabelW = s.width("שנת המס", 12, s.bold);
    const yearRight = cx + (yearLabelW + 8 + 52) / 2;
    s.t("שנת המס", yearRight, 752, { size: 12, font: s.bold });
    s.digits(form.taxYear, yearRight - yearLabelW - 8, 750, 4, { cell: 13, size: 11 });

    s.rect(L, 712, W, 32);
    const introEnd = s.para(
        'טופס זה ימולא על-ידי כל עובד עם תחילת עבודתו, וכן בתחילת כל שנת מס (אא"כ המנהל אישר אחרת). הטופס מהווה אסמכתא למעסיק למתן הקלות במס ולעריכת תיאומי מס בחישוב משכורת העובד (1). אם חל שינוי בפרטים - יש להצהיר על כך תוך שבוע ימים.',
        R - 5,
        735,
        W - 10,
        { size: 7, lh: 8.3 }
    );
    s.tc("{ראה הסברים (לפי המספרים) מעבר לדף}", cx, introEnd - 8.3, { size: 6.8 });

    // א. פרטי המעסיק: official form jaisa sirf 4 box. taxId (ח.פ.) club mein save hota hai, PDF mein nahi.
    s.heading("א. פרטי המעסיק", 701, { sub: '(למילוי ע"י המעסיק)' });
    cellRow(s, 696, 26, [
        { w: 0.36, label: "שם", value: employer.name },
        { w: 0.3, label: "כתובת", value: employer.address },
        { w: 0.15, label: "מספר טלפון", value: employer.phone },
        { w: 0.19, label: "מספר תיק ניכויים", value: employer.deductionFileNumber, digits: 9 },
    ]);

    // ב. פרטי העובד/ת
    const bw = s.heading("ב. פרטי העובד/ת", 659);
    const note =
        "(יש לצרף צילום תעודת זהות כולל ספח. אם צורף בעבר, יש לצרף צילום רק אם היו שינויים בפרטים. למי שאין מספר תעודת זהות יש לצרף צילום דרכון ואישור / רשיון שהייה בישראל שנתנו על ידי רשות האוכלוסין וההגירה)";
    const firstLine = s.wrap(note, W - bw - 8, 6.2)[0];
    s.t(firstLine, R - bw - 5, 659, { size: 6.2, color: COLORS.label });
    s.para(note.slice(firstLine.length).trim(), R, 651, W, { size: 6.2, color: COLORS.label });

    let y = cellRow(s, 646, 26, [
        { w: 0.22, label: "מספר זהות (9 ספרות)", value: e.idNumber, digits: 9 },
        { w: 0.22, label: "שם משפחה", value: e.lastName },
        { w: 0.2, label: "שם פרטי", value: e.firstName },
        dateCell("תאריך לידה", e.birthDate, 0.18),
        dateCell("תאריך עליה", e.aliyahDate, 0.18),
    ]);
    y = cellRow(s, y, 24, [
        { w: 0.22, label: "מספר דרכון (למי שאין מספר ת.ז.)", value: passportText(e) },
        { w: 0.28, label: "כתובת פרטית - רחוב/שכונה", value: e.address.street },
        { w: 0.08, label: "מספר", value: e.address.houseNumber },
        { w: 0.2, label: "עיר/ישוב", value: e.address.city },
        { w: 0.22, label: "מיקוד", value: e.address.zip, digits: 7 },
    ]);
    const k = e.kibbutz || {};
    y = cellRow(s, y, 40, [
        { w: 0.09, label: "מין", draw: (xR, top) => optionRows(s, [[{ label: "זכר", checked: e.gender === "male" }], [{ label: "נקבה", checked: e.gender === "female" }]], xR, top) },
        {
            w: 0.27,
            label: "מצב משפחתי",
            draw: (xR, top) =>
                optionRows(
                    s,
                    [
                        [
                            { label: "רווק/ה", checked: e.maritalStatus === "single" },
                            { label: "נשוי/אה", checked: e.maritalStatus === "married" },
                            { label: "גרוש/ה", checked: e.maritalStatus === "divorced" },
                        ],
                        [
                            { label: "אלמן/ה", checked: e.maritalStatus === "widowed" },
                            { label: 'פרוד/ה (חובה לצרף אישור פ"ש)', checked: e.maritalStatus === "separated" },
                        ],
                    ],
                    xR,
                    top
                ),
        },
        { w: 0.09, label: "תושב ישראל", draw: (xR, top) => optionRows(s, [[{ label: "כן", checked: e.israeliResident }], [{ label: "לא", checked: !e.israeliResident }]], xR, top) },
        {
            w: 0.32,
            label: "חבר קיבוץ/מושב שיתופי",
            draw: (xR, top) =>
                optionRows(
                    s,
                    [
                        [{ label: "לא", checked: !k.member }],
                        [{ label: "כן. הכנסותיי ממעסיק זה מועברות לקיבוץ", checked: !!k.member && !!k.incomeTransferred }],
                        [{ label: "כן. הכנסותיי ממעסיק זה אינן מועברות לקיבוץ (8)", checked: !!k.member && !k.incomeTransferred }],
                    ],
                    xR,
                    top,
                    { size: 6.5, lh: 9, first: 16 }
                ),
        },
        {
            w: 0.23,
            label: "חבר בקופת חולים",
            draw: (xR, top) =>
                optionRows(
                    s,
                    [
                        [{ label: "לא", checked: !e.healthFund.member }],
                        [{ label: "כן, שם הקופה:", checked: !!e.healthFund.member, value: e.healthFund.member ? HEALTH_FUND_LABELS[e.healthFund.name] || e.healthFund.name : "" }],
                    ],
                    xR,
                    top
                ),
        },
    ]);
    y = cellRow(s, y, 22, [
        { w: 0.5, label: "כתובת דואר אלקטרוני", value: e.email },
        { w: 0.25, label: "מספר טלפון", value: e.phone },
        { w: 0.25, label: "מספר טלפון נייד", value: e.mobile },
    ]);

    // ג (right column) + ד / ה (left column)
    const wR = W * 0.6;
    const xRl = R - wR - 8; // left column ka right edge
    const wl = xRl - L;

    s.heading("ג. פרטים על ילדיי שבשנת המס טרם מלאו להם 19 שנה", 523, { size: 9.5, sub: '(עפ"י ספח תעודת זהות)' });
    s.t("סמן/י X ליד שם הילד: בטור 1 אם הילד נמצא בחזקתך", R, 513, { size: 6.6 });
    s.t('בטור 2 אם את/ה מקבל/ת בגינו קצבת ילדים מב"ל', R, 505, { size: 6.6 });
    const childrenBottom = childTable(s, 500, R, wR, form.children, CHILD_ROWS);
    if (form.children.length > CHILD_ROWS) {
        s.t(`ראה המשך בדף נפרד (${form.children.length - CHILD_ROWS} ילדים נוספים)`, R, childrenBottom - 8, { size: 6.6, color: COLORS.label });
    }

    // ד
    s.heading("ד. פרטים על הכנסותיי ממעסיק זה", 523, { xRight: xRl, size: 9.5 });
    s.rect(L, 422, wl, 94);
    s.t("אני מקבל/ת: (ראה הסברים מעבר לדף)", xRl - 4, 506, { size: 6.8 });
    Object.entries(INCOME_LABELS).forEach(([key, label], i) => {
        const yy = 494 - i * 11;
        const w = s.cb(xRl - 4, yy - 1, form.employerIncome.type === key);
        s.t(label, xRl - 4 - w, yy, { size: 7.5 });
    });
    s.rect(L + 4, 466, 84, 44);
    s.t("תאריך תחילת העבודה (1)", L + 84, 500, { size: 6.3, color: COLORS.label });
    s.t("בשנת המס", L + 84, 492, { size: 6.3, color: COLORS.label });
    s.digits(dateDigits(form.employerIncome.startDate), L + 84, 471, 8, { cell: 9.5, groups: [2, 4] });

    // ה
    const o = form.otherIncome;
    s.heading("ה. פרטים על הכנסות אחרות", 411, { xRight: xRl, size: 9.5 });
    const xIn = xRl - 4;
    const inW = wl - 8;
    let yy = 395;
    yy = checkPara(s, !o.hasOther, "אין לי הכנסות אחרות ממשכורת (משכורת חודש, בעד משרה נוספת, משכורת חלקית, שכר עבודה), מקצבה וממלגה (1)", xIn, yy, inW) - 10;
    yy = checkPara(s, o.hasOther, "יש לי הכנסות אחרות כמפורט להלן:", xIn, yy, inW) - 9.5;
    const typeCols = [
        ["monthly", "additional", "partial"],
        ["daily", "allowance", "scholarship"],
    ];
    const colW = (inW - 10) / 2;
    typeCols.forEach((keys, c) => {
        keys.forEach((key, r) => {
            const x = xIn - 10 - c * colW;
            const w = s.cb(x, yy - r * 9.5 - 1, o.types.includes(key));
            s.t(INCOME_LABELS[key], x - w, yy - r * 9.5, { size: 6.8, maxW: colW - w - 2 });
        });
    });
    yy -= 3 * 9.5 + 1;
    s.t("אם יש לך הכנסה אחרת - נא סמן/י:", xIn, yy, { size: 6.8, font: s.bold });
    yy -= 10;
    [
        [o.creditPoints === "here", "אבקש לקבל נקודות זיכוי ומדרגות מס כנגד הכנסתי זו (סעיף ד). איני מקבל/ת אותן בהכנסה אחרת (7)"],
        [o.creditPoints === "elsewhere", "אני מקבל/ת נקודות זיכוי ומדרגות מס בהכנסה אחרת ועל כן איני זכאי/ת להן כנגד הכנסה זו (8)"],
        [o.noStudyFund, "אין מפרישים עבורי לקרן השתלמות בגין הכנסתי האחרת, או שכל הפרשות המעסיק לקרן השתלמות בגין הכנסתי האחרת מצורפות להכנסתי האחרת (9)"],
        [o.noPension, "אין מפרישים עבורי לקצבה/לביטוח אובדן כושר עבודה/פיצויים בגין הכנסתי האחרת, או שכל הפרשות המעסיק לקצבה/לביטוח אובדן כושר עבודה/פיצויים בגין הכנסתי האחרת מצורפות להכנסתי האחרת (10)"],
    ].forEach(([checked, text]) => {
        yy = checkPara(s, checked, text, xIn, yy, inW) - 10;
    });
    const otherBottom = yy + 10 - 4;
    s.rect(L, otherBottom, wl, 405 - otherBottom);

    // ו. פרטים על בן/בת הזוג
    const sp = form.spouse;
    const vTop = Math.min(childrenBottom - (form.children.length > CHILD_ROWS ? 12 : 0), otherBottom) - 14;
    s.heading("ו. פרטים על בן/בת הזוג", vTop);
    y = cellRow(s, vTop - 5, 24, [
        { w: 0.22, label: "מספר זהות (9 ספרות)", value: sp?.idNumber || "", digits: 9 },
        { w: 0.22, label: "שם משפחה", value: sp?.lastName || "" },
        { w: 0.2, label: "שם פרטי", value: sp?.firstName || "" },
        dateCell("תאריך לידה", sp?.birthDate, 0.18),
        dateCell("תאריך עליה", sp?.aliyahDate, 0.18),
    ]);
    y = cellRow(s, y, 20, [
        { w: 0.22, label: "מספר דרכון (למי שאין מספר זהות)", value: passportText(sp) },
        {
            w: 0.78,
            draw: (xR, top) =>
                optionRows(
                    s,
                    [
                        [
                            { label: "אין לבן/בת הזוג כל הכנסה", checked: !!sp && !sp.hasIncome },
                            { label: "יש לבן/בת הזוג הכנסה מ:", checked: !!sp?.hasIncome },
                            { label: "עבודה/קצבה/עסק", checked: !!sp?.incomeTypes?.includes("work") },
                            { label: "הכנסה אחרת", checked: !!sp?.incomeTypes?.includes("other") },
                        ],
                    ],
                    xR,
                    top,
                    { size: 7.2, first: 12.5 }
                ),
        },
    ]);

    // ז. שינויים במהלך השנה
    const zTop = y - 13;
    s.heading("ז. שינויים במהלך השנה", zTop, { sub: "(כולל שינויים הקשורים לבקשה להקלה בחישוב המס מעבר לדף)" });
    const zCols = [
        { w: 0.15, label: "תאריך השינוי" },
        { w: 0.55, label: "פרטי השינוי" },
        { w: 0.15, label: "תאריך ההודעה" },
        { w: 0.15, label: "חתימת העובד/ת" },
    ];
    let xR = R;
    zCols.forEach((c) => {
        const w = c.w * W;
        s.rect(xR - w, zTop - 17, w, 12);
        s.tc(c.label, xR - w / 2, zTop - 13.5, { size: 7, font: s.bold });
        xR -= w;
    });
    for (let r = 0; r < 3; r += 1) {
        const ch = form.changes[r];
        const rowTop = zTop - 17 - r * 14;
        xR = R;
        zCols.forEach((c, i) => {
            const w = c.w * W;
            s.rect(xR - w, rowTop - 14, w, 14, { bw: 0.4 });
            const base = rowTop - 10.5;
            if (i === 0) s.tc(ch ? dmy(ch.date) : "/      /", xR - w / 2, base, { size: 8.5, color: ch ? COLORS.value : COLORS.label });
            if (i === 1 && ch) s.t(ch.details, xR - 4, base, { size: 8.5, color: COLORS.value, maxW: w - 8 });
            if (i === 2) s.tc("/      /", xR - w / 2, base, { size: 8.5, color: COLORS.label });
            xR -= w;
        });
    }
};

// ---------- page 2 ----------
// ח / ט ki ek row (border wala box): number | checkbox + text, phir chhote notes, phir 2 column grid / table
const reasonRow = (s, top, num, checked, text, { notes = [], grid = null, extra = null, size = 7.6 } = {}) => {
    const numW = 18;
    const xR = R - numW - 4;
    const maxW = W - numW - 10;
    const lh = size + 1.6;
    let base = top - 10;
    const cbw = s.cb(xR, base - 1, checked);
    const textRight = xR - cbw;
    const innerW = maxW - cbw;
    let last = s.para(text, textRight, base, innerW, { size, lh });
    notes.forEach((n) => {
        last = s.para(n, textRight, last - 8, innerW, { size: 6.3, lh: 7.4, color: COLORS.label });
    });
    if (grid) {
        const colW = innerW / 2;
        for (let i = 0; i < grid.length; i += 2) {
            const rowBase = last - 9.5;
            [grid[i], grid[i + 1]].forEach((g, j) => {
                if (!g) return;
                const x = textRight - j * colW;
                const w = s.cb(x, rowBase - 1, g.checked, 6);
                s.t(g.text, x - w, rowBase, { size: 6.8, maxW: colW - w - 6 });
            });
            last = rowBase;
        }
    }
    if (extra) last = extra(last, textRight, innerW);
    const bottom = last - 4.5;
    s.rect(L, bottom, W, top - bottom);
    s.line(R - numW, bottom, R - numW, top);
    s.tc(num, R - numW / 2, top - 10, { size: 8.5, font: s.bold });
    return bottom;
};

const ageGrid = (groups, keys) =>
    keys.map((key) => ({ checked: !!groups && groups[key] > 0, text: `${AGE_GROUP_TEXT[key]} ${groups ? groups[key] : "____"}` }));

const EXPLANATIONS = [
    '(1) "עובד" יחיד המקבל משכורת. "מעסיק" אדם המשלם משכורת. "משכורת" הכנסת עבודה, קיצבה, מענק עקב פרישה או מוות, מילגה וכיו"ב. "עבודה" לרבות קבלת משכורת. "מלגה" לרבות מענק, פרס או פטור מתשלום שניתן לסטודנט או לחוקר.',
    "(2) משכורת חודש - משכורת בעד עבודה של לא פחות מ - 18 יום בחודש.",
    '(3) משכורת בעד משרה נוספת - משכורת בעד עבודה של יותר מ - 5 שעות ביום, נוסף למשכורת ו/או בנוסף לקצבה החייבת במס ממקום אחר. העובד רשאי לבחור את מקום העבודה בו תחשב משכורתו כ"משכורת בעד משרה נוספת".',
    "(4) משכורת חלקית - משכורת בעד עבודה של 5 שעות או פחות ליום או משכורת בעד עבודה במשך יותר מ-5 שעות ליום אך פחות מ-8 שעות בשבוע. ממשכורת חלקית ינוכה מס בשיעור מירבי אלא אם כן זו הכנסה יחידה שאז ינוכה מס לפי לוח הניכויים.",
    "(5) שכר עבודה - משכורת בעד עבודה של פחות מ - 18 יום בחודש אך לא פחות מ - 8 שעות בשבוע. משכר עבודה ינוכה מס לפי לוח יומי אלא אם כן זו הכנסה יחידה שאז ינוכה מס לפי לוח הניכויים.",
    "(6) קצבה - אין לדווח על קצבה פטורה מביטוח לאומי וקצבת שאירים שכולה פטורה.",
    "(7) אם העובד לא מילא משבצת זו - המעסיק מנוע מלנכות מס לפי לוח הניכויים ויש לנכות מס מירבי לפי התקנות מכל תשלומי המעסיק.",
    "(8) אם העובד מילא משבצת זו - המעסיק מנוע מלנכות מס לפי לוח הניכויים ויש לנכות מס מירבי לפי התקנות מכל תשלומי המעסיק.",
    "(9) אם העובד לא מילא משבצת זו - על המעסיק לצרף למשכורת את סכומי ההפרשות לקרן השתלמות ולנכות מס לפי התקנות או לפעול לפי אישור תיאום מס מפקיד השומה.",
    '(10) אם העובד לא מילא משבצת זו - על המעסיק לצרף למשכורת את סכומי ההפרשות לקצבה/לאובדן כושר עבודה ולנכות מס לפי התקנות או לפעול לפי אישור תיאום מס מפ"ש.',
    '(11) הורה במשפחה חד הורית הוא אחד מאלה: רווק, גרוש, אלמן, פרוד (עפ"י אישור פ"ש בלבד).',
    "(12) הורה יחיד - הורה במשפחה חד הורית שהיה לו ילד שבשנת המס טרם מלאו לו 19 שנים ושההורה השני של הילד נפטר או שהילד רשום במרשם האוכלוסין בלא פרטי ההורה השני.",
    '(13) ישוב מזכה - ישוב שחל עליו סעיף 11 לפקודה או סעיף 11 לחוק אס"ח, לפי העניין.',
    "(14) עובד ימלא משבצת זו (2ב') - רק בתנאי שמילא את המשבצת בסעיף 2א' ורק כך יהיה זכאי לתקרת הפטור הגבוהה.",
];

const drawPage2 = (s, form, signatureImage, signedAt) => {
    const e = form.employee;
    const t = form.taxCredits;
    const cx = A4[0] / 2;

    // Header: מספר זהות + דף 2 מתוך 2
    s.tl("101", L, 812, { size: 11, font: s.bold });
    s.tl("דף 2 מתוך 2", L + 28, 812, { size: 7.5 });
    const idLabelW = s.width("מספר זהות", 8);
    const idRight = cx + 80;
    s.t("מספר זהות", idRight, 812, { size: 8 });
    if (e.idNumber) s.digits(e.idNumber, idRight - idLabelW - 6, 810, 9, { cell: 11 });
    else s.t(passportText(e), idRight - idLabelW - 6, 812, { size: 9, color: COLORS.value });

    // ח
    s.heading("ח. אני מבקש/ת פטור או זיכוי ממס מהסיבות הבאות", 796, { sub: "(סמן/י X בריבוע המתאים)" });
    const q = t.qualifyingSettlement;
    const imm = t.newImmigrant;
    const sol = t.dischargedSoldier;
    let y = 790;
    const rows = [
        ["1", t.israeliResident, "אני תושב/ת ישראל."],
        [
            "2א",
            t.disabled,
            "אני נכה 100% / עיוור/ת לצמיתות. מצורף אישור משרד הביטחון/האוצר/פקיד השומה/תעודת עיוור שהוצאה לאחר 1.1.94.",
            { notes: ['אם לא סומן בחלק ה כי "אין לי הכנסות אחרות ממשכורת, מקצבה וממלגה" העובד יופנה לפקיד השומה לעריכת תיאום מס.'] },
        ],
        ["2ב", t.disabilityAllowance, "בנוסף, אני מקבל/ת תגמול חודשי לפי חוק הנכים (תגמולים ושיקום) או לפי חוק התגמולים לנפגעי פעולות איבה (14). יש לצרף אישור על קבלת תגמול זה."],
        [
            "3",
            !!q,
            `אני תושב/ת קבוע/ה בישוב מזכה (13) מתאריך ${fill(dmy(q?.fromDate))}. אני ובני משפחתי מדרגה ראשונה, מתגוררים ביישוב ${fill(q?.settlement, 14)} ואין לי "מרכז חיים" נוסף. מצורף אישור של הרשות ע"ג טופס 1312א.`,
        ],
        [
            "4",
            !!imm,
            `אני עולה חדש/ה מתאריך ${fill(dmy(imm?.fromDate))}. חובה לצרף: תעודת עולה. לא היתה לי הכנסה בישראל מתחילת שנת המס הנוכחית עד תאריך ${fill(dmy(imm?.noIncomeUntil))}.`,
            { notes: ['מי שתקופת זכאותו אינה רצופה בשל שירות חובה בצה"ל, לימודים על תיכוניים או יציאה לחו"ל - יפנה לפקיד השומה.'] },
        ],
        [
            "5",
            t.spouseNoIncome,
            "בגין בן/בת זוגי המתגורר/ת עימי ואין לו/לה הכנסות בשנת המס.",
            { notes: ['רק אם העובד/ת או בן/בת הזוג הגיע/ה לגיל פרישה או שהוא/היא נכה או עיוור/ת עפ"י סעיף 9(5) לפקודה.'] },
        ],
        [
            "6",
            t.singleParentFamily,
            "אני הורה במשפחה חד הורית (11) החי בנפרד.",
            {
                notes: [
                    "ימולא רק ע\"י הורה כאמור החי בנפרד ומבקש נקודות זיכוי עבור ילדיו, הנמצאים בחזקתו ובגינם מקבל קצבת ילדים מהמוסד לביטוח לאומי (בהתאם לסעיף 7 להלן) ואינו מנהל משק בית משותף עם יחיד/ה אחר/ת.",
                ],
            },
        ],
        [
            "7",
            !!t.childrenInCustody,
            "בגין ילדיי שבחזקתי המפורטים בחלק ג.",
            {
                notes: ['ימולא רק ע"י הורה במשפחה חד הורית שמקבל את קצבת הילדים בגינם, או ע"י אשה נשואה או ע"י הורה יחיד (12).'],
                grid: ageGrid(t.childrenInCustody, ["bornThisYear", "age4to5", "age1to2", "age6to17", "age3", "age18"]),
            },
        ],
        [
            "8",
            !!t.childrenNotInCustody,
            "בגין ילדיי המפורטים בחלק ג.",
            {
                notes: ['ימולא ע"י הורה (למעט הורה אשר סימן בפסקה 7 לעיל), אשה לא נשואה שילדיה אינם בחזקתה וכן הורה יחיד (12).'],
                grid: ageGrid(t.childrenNotInCustody, ["bornThisYear", "age4to5", "age1to2", "age6to17", "age3"]),
            },
        ],
        ["9", t.singleParent, "אני הורה יחיד (12) לילדיי שבחזקתי (המפורטים בחלק ג ובהתאם לסעיף 7 ו-8 לעיל)."],
        [
            "10",
            t.supportsChildren,
            "בגין ילדיי שאינם בחזקתי המפורטים בחלק ג ואני משתתף/ת בכלכלתם.",
            { notes: ['ימולא ע"י הורה החי בנפרד, שאינו זכאי לנקודות זיכוי בגין ילדיו, אשר המציא פס"ד המחייב אותו בתשלום מזונות.'] },
        ],
        [
            "11",
            !!t.disabledChildren,
            `אני הורה ל-${fill(t.disabledChildren?.count, 4)} ילדים עם מוגבלות שטרם מלאו להם 19 שנים, בגינם אני מקבל/ת גמלת ילד נכה מהמוסד לביטוח לאומי. מצורף אישור גמלת ילד נכה מהמוסד לביטוח לאומי לשנה נוכחית.`,
            { notes: ["בן זוגי אינו מקבל נקודות זיכוי אלה. לילדיי, בגינם אני מבקש את נקודות הזיכוי, אין הכנסות בשנה הנוכחית."] },
        ],
        ["12", t.alimony, 'בגין מזונות לבן/בת זוגי לשעבר. ימולא ע"י מי שנישא בשנית. מצורף פסק דין.'],
        ["13", t.age16to18, "מלאו לי או לבן/בת זוגי 16 שנים וטרם מלאו לי או לבן/בת זוגי 18 שנים בשנת המס."],
        [
            "14",
            !!sol,
            `אני חייל/ת משוחרר/ת / שירתתי בשירות לאומי. תאריך תחילת השירות ${fill(dmy(sol?.serviceStart))} תאריך סיום השירות ${fill(dmy(sol?.serviceEnd))}. מצורף צילום של תעודת שחרור/סיום שירות.`,
        ],
        ["15", t.academicDegree, "בגין סיום לימודים לתואר אקדמי, סיום התמחות או סיום לימודי מקצוע. מצורפת הצהרה בטופס 119."],
        [
            "16",
            !!t.reserveCombat,
            `שירתתי כלוחם/לוחמת מילואים סה"כ ${fill(t.reserveCombat?.days, 4)} ימי מילואים בשנת המס הקודמת. מצורף אישור מצה"ל על זכאות בעד שירות מילואים כלוחם.`,
        ],
    ];
    rows.forEach(([num, checked, text, opts]) => {
        y = reasonRow(s, y, num, !!checked, text, opts);
    });

    // ט
    const c = form.taxCoordination;
    y -= 12;
    s.heading("ט. אני מבקש/ת תיאום מס מהסיבות הבאות", y, { sub: "(סמן/י X בריבוע המתאים)" });
    y -= 6;
    y = reasonRow(s, y, "1", c.reason === "noIncomeSinceYearStart", "לא היתה לי הכנסה מתחילת שנת המס הנוכחית עד לתחילת עבודתי אצל מעסיק זה.", {
        notes: ['הערות: 1. יש להמציא הוכחה כגון: אישור משטרת הגבולות בגין שהייה בחו"ל, אישור מחלה וכיו"ב. בהעדר הוכחה יש לפנות לפקיד השומה. 2. דמי לידה ודמי אבטלה הינם הכנסה חייבת.'],
    });
    y = reasonRow(s, y, "2", c.reason === "additionalIncome", "יש לי הכנסות נוספות ממשכורת (1) כמפורט להלן:", {
        extra: (last, xRight, width) => {
            const cols = [
                { w: 0.22, label: "שם" },
                { w: 0.22, label: "כתובת" },
                { w: 0.16, label: "מספר תיק ניכויים" },
                { w: 0.14, label: "סוג ההכנסה (עבודה/קצבה/מלגה/אחר)" },
                { w: 0.13, label: "הכנסה חודשית" },
                { w: 0.13, label: "המס שנוכה (לפי התלושים)" },
            ];
            const top = last - 5;
            s.rect(xRight - 0.6 * width, top - 10, 0.6 * width, 10);
            s.tc("המעסיק/משלם המשכורת", xRight - 0.3 * width, top - 7.5, { size: 6.8, font: s.bold });
            let xR = xRight;
            cols.forEach((col, i) => {
                const w = col.w * width;
                const headTop = i < 3 ? top - 10 : top;
                s.rect(xR - w, top - 26, w, headTop - (top - 26));
                // Lamba label do line mein (official jaisa), kaatna nahi
                const lines = s.wrap(col.label, w - 4, 6.2, s.bold).slice(0, 2);
                const mid = (headTop + top - 26) / 2;
                lines.forEach((ln, j) => s.tc(ln, xR - w / 2, mid - 2 + (lines.length === 2 ? (j === 0 ? 3.5 : -3.5) : 0), { size: 6.2, font: s.bold, maxW: w - 4 }));
                xR -= w;
            });
            for (let r = 0; r < 3; r += 1) {
                const inc = c.incomes[r];
                const rowTop = top - 26 - r * 13;
                xR = xRight;
                cols.forEach((col, i) => {
                    const w = col.w * width;
                    s.rect(xR - w, rowTop - 13, w, 13, { bw: 0.4 });
                    if (inc) {
                        const v = [inc.employerName, inc.address, inc.deductionFileNumber, inc.incomeType, inc.monthlyIncome, inc.taxDeducted][i];
                        s.t(v === "" || v === undefined ? "" : String(v), xR - 3, rowTop - 9.5, { size: 8, color: COLORS.value, maxW: w - 6 });
                    }
                    xR -= w;
                });
            }
            return top - 26 - 3 * 13 - 2;
        },
    });
    y = reasonRow(s, y, "3", c.reason === "assessorApproved", "פקיד השומה אישר תיאום לפי אישור מצורף.");

    // י. הצהרה
    y -= 12;
    s.heading("י. הצהרה", y);
    const boxTop = y - 5;
    const boxH = 64;
    s.rect(L, boxTop - boxH, W, boxH);
    s.para(
        "אני מצהיר/ה כי הפרטים שמסרתי בטופס זה הינם מלאים ונכונים. ידוע לי שהשמטה או מסירת פרטים לא נכונים הינה עבירה על פקודת מס הכנסה. אני מתחייב/ת להודיע למעסיק על כל שינוי שיחול בפרטיי האישיים ובפרטים דלעיל תוך שבוע ימים מתאריך השינוי.",
        R - 6,
        boxTop - 11,
        W - 12,
        { size: 7.8, lh: 9.4, font: s.bold }
    );
    const lineY = boxTop - boxH + 14;
    s.line(R - 130, lineY, R - 20, lineY);
    s.tc(signedAt, R - 75, lineY + 3, { size: 10, color: COLORS.value });
    s.tc("תאריך", R - 75, lineY - 9, { size: 7 });
    s.line(R - 380, lineY, R - 200, lineY);
    if (signatureImage) {
        const dims = signatureImage.scaleToFit(170, 28);
        s.page.drawImage(signatureImage, { x: R - 290 - dims.width / 2, y: lineY + 1, width: dims.width, height: dims.height });
    }
    s.tc("חתימת המבקש/ת", R - 290, lineY - 9, { size: 7 });

    // דברי הסבר
    let ny = boxTop - boxH - 12;
    s.tc("דברי הסבר למילוי טופס 101", cx, ny, { size: 7.5, font: s.bold });
    ny -= 8;
    EXPLANATIONS.forEach((text) => {
        ny = s.para(text, R, ny, W, { size: 5.8, lh: 6.7, color: COLORS.label }) - 6.7;
    });
};

// ג ke 13 se zyada bachche: alag page pe baaki
const drawChildrenContinuation = (s, form) => {
    const rest = form.children.slice(CHILD_ROWS);
    s.heading("ג. פרטים על ילדיי שבשנת המס טרם מלאו להם 19 שנה - המשך", 806, { sub: '(עפ"י ספח תעודת זהות)' });
    childTable(s, 796, R, W, rest, rest.length);
};

// ID card / documents: image -> apna page, PDF -> uske pages copy
const appendDocuments = async (pdf, fonts, docs) => {
    for (const doc of docs) {
        const label = doc.label;
        if (doc.mimetype === "application/pdf") {
            let src;
            try {
                src = await PDFDocument.load(doc.data);
            } catch (e) {
                throw new Form101AttachmentError(`${label} could not be read as a PDF.`);
            }
            const pages = await pdf.copyPages(src, src.getPageIndices());
            pages.forEach((p, i) => {
                pdf.addPage(p);
                if (i === 0) {
                    const { width, height } = p.getSize();
                    p.drawRectangle({ x: 0, y: height - 22, width, height: 22, color: rgb(1, 1, 1), opacity: 0.85 });
                    drawRtl(p, label, width - 16, height - 15, { size: 10, font: fonts.bold, color: COLORS.text });
                }
            });
            continue;
        }

        let image;
        try {
            image = doc.mimetype === "image/png" ? await pdf.embedPng(doc.data) : await pdf.embedJpg(doc.data);
        } catch (e) {
            throw new Form101AttachmentError(`${label} could not be read as an image.`);
        }
        const page = pdf.addPage(A4);
        drawRtl(page, label, A4[0] - M, A4[1] - M - 8, { size: 11, font: fonts.bold, color: COLORS.text });
        const dims = image.scaleToFit(A4[0] - 2 * M, A4[1] - 2 * M - 30);
        page.drawImage(image, { x: (A4[0] - dims.width) / 2, y: A4[1] - M - 24 - dims.height, width: dims.width, height: dims.height });
    }
};

/**
 * @param {object} form      parseForm101() ka output
 * @param {object} employer  { name, address, phone, taxId, deductionFileNumber }
 * @param {object} files     { signature: { data, mimetype }, idCard: [file], attachments: [file], signedAt: "dd/mm/yyyy" }
 *                           file = express-fileupload object ({ data: Buffer, mimetype, name })
 * @returns {Promise<Buffer>}
 */
const buildForm101Pdf = async (form, employer, files) => {
    const bytes = loadFonts();
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    pdf.setTitle(`Form 101 ${form.taxYear}`);
    pdf.setProducer("Courtside");

    const fonts = {
        regular: await pdf.embedFont(bytes.regular, { subset: true }),
        bold: await pdf.embedFont(bytes.bold, { subset: true }),
    };

    let signatureImage = null;
    try {
        signatureImage = files.signature.mimetype === "image/png" ? await pdf.embedPng(files.signature.data) : await pdf.embedJpg(files.signature.data);
    } catch (e) {
        throw new Form101AttachmentError("Signature could not be read as an image.");
    }

    drawPage1(new Sheet(pdf.addPage(A4), fonts), form, employer);
    drawPage2(new Sheet(pdf.addPage(A4), fonts), form, signatureImage, files.signedAt);
    if (form.children.length > CHILD_ROWS) drawChildrenContinuation(new Sheet(pdf.addPage(A4), fonts), form);

    await appendDocuments(pdf, fonts, [
        ...(files.idCard || []).map((f, i) => ({ ...f, data: f.data, mimetype: f.mimetype, label: i === 0 ? "צילום תעודת זהות" : "ספח תעודת זהות" })),
        ...(files.creditDocs || []).map((f) => ({ data: f.data, mimetype: f.mimetype, label: f.label })),
        ...(files.attachments || []).map((f, i) => ({ data: f.data, mimetype: f.mimetype, label: `מסמך מצורף ${i + 1}` })),
    ]);

    return Buffer.from(await pdf.save());
};

module.exports = { buildForm101Pdf, segments, Form101PdfNotReady, Form101AttachmentError };
