const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

// Form 101 ka PDF, poora memory mein (Buffer). Disk / S3 pe kuch nahi likhte.
// Layout khud banate hain (official 101 ke saare sections א-י, same Hebrew labels), template ki zarurat nahi.
// Font: Alef (OFL, assets/form101). Pages: form (2-3 page) + signature + ID / documents aakhri pages mein.

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
    monthly: "משכורת חודש",
    additional: "משכורת בעד משרה נוספת",
    partial: "משכורת חלקית",
    daily: "שכר עבודה (עובד יומי)",
    allowance: "קצבה",
    scholarship: "מלגה",
};
const GENDER_LABELS = { male: "זכר", female: "נקבה" };
const MARITAL_LABELS = { single: "רווק/ה", married: "נשוי/אה", divorced: "גרוש/ה", widowed: "אלמן/ה", separated: "פרוד/ה" };
const kibbutzLabel = (k) =>
    !k?.member ? "לא" : k.incomeTransferred ? "כן, הכנסותיי ממעסיק זה מועברות לקיבוץ" : "כן, הכנסותיי ממעסיק זה אינן מועברות לקיבוץ";
const HEALTH_FUND_LABELS = { clalit: "כללית", maccabi: "מכבי", meuhedet: "מאוחדת", leumit: "לאומית" };
// "מספר דרכון / מדינה"
const passportText = (p) => (p?.passportNumber ? [p.passportNumber, p.passportCountry].filter(Boolean).join(" / ") : "");
const AGE_GROUP_LABELS = {
    bornThisYear: "נולדו בשנת המס",
    age1to2: "ימלאו להם שנה עד שנתיים",
    age3: "ימלאו להם 3 שנים",
    age4to5: "ימלאו להם 4 עד 5 שנים",
    age6to17: "ימלאו להם 6 עד 17 שנים",
    age18: "ימלאו להם 18 שנים",
};

// "2026-05-14" -> "14/05/2026"
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const blank = (v) => (v === undefined || v === null || v === "" ? "______" : String(v));

// ---------- chhota layout engine (RTL: right se left) ----------
const A4 = [595.28, 841.89];
const M = 32; // margin
const COLORS = { text: rgb(0.1, 0.1, 0.1), label: rgb(0.42, 0.42, 0.42), line: rgb(0.7, 0.7, 0.7), bar: rgb(0.9, 0.93, 0.97), value: rgb(0.05, 0.2, 0.55) };

class Layout {
    constructor(pdf, fonts, footer) {
        this.pdf = pdf;
        this.font = fonts.regular;
        this.bold = fonts.bold;
        this.footer = footer;
        this.pages = [];
        this.newPage();
    }

    get right() {
        return A4[0] - M;
    }

    get width() {
        return A4[0] - 2 * M;
    }

    newPage() {
        this.page = this.pdf.addPage(A4);
        this.pages.push(this.page);
        this.y = A4[1] - M;
    }

    ensure(height) {
        if (this.y - height < M + 20) this.newPage();
    }

    widthOf(text, size, font = this.font) {
        return textWidth(text, size, font);
    }

    // xRight pe khatam hone wala text (RTL)
    text(text, xRight, y, { size = 9, font = this.font, color = COLORS.text } = {}) {
        return drawRtl(this.page, text, xRight, y, { size, font, color });
    }

    wrap(text, maxWidth, size, font = this.font) {
        const words = String(text ?? "").split(/\s+/).filter(Boolean);
        const lines = [];
        let line = "";
        words.forEach((word) => {
            const next = line ? `${line} ${word}` : word;
            if (line && this.widthOf(next, size, font) > maxWidth) {
                lines.push(line);
                line = word;
            } else line = next;
        });
        if (line) lines.push(line);
        return lines.length ? lines : [""];
    }

    checkbox(xRight, y, checked) {
        const s = 8;
        const x = xRight - s;
        this.page.drawRectangle({ x, y: y - 1, width: s, height: s, borderColor: COLORS.text, borderWidth: 0.7 });
        if (checked) {
            this.page.drawLine({ start: { x: x + 1.5, y: y + 0.5 }, end: { x: x + s - 1.5, y: y + s - 2.5 }, thickness: 1.1, color: COLORS.value });
            this.page.drawLine({ start: { x: x + 1.5, y: y + s - 2.5 }, end: { x: x + s - 1.5, y: y + 0.5 }, thickness: 1.1, color: COLORS.value });
        }
        return s + 4;
    }

    title(text, sub = "") {
        this.ensure(40);
        this.y -= 6;
        this.page.drawRectangle({ x: M, y: this.y - 14, width: this.width, height: 16, color: COLORS.bar });
        const w = this.text(text, this.right - 4, this.y - 10, { size: 10.5, font: this.bold });
        if (sub) this.text(sub, this.right - 10 - w, this.y - 10, { size: 7.5, color: COLORS.label });
        this.y -= 20;
    }

    // cells: [{ label, value | checks: [{ label, checked }], w }]  w = width ka hissa (sab milke 1)
    row(cells, height = 27) {
        this.ensure(height);
        let xRight = this.right;
        const top = this.y;
        cells.forEach((cell) => {
            const w = cell.w * this.width;
            this.page.drawRectangle({ x: xRight - w, y: top - height, width: w, height, borderColor: COLORS.line, borderWidth: 0.5 });
            this.text(cell.label, xRight - 3, top - 9, { size: 6.8, color: COLORS.label });
            if (cell.checks) {
                let x = xRight - 3;
                cell.checks.forEach((c) => {
                    x -= this.checkbox(x, top - 21, c.checked);
                    x -= this.text(c.label, x, top - 21, { size: 8 }) + 7;
                });
            } else {
                const value = this.wrap(cell.value, w - 6, 9.5)[0];
                this.text(value, xRight - 3, top - 21, { size: 9.5, color: COLORS.value });
            }
            xRight -= w;
        });
        this.y -= height;
    }

    // checkbox + wrap hone wala text (number optional, jaise "2א")
    checkLine(checked, text, { num = "", indent = 0, size = 8.5 } = {}) {
        const numW = num ? 18 : 0;
        const maxW = this.width - indent - numW - 16;
        const lines = this.wrap(text, maxW, size);
        this.ensure(lines.length * 11 + 3);
        let x = this.right - indent;
        if (num) {
            this.text(num, x, this.y - 9, { size, font: this.bold });
            x -= numW;
        }
        x -= this.checkbox(x, this.y - 9, checked);
        lines.forEach((line, i) => this.text(line, x, this.y - 9 - i * 11, { size, color: checked ? COLORS.text : COLORS.label }));
        this.y -= lines.length * 11 + 3;
    }

    paragraph(text, { size = 8.5, font = this.font, color = COLORS.text, indent = 0 } = {}) {
        const lines = this.wrap(text, this.width - indent - 4, size, font);
        this.ensure(lines.length * 11 + 2);
        lines.forEach((line, i) => this.text(line, this.right - indent - 2, this.y - 9 - i * 11, { size, font, color }));
        this.y -= lines.length * 11 + 2;
    }

    // table: headers [{ label, w }], rows: [[...values]]
    table(headers, rows, minRows = 0) {
        const all = [...rows];
        while (all.length < minRows) all.push(headers.map(() => ""));
        this.ensure(16 + 16 * Math.min(all.length, 3));
        const drawRow = (values, isHead) => {
            this.ensure(16);
            let xRight = this.right;
            values.forEach((value, i) => {
                const w = headers[i].w * this.width;
                this.page.drawRectangle({
                    x: xRight - w, y: this.y - 16, width: w, height: 16, borderColor: COLORS.line, borderWidth: 0.5,
                    ...(isHead ? { color: COLORS.bar } : {}),
                });
                const v = this.wrap(value, w - 6, isHead ? 7.5 : 9)[0];
                this.text(v, xRight - 3, this.y - 11, { size: isHead ? 7.5 : 9, font: isHead ? this.bold : this.font, color: isHead ? COLORS.text : COLORS.value });
                xRight -= w;
            });
            this.y -= 16;
        };
        drawRow(headers.map((h) => h.label), true);
        all.forEach((r) => drawRow(r, false));
    }

    gap(h = 4) {
        this.y -= h;
    }

    drawFooters() {
        const total = this.pages.length;
        this.pages.forEach((page, i) => {
            this.page = page;
            this.text(`${this.footer} | עמוד ${i + 1} מתוך ${total}`, this.right, M - 14, { size: 7, color: COLORS.label });
        });
    }
}

// ---------- sections ----------
const drawForm = (L, form, employer, signatureImage, signedAt) => {
    const e = form.employee;

    // Header
    L.text("כרטיס עובד ובקשה להקלה ולתיאום מס על ידי המעסיק", L.right, L.y - 14, { size: 15, font: L.bold });
    L.text(`טופס 101 | שנת המס ${form.taxYear}`, L.right, L.y - 30, { size: 10.5, font: L.bold, color: COLORS.value });
    L.text("לפי תקנות מס הכנסה (ניכוי ממשכורת ומשכר עבודה), התשנ\"ג-1993", M + 230, L.y - 30, { size: 7.5, color: COLORS.label });
    L.y -= 38;
    L.paragraph("טופס זה ימולא על-ידי כל עובד עם תחילת עבודתו, וכן בתחילת כל שנת מס. הטופס מהווה אסמכתא למעסיק למתן הקלות במס ולעריכת תיאומי מס בחישוב משכורת העובד. אם חל שינוי בפרטים - יש להצהיר על כך תוך שבוע ימים.", { size: 7.5, color: COLORS.label });

    // א
    L.title("א. פרטי המעסיק");
    L.row([
        { label: "שם", value: employer.name, w: 0.34 },
        { label: "כתובת", value: employer.address, w: 0.26 },
        { label: "מספר טלפון", value: employer.phone, w: 0.13 },
        { label: "מספר תיק ניכויים", value: employer.deductionFileNumber, w: 0.14 },
        { label: "ח.פ. / מס' עמותה", value: employer.taxId, w: 0.13 },
    ]);

    // ב
    L.title("ב. פרטי העובד/ת", "(מצורף צילום תעודת זהות כולל ספח)");
    L.row([
        { label: "מספר זהות (9 ספרות)", value: e.idNumber, w: 0.2 },
        { label: "שם משפחה", value: e.lastName, w: 0.22 },
        { label: "שם פרטי", value: e.firstName, w: 0.22 },
        { label: "תאריך לידה", value: dmy(e.birthDate), w: 0.18 },
        { label: "תאריך עליה", value: dmy(e.aliyahDate), w: 0.18 },
    ]);
    L.row([
        { label: "דרכון זר / מדינה (למי שאין ת.ז.)", value: passportText(e), w: 0.2 },
        { label: "רחוב/שכונה", value: e.address.street, w: 0.3 },
        { label: "מספר", value: e.address.houseNumber, w: 0.1 },
        { label: "עיר/ישוב", value: e.address.city, w: 0.24 },
        { label: "מיקוד", value: e.address.zip, w: 0.16 },
    ]);
    L.row([
        { label: "מין", checks: Object.entries(GENDER_LABELS).map(([k, label]) => ({ label, checked: e.gender === k })), w: 0.2 },
        { label: "מצב משפחתי", checks: Object.entries(MARITAL_LABELS).map(([k, label]) => ({ label, checked: e.maritalStatus === k })), w: 0.5 },
        { label: "תושב ישראל", checks: [{ label: "כן", checked: e.israeliResident }, { label: "לא", checked: !e.israeliResident }], w: 0.15 },
        { label: "חבר בקופת חולים", value: e.healthFund.member ? `כן, ${HEALTH_FUND_LABELS[e.healthFund.name] || e.healthFund.name}` : "לא", w: 0.15 },
    ]);
    L.row([
        { label: "חבר קיבוץ/מושב שיתופי", value: kibbutzLabel(e.kibbutz), w: 0.4 },
        { label: "כתובת דואר אלקטרוני", value: e.email, w: 0.3 },
        { label: "מספר טלפון", value: e.phone, w: 0.15 },
        { label: "מספר טלפון נייד", value: e.mobile, w: 0.15 },
    ]);

    // ג
    L.title("ג. פרטים על ילדיי שבשנת המס טרם מלאו להם 19 שנה", "(1 = הילד בחזקתי, 2 = מקבל/ת בגינו קצבת ילדים מב\"ל)");
    L.table(
        [
            { label: "1", w: 0.07 },
            { label: "2", w: 0.07 },
            { label: "שם", w: 0.32 },
            { label: "מספר זהות", w: 0.27 },
            { label: "תאריך לידה", w: 0.27 },
        ],
        form.children.map((c) => [c.inCustody ? "X" : "", c.receivesAllowance ? "X" : "", c.firstName, c.idNumber, dmy(c.birthDate)]),
        2
    );

    // ד
    L.title("ד. פרטים על הכנסותיי ממעסיק זה");
    L.row([
        { label: "אני מקבל/ת", checks: Object.entries(INCOME_LABELS).map(([k, label]) => ({ label, checked: form.employerIncome.type === k })), w: 0.8 },
        { label: "תאריך תחילת העבודה בשנת המס", value: dmy(form.employerIncome.startDate), w: 0.2 },
    ]);

    // ה
    const o = form.otherIncome;
    L.title("ה. פרטים על הכנסות אחרות");
    L.checkLine(!o.hasOther, "אין לי הכנסות אחרות ממשכורת (משכורת חודש, בעד משרה נוספת, משכורת חלקית, שכר עבודה), מקצבה וממלגה");
    L.checkLine(o.hasOther, `יש לי הכנסות אחרות כמפורט להלן: ${o.hasOther ? o.types.map((t) => INCOME_LABELS[t]).join(", ") : ""}`);
    L.checkLine(o.creditPoints === "here", "אבקש לקבל נקודות זיכוי ומדרגות מס כנגד הכנסתי זו (סעיף ד). איני מקבל/ת אותן בהכנסה אחרת", { indent: 14 });
    L.checkLine(o.creditPoints === "elsewhere", "אני מקבל/ת נקודות זיכוי ומדרגות מס בהכנסה אחרת ועל כן איני זכאי/ת להן כנגד הכנסה זו", { indent: 14 });
    L.checkLine(o.noStudyFund, "אין מפרישים עבורי לקרן השתלמות בגין הכנסתי האחרת, או שכל הפרשות המעסיק לקרן השתלמות בגין הכנסתי האחרת מצורפות להכנסתי האחרת", { indent: 14 });
    L.checkLine(o.noPension, "אין מפרישים עבורי לקצבה/לביטוח אובדן כושר עבודה/פיצויים בגין הכנסתי האחרת, או שכל הפרשות המעסיק לקצבה/לביטוח אובדן כושר עבודה/פיצויים בגין הכנסתי האחרת מצורפות להכנסתי האחרת", { indent: 14 });

    // ו
    const s = form.spouse;
    L.title("ו. פרטים על בן/בת הזוג");
    L.row([
        { label: "מספר זהות (9 ספרות)", value: s?.idNumber || "", w: 0.2 },
        { label: "דרכון זר / מדינה", value: passportText(s), w: 0.16 },
        { label: "שם משפחה", value: s?.lastName || "", w: 0.18 },
        { label: "שם פרטי", value: s?.firstName || "", w: 0.16 },
        { label: "תאריך לידה", value: dmy(s?.birthDate), w: 0.15 },
        { label: "תאריך עליה", value: dmy(s?.aliyahDate), w: 0.15 },
    ]);
    L.row([
        {
            label: "הכנסת בן/בת הזוג",
            checks: [
                { label: "אין לבן/בת הזוג כל הכנסה", checked: !!s && !s.hasIncome },
                { label: "יש לבן/בת הזוג הכנסה מ:", checked: !!s?.hasIncome },
                { label: "עבודה/קצבה/עסק", checked: !!s?.incomeTypes?.includes("work") },
                { label: "הכנסה אחרת", checked: !!s?.incomeTypes?.includes("other") },
            ],
            w: 1,
        },
    ]);

    // ז
    L.title("ז. שינויים במהלך השנה");
    L.table(
        [
            { label: "תאריך השינוי", w: 0.2 },
            { label: "פרטי השינוי", w: 0.8 },
        ],
        form.changes.map((c) => [dmy(c.date), c.details]),
        1
    );

    // ח
    const t = form.taxCredits;
    const counts = (groups, keys) => keys.map((k) => `${AGE_GROUP_LABELS[k]}: ${groups ? groups[k] : "___"}`).join(" | ");
    L.title("ח. אני מבקש/ת פטור או זיכוי ממס מהסיבות הבאות");
    L.checkLine(t.israeliResident, "אני תושב/ת ישראל.", { num: "1" });
    L.checkLine(t.disabled, "אני נכה 100% / עיוור/ת לצמיתות. מצורף אישור משרד הביטחון/האוצר/פקיד השומה/תעודת עיוור שהוצאה לאחר 1.1.94.", { num: "2א" });
    L.checkLine(t.disabilityAllowance, "בנוסף, אני מקבל/ת תגמול חודשי לפי חוק הנכים (תגמולים ושיקום) או לפי חוק התגמולים לנפגעי פעולות איבה. מצורף אישור על קבלת תגמול זה.", { num: "2ב" });
    L.checkLine(!!t.qualifyingSettlement, `אני תושב/ת קבוע/ה בישוב מזכה מתאריך ${blank(dmy(t.qualifyingSettlement?.fromDate))}. אני ובני משפחתי מדרגה ראשונה מתגוררים ביישוב ${blank(t.qualifyingSettlement?.settlement)} ואין לי "מרכז חיים" נוסף. מצורף אישור הרשות ע"ג טופס 1312א.`, { num: "3" });
    L.checkLine(!!t.newImmigrant, `אני עולה חדש/ה מתאריך ${blank(dmy(t.newImmigrant?.fromDate))}. לא היתה לי הכנסה בישראל מתחילת שנת המס הנוכחית עד תאריך ${blank(dmy(t.newImmigrant?.noIncomeUntil))}. מצורפת תעודת עולה.`, { num: "4" });
    L.checkLine(t.spouseNoIncome, "בגין בן/בת זוגי המתגורר/ת עימי ואין לו/לה הכנסות בשנת המס.", { num: "5" });
    L.checkLine(t.singleParentFamily, "אני הורה במשפחה חד הורית החי בנפרד.", { num: "6" });
    L.checkLine(!!t.childrenInCustody, `בגין ילדיי שבחזקתי המפורטים בחלק ג. מספר ילדים: ${counts(t.childrenInCustody, ["bornThisYear", "age1to2", "age3", "age4to5", "age6to17", "age18"])}`, { num: "7" });
    L.checkLine(!!t.childrenNotInCustody, `בגין ילדיי המפורטים בחלק ג. מספר ילדים: ${counts(t.childrenNotInCustody, ["bornThisYear", "age1to2", "age3", "age4to5", "age6to17"])}`, { num: "8" });
    L.checkLine(t.singleParent, "אני הורה יחיד לילדיי שבחזקתי (המפורטים בחלק ג ובהתאם לסעיף 7 ו-8 לעיל).", { num: "9" });
    L.checkLine(t.supportsChildren, "בגין ילדיי שאינם בחזקתי המפורטים בחלק ג ואני משתתף/ת בכלכלתם.", { num: "10" });
    L.checkLine(!!t.disabledChildren, `אני הורה ל-${blank(t.disabledChildren?.count)} ילדים עם מוגבלות שטרם מלאו להם 19 שנים, בגינם אני מקבל/ת גמלת ילד נכה מהמוסד לביטוח לאומי. מצורף אישור.`, { num: "11" });
    L.checkLine(t.alimony, "בגין מזונות לבן/בת זוגי לשעבר. מצורף פסק דין.", { num: "12" });
    L.checkLine(t.age16to18, "מלאו לי או לבן/בת זוגי 16 שנים וטרם מלאו לי או לבן/בת זוגי 18 שנים בשנת המס.", { num: "13" });
    L.checkLine(!!t.dischargedSoldier, `אני חייל/ת משוחרר/ת / שירתתי בשירות לאומי. תאריך תחילת השירות ${blank(dmy(t.dischargedSoldier?.serviceStart))} תאריך סיום השירות ${blank(dmy(t.dischargedSoldier?.serviceEnd))}. מצורף צילום תעודת שחרור.`, { num: "14" });
    L.checkLine(t.academicDegree, "בגין סיום לימודים לתואר אקדמי, סיום התמחות או סיום לימודי מקצוע. מצורפת הצהרה בטופס 119.", { num: "15" });
    L.checkLine(!!t.reserveCombat, `שירתתי כלוחם/לוחמת מילואים סה"כ ${blank(t.reserveCombat?.days)} ימי מילואים בשנת המס הקודמת. מצורף אישור מצה"ל.`, { num: "16" });

    // ט
    const c = form.taxCoordination;
    L.title("ט. אני מבקש/ת תיאום מס מהסיבות הבאות");
    L.checkLine(c.reason === "noIncomeSinceYearStart", "לא היתה לי הכנסה מתחילת שנת המס הנוכחית עד לתחילת עבודתי אצל מעסיק זה.", { num: "1" });
    L.checkLine(c.reason === "additionalIncome", "יש לי הכנסות נוספות ממשכורת כמפורט להלן:", { num: "2" });
    L.checkLine(c.reason === "assessorApproved", "פקיד השומה אישר תיאום לפי אישור מצורף.", { num: "3" });
    L.table(
        [
            { label: "שם המעסיק/משלם", w: 0.22 },
            { label: "כתובת", w: 0.22 },
            { label: "מספר תיק ניכויים", w: 0.15 },
            { label: "סוג ההכנסה", w: 0.15 },
            { label: "הכנסה חודשית", w: 0.13 },
            { label: "המס שנוכה", w: 0.13 },
        ],
        c.incomes.map((r) => [r.employerName, r.address, r.deductionFileNumber, r.incomeType, String(r.monthlyIncome ?? ""), String(r.taxDeducted ?? "")]),
        1
    );
    if (form.referToAssessor) {
        L.paragraph("לא סומן בחלק ה כי \"אין לי הכנסות אחרות\" - העובד יופנה לפקיד השומה לעריכת תיאום מס.", { size: 8, color: COLORS.label });
    }

    // י
    L.title("י. הצהרה");
    L.paragraph("אני מצהיר/ה כי הפרטים שמסרתי בטופס זה הינם מלאים ונכונים. ידוע לי שהשמטה או מסירת פרטים לא נכונים הינה עבירה על פקודת מס הכנסה. אני מתחייב/ת להודיע למעסיק על כל שינוי שיחול בפרטיי האישיים ובפרטים דלעיל תוך שבוע ימים מתאריך השינוי.", { font: L.bold, size: 8.5 });
    L.ensure(70);
    const top = L.y - 6;
    L.text("תאריך", L.right - 4, top - 8, { size: 7, color: COLORS.label });
    L.text(signedAt, L.right - 4, top - 24, { size: 10, color: COLORS.value });
    L.text("חתימת המבקש/ת", L.right - 200, top - 8, { size: 7, color: COLORS.label });
    if (signatureImage) {
        const dims = signatureImage.scaleToFit(160, 45);
        L.page.drawImage(signatureImage, { x: L.right - 200 - dims.width, y: top - 14 - dims.height, width: dims.width, height: dims.height });
    }
    L.page.drawLine({ start: { x: L.right - 380, y: top - 62 }, end: { x: L.right - 200, y: top - 62 }, thickness: 0.5, color: COLORS.line });
    L.y = top - 68;
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

    const L = new Layout(pdf, fonts, `טופס 101 | ${form.taxYear} | ת.ז. ${form.employee.idNumber || form.employee.passportNumber}`);
    drawForm(L, form, employer, signatureImage, files.signedAt);
    L.drawFooters();

    await appendDocuments(pdf, fonts, [
        ...(files.idCard || []).map((f, i) => ({ ...f, data: f.data, mimetype: f.mimetype, label: i === 0 ? "צילום תעודת זהות" : "ספח תעודת זהות" })),
        ...(files.creditDocs || []).map((f) => ({ data: f.data, mimetype: f.mimetype, label: f.label })),
        ...(files.attachments || []).map((f, i) => ({ data: f.data, mimetype: f.mimetype, label: `מסמך מצורף ${i + 1}` })),
    ]);

    return Buffer.from(await pdf.save());
};

module.exports = { buildForm101Pdf, segments, Form101PdfNotReady, Form101AttachmentError };
