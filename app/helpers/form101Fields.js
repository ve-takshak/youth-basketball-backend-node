// Form 101 (טופס 101) ke saare fields + validation. Coach mobile app se JSON bhejta hai,
// yahan check + saaf hota hai, phir PDF banta hai. Kuch bhi DB mein save NAHI hota.
//
// Sections (official form ke hisaab se):
//   א employer        -> coach nahi bharta, club record se aata hai (taxId, deductionFileNumber, phone...)
//   ב employee        -> coach ki details
//   ג children        -> 19 saal se chhote bachche (custody / child allowance checkbox)
//   ד employerIncome  -> is club se income ka type + start date
//   ה otherIncome     -> aur kahin se income? types, credit points kahan, contributions
//   ו spouse          -> sirf married ho toh
//   ז changes         -> saal ke beech badlav (optional)
//   ח taxCredits      -> credit point / exemption ke reasons 1-16
//   ט taxCoordination -> tax coordination (tiyum mas)
//   י declaration     -> "details sahi hain" + signature (file alag aati hai)
//
// Income types (ד aur ה dono mein same):
const INCOME_TYPES = ["monthly", "additional", "partial", "daily", "allowance", "scholarship"];
// monthly = משכורת חודש, additional = משכורת בעד משרה נוספת, partial = משכורת חלקית,
// daily = שכר עבודה (עובד יומי), allowance = קצבה, scholarship = מלגה

const GENDERS = ["male", "female"];
const MARITAL_STATUSES = ["single", "married", "divorced", "widowed", "separated"];
const KIBBUTZ_OPTIONS = ["no", "transferred", "notTransferred"]; // purana string format (ab object: { member, incomeTransferred })
const IDENTIFY_BY = ["id", "passport"]; // ID number ya foreign passport (passport -> country + number)
const HEALTH_FUNDS = ["clalit", "maccabi", "meuhedet", "leumit"];
const CREDIT_POINTS_OPTIONS = ["here", "elsewhere"]; // ה: credit points isi income pe / dusri income pe
const SPOUSE_INCOME_TYPES = ["work", "other"]; // עבודה/קצבה/עסק , הכנסה אחרת
const COORDINATION_REASONS = ["", "noIncomeSinceYearStart", "additionalIncome", "assessorApproved"];
// Bachchon ki umar ke group (ח 7 aur 8)
const CHILD_AGE_GROUPS = ["bornThisYear", "age1to2", "age3", "age4to5", "age6to17", "age18"];

class Form101Error extends Error {}
const fail = (message) => {
    throw new Form101Error(message);
};

// ---------- chhote helpers ----------
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

const str = (value, label, { required = false, max = 100 } = {}) => {
    const out = value === undefined || value === null ? "" : String(value).trim();
    if (required && !out) fail(`${label} is required.`);
    if (out.length > max) fail(`${label} must be ${max} characters or fewer.`);
    return out;
};

const bool = (value) => [true, "true", "1", 1, "on", "yes"].includes(value);

const oneOf = (value, list, label, { required = false } = {}) => {
    const out = value === undefined || value === null ? "" : String(value).trim();
    if (!out) {
        if (required) fail(`${label} is required.`);
        return "";
    }
    if (!list.includes(out)) fail(`${label} must be one of: ${list.filter(Boolean).join(", ")}.`);
    return out;
};

// "YYYY-MM-DD"
const date = (value, label, { required = false, notFuture = false } = {}) => {
    const out = value === undefined || value === null ? "" : String(value).trim();
    if (!out) {
        if (required) fail(`${label} is required.`);
        return "";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out)) fail(`${label} must be a date in YYYY-MM-DD format.`);
    const d = new Date(`${out}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== out) fail(`${label} is not a valid date.`);
    if (notFuture && d.getTime() > Date.now()) fail(`${label} cannot be in the future.`);
    return out;
};

const count = (value, label, max = 20) => {
    if (value === undefined || value === null || value === "") return 0;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > max) fail(`${label} must be a whole number from 0 to ${max}.`);
    return n;
};

const digits = (value, label, { required = false, min = 1, max = 15 } = {}) => {
    const out = value === undefined || value === null ? "" : String(value).replace(/[\s-]/g, "");
    if (!out) {
        if (required) fail(`${label} is required.`);
        return "";
    }
    if (!new RegExp(`^\\d{${min},${max}}$`).test(out)) fail(`${label} must be ${min === max ? min : `${min} to ${max}`} digits.`);
    return out;
};

const money = (value, label) => {
    if (value === undefined || value === null || value === "") return "";
    const n = Number(String(value).replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 10000000) fail(`${label} must be a valid amount.`);
    return n;
};

const email = (value, label, { required = false } = {}) => {
    const out = str(value, label, { required, max: 150 }).toLowerCase();
    if (out && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out)) fail(`${label} is not a valid email.`);
    return out;
};

const phone = (value, label, { required = false } = {}) => {
    const out = value === undefined || value === null ? "" : String(value).replace(/[\s()-]/g, "");
    if (!out) {
        if (required) fail(`${label} is required.`);
        return "";
    }
    if (!/^\+?\d{9,15}$/.test(out)) fail(`${label} must be 9 to 15 digits.`);
    return out;
};

// Israeli ID (teudat zehut) check digit. 9 digits tak padding, phir 1-2-1-2 weights.
const isValidIsraeliId = (id) => {
    const value = String(id || "").trim();
    if (!/^\d{5,9}$/.test(value)) return false;
    const padded = value.padStart(9, "0");
    const sum = [...padded].reduce((acc, ch, i) => {
        let n = Number(ch) * ((i % 2) + 1);
        if (n > 9) n -= 9;
        return acc + n;
    }, 0);
    return sum % 10 === 0;
};

const israeliId = (value, label, { required = false } = {}) => {
    const out = value === undefined || value === null ? "" : String(value).replace(/[\s-]/g, "");
    if (!out) {
        if (required) fail(`${label} is required.`);
        return "";
    }
    if (!isValidIsraeliId(out)) fail(`${label} is not a valid Israeli ID number.`);
    return out.padStart(9, "0");
};

// "Identify by": ID number ya foreign passport. Passport -> country + passport number dono zaroori.
// identifyBy na bheja ho toh: idNumber hai = "id", warna "passport".
const idOrPassport = (src, label) => {
    const identifyBy = oneOf(src.identifyBy || (src.idNumber ? "id" : src.passportNumber ? "passport" : ""), IDENTIFY_BY, `${label} identify by`, { required: true });
    if (identifyBy === "id") {
        return { identifyBy, idNumber: israeliId(src.idNumber, `${label} ID number`, { required: true }), passportNumber: "", passportCountry: "" };
    }
    return {
        identifyBy,
        idNumber: "",
        passportNumber: str(src.passportNumber, `${label} passport number`, { required: true, max: 20 }),
        passportCountry: str(src.passportCountry, `${label} passport country`, { required: true, max: 50 }),
    };
};

// Kibbutz / moshav: { member: true, incomeTransferred: true|false }. Purana string ("no"/"transferred"/"notTransferred") bhi chalta hai.
const parseKibbutz = (value) => {
    if (typeof value === "string") {
        const old = oneOf(value || "no", KIBBUTZ_OPTIONS, "Kibbutz / cooperative moshav member");
        return { member: old !== "no", incomeTransferred: old === "transferred" };
    }
    const k = isObj(value) ? value : {};
    if (k.member === undefined) fail("Kibbutz / cooperative moshav member (yes / no) is required.");
    const member = bool(k.member);
    if (!member) return { member: false, incomeTransferred: false };
    if (k.incomeTransferred === undefined) fail("Please answer whether your income from this employer is transferred to the kibbutz.");
    return { member: true, incomeTransferred: bool(k.incomeTransferred) };
};

// ---------- sections ----------

// Health fund: key (clalit...) ya Hebrew naam (כללית...) dono chalte hain
const HEALTH_FUND_HEBREW = { כללית: "clalit", מכבי: "maccabi", מאוחדת: "meuhedet", לאומית: "leumit" };
const healthFundKey = (value) => {
    const v = String(value || "").trim();
    return HEALTH_FUND_HEBREW[v] || v.toLowerCase();
};

const contactOf = (src) => {
    const out = { phone: phone(src.phone, "Phone"), mobile: phone(src.mobile, "Mobile number") };
    if (!out.phone && !out.mobile) fail("Please enter a mobile number or a phone number.");
    return out;
};

// ב. פרטי העובד/ת
const parseEmployee = (src) => {
    if (!isObj(src)) fail("Employee details are required.");
    const address = isObj(src.address) ? src.address : {};
    const healthFund = isObj(src.healthFund) ? src.healthFund : {};
    if (healthFund.member === undefined) fail("Health fund member (yes / no) is required.");
    const member = bool(healthFund.member);

    return {
        ...idOrPassport(src, "Employee"),
        lastName: str(src.lastName, "Last name", { required: true, max: 50 }),
        firstName: str(src.firstName, "First name", { required: true, max: 50 }),
        birthDate: date(src.birthDate, "Date of birth", { required: true, notFuture: true }),
        aliyahDate: date(src.aliyahDate, "Aliyah date", { notFuture: true }),
        address: {
            street: str(address.street, "Street", { required: true, max: 80 }),
            houseNumber: str(address.houseNumber, "House number", { required: true, max: 10 }),
            city: str(address.city, "City", { required: true, max: 50 }),
            zip: digits(address.zip, "Zip code", { min: 5, max: 7 }),
        },
        // Mobile ya phone, kam se kam ek (sirf landline ho toh mobile optional)
        ...contactOf(src),
        email: email(src.email, "Email", { required: true }),
        gender: oneOf(src.gender, GENDERS, "Gender", { required: true }),
        maritalStatus: oneOf(src.maritalStatus, MARITAL_STATUSES, "Marital status", { required: true }),
        israeliResident: src.israeliResident === undefined ? fail("Israeli resident (yes / no) is required.") : bool(src.israeliResident),
        kibbutz: parseKibbutz(src.kibbutz),
        healthFund: {
            member,
            name: member ? oneOf(healthFundKey(healthFund.name), HEALTH_FUNDS, "Health fund name", { required: true }) : "",
        },
    };
};

// ג. ילדים שבשנת המס טרם מלאו להם 19
const parseChildren = (list, taxYear) => {
    if (list === undefined || list === null || list === "") return [];
    if (!Array.isArray(list)) fail("Children must be a list.");
    if (list.length > 15) fail("A maximum of 15 children can be listed.");

    return list.map((c, i) => {
        const label = `Child ${i + 1}`;
        if (!isObj(c)) fail(`${label}: details are missing.`);
        const birthDate = date(c.birthDate, `${label} date of birth`, { required: true, notFuture: true });
        if (taxYear - Number(birthDate.slice(0, 4)) > 18) fail(`${label}: only children under 19 in the tax year are listed.`);
        return {
            firstName: str(c.firstName, `${label} first name`, { required: true, max: 50 }),
            idNumber: israeliId(c.idNumber, `${label} ID number`, { required: true }),
            birthDate,
            inCustody: bool(c.inCustody), // טור 1: הילד נמצא בחזקתי
            receivesAllowance: bool(c.receivesAllowance), // טור 2: מקבל/ת קצבת ילדים מב"ל
        };
    });
};

// ד. פרטים על הכנסותיי ממעסיק זה
const parseEmployerIncome = (src) => {
    if (!isObj(src)) fail("Income from this employer is required.");
    return {
        type: oneOf(src.type, INCOME_TYPES, "Income type from this employer", { required: true }),
        startDate: date(src.startDate, "Work start date in the tax year", { required: true }),
    };
};

// ה. פרטים על הכנסות אחרות
const parseOtherIncome = (src) => {
    if (!isObj(src) || src.hasOther === undefined) fail("Please answer whether you have other incomes.");
    const hasOther = bool(src.hasOther);
    if (!hasOther) return { hasOther: false, types: [], creditPoints: "", noStudyFund: false, noPension: false };

    const types = Array.isArray(src.types) ? [...new Set(src.types.map(String))] : [];
    if (!types.length) fail("Please select at least one type of other income.");
    types.forEach((t) => oneOf(t, INCOME_TYPES, "Other income type"));

    return {
        hasOther: true,
        types,
        creditPoints: oneOf(src.creditPoints, CREDIT_POINTS_OPTIONS, "Tax credits at other income", { required: true }),
        noStudyFund: bool(src.noStudyFund), // אין מפרישים לקרן השתלמות בגין הכנסתי האחרת...
        noPension: bool(src.noPension), // אין מפרישים לקצבה / אובדן כושר עבודה / פיצויים...
    };
};

const spouseIncomeTypes = (src) => {
    const list = Array.isArray(src.incomeTypes) ? src.incomeTypes : src.incomeType ? [src.incomeType] : [];
    const types = [...new Set(list.map((t) => oneOf(t, SPOUSE_INCOME_TYPES, "Spouse income type")))].filter(Boolean);
    if (!types.length) fail("Please select your spouse's income type.");
    return types;
};

// ו. פרטים על בן/בת הזוג (sirf married)
const parseSpouse = (src, maritalStatus) => {
    if (maritalStatus !== "married") return null;
    if (!isObj(src)) fail("Spouse details are required for married employees.");
    const hasIncome = src.hasIncome === undefined ? fail("Please answer whether your spouse has income.") : bool(src.hasIncome);

    return {
        ...idOrPassport(src, "Spouse"),
        lastName: str(src.lastName, "Spouse last name", { required: true, max: 50 }),
        firstName: str(src.firstName, "Spouse first name", { required: true, max: 50 }),
        birthDate: date(src.birthDate, "Spouse date of birth", { required: true, notFuture: true }),
        aliyahDate: date(src.aliyahDate, "Spouse aliyah date", { notFuture: true }),
        hasIncome,
        // Checkbox: dono ek saath ho sakte hain. Purana incomeType (string) bhi chalta hai.
        incomeTypes: hasIncome ? spouseIncomeTypes(src) : [],
    };
};

// ז. שינויים במהלך השנה (optional)
const parseChanges = (list) => {
    if (list === undefined || list === null || list === "") return [];
    if (!Array.isArray(list)) fail("Changes must be a list.");
    if (list.length > 3) fail("A maximum of 3 changes can be listed.");
    return list.map((c, i) => ({
        date: date(c?.date, `Change ${i + 1} date`, { required: true }),
        details: str(c?.details, `Change ${i + 1} details`, { required: true, max: 200 }),
    }));
};

const parseAgeGroups = (src, label) => {
    const groups = isObj(src) ? src : {};
    const out = {};
    CHILD_AGE_GROUPS.forEach((key) => {
        out[key] = count(groups[key], `${label} (${key})`);
    });
    if (!Object.values(out).some(Boolean)) fail(`${label}: please enter the number of children.`);
    return out;
};

// ח. פטור או זיכוי ממס. Har reason optional; tick kiya toh uske andar ke fields required.
const parseTaxCredits = (src = {}, { children = [], israeliResident = true } = {}) => {
    const t = isObj(src) ? src : {};
    const on = (key) => bool(isObj(t[key]) ? t[key].selected : t[key]);
    const sub = (key) => (isObj(t[key]) ? t[key] : {});

    const out = {
        israeliResident, // 1: section ב ke "Israeli resident" se apne aap
        disabled: on("disabled"), // 2א: נכה 100% / עיוור לצמיתות
        disabilityAllowance: on("disabilityAllowance"), // 2ב: תגמול חודשי (חוק הנכים / נפגעי איבה)
        qualifyingSettlement: null, // 3
        newImmigrant: null, // 4
        spouseNoIncome: on("spouseNoIncome"), // 5
        singleParentFamily: on("singleParentFamily"), // 6
        childrenInCustody: null, // 7
        childrenNotInCustody: null, // 8
        singleParent: on("singleParent"), // 9: הורה יחיד
        supportsChildren: on("supportsChildren"), // 10: ילדים שאינם בחזקתי, משתתף בכלכלתם
        disabledChildren: null, // 11
        alimony: on("alimony"), // 12: מזונות לבן/בת זוג לשעבר
        age16to18: on("age16to18"), // 13
        dischargedSoldier: null, // 14
        academicDegree: on("academicDegree"), // 15
        reserveCombat: null, // 16
    };

    if (out.disabilityAllowance && !out.disabled) fail("Tax credit 2b can only be selected together with 2a (100% disabled / blind).");

    if (on("qualifyingSettlement")) {
        const s = sub("qualifyingSettlement");
        out.qualifyingSettlement = {
            fromDate: date(s.fromDate, "Qualifying settlement: from date", { required: true }),
            settlement: str(s.settlement, "Qualifying settlement name", { required: true, max: 50 }),
        };
    }
    if (on("newImmigrant")) {
        const s = sub("newImmigrant");
        out.newImmigrant = {
            fromDate: date(s.fromDate, "New immigrant: from date", { required: true }),
            noIncomeUntil: date(s.noIncomeUntil, "New immigrant: no income until"),
        };
    }
    // 7 aur 8: section ג mein bachche hone chahiye. 8 = "jo 7 tick nahi karta", dono ek saath nahi.
    if (on("childrenInCustody") && on("childrenNotInCustody")) fail("Tax credits 7 and 8 cannot both be selected.");
    if (on("childrenInCustody")) {
        if (!children.some((c) => c.inCustody)) fail("Tax credit 7: list your children in your custody in section C first.");
        out.childrenInCustody = parseAgeGroups(sub("childrenInCustody"), "Tax credit 7");
    }
    if (on("childrenNotInCustody")) {
        if (!children.length) fail("Tax credit 8 cannot be selected because no children are listed in section C.");
        const groups = { ...sub("childrenNotInCustody") };
        delete groups.age18; // 8 mein 18 saal wala group nahi hota
        out.childrenNotInCustody = parseAgeGroups(groups, "Tax credit 8");
    }
    if (out.singleParent && !out.childrenInCustody && !out.childrenNotInCustody) {
        fail("Tax credit 9 (single parent) needs tax credit 7 or 8 to be selected.");
    }
    if (on("disabledChildren")) {
        const n = count(sub("disabledChildren").count, "Number of children with disabilities");
        if (!n) fail("Tax credit 11: please enter the number of children with disabilities.");
        out.disabledChildren = { count: n };
    }
    if (on("dischargedSoldier")) {
        const s = sub("dischargedSoldier");
        out.dischargedSoldier = {
            serviceStart: date(s.serviceStart, "Service start date", { required: true, notFuture: true }),
            serviceEnd: date(s.serviceEnd, "Service end date", { required: true, notFuture: true }),
        };
        if (out.dischargedSoldier.serviceEnd < out.dischargedSoldier.serviceStart) fail("Service end date must be after the start date.");
    }
    if (on("reserveCombat")) {
        const days = count(sub("reserveCombat").days, "Reserve duty days", 366);
        if (!days) fail("Tax credit 16: please enter the number of reserve duty days.");
        out.reserveCombat = { days };
    }

    return out;
};

// ט. תיאום מס
const parseTaxCoordination = (src) => {
    const t = isObj(src) ? src : {};
    const reason = oneOf(t.reason, COORDINATION_REASONS, "Tax coordination reason");
    let incomes = [];

    if (reason === "additionalIncome") {
        if (!Array.isArray(t.incomes) || !t.incomes.length) fail("Please list your additional salary incomes.");
        if (t.incomes.length > 3) fail("A maximum of 3 additional incomes can be listed.");
        incomes = t.incomes.map((row, i) => {
            const label = `Additional income ${i + 1}`;
            const r = isObj(row) ? row : {};
            return {
                employerName: str(r.employerName, `${label}: employer name`, { required: true, max: 80 }),
                address: str(r.address, `${label}: address`, { max: 120 }),
                deductionFileNumber: digits(r.deductionFileNumber, `${label}: deduction file number`, { min: 5, max: 15 }),
                incomeType: str(r.incomeType, `${label}: income type`, { required: true, max: 30 }),
                monthlyIncome: money(r.monthlyIncome, `${label}: monthly income`),
                taxDeducted: money(r.taxDeducted, `${label}: tax deducted`),
            };
        });
    }

    return { reason, incomes };
};

// ח: har reason ke documents. App har reason ki file alag field mein bhejta hai: doc_<key> (jaise doc_newImmigrant).
// required = reason tick ho toh file zaroori (form pe *). label = PDF mein us page ka title.
const CREDIT_DOCUMENTS = {
    disabled: { num: "2א", required: false, label: "אישור משרד הביטחון / האוצר / פקיד השומה / תעודת עיוור" },
    disabilityAllowance: { num: "2ב", required: false, label: "אישור על קבלת תגמול חודשי" },
    qualifyingSettlement: { num: "3", required: false, label: "אישור הרשות המקומית על גבי טופס 1312א" },
    newImmigrant: { num: "4", required: true, label: "תעודת עולה" },
    spouseNoIncome: { num: "5", required: false, label: "אישור נכות / עיוורון של העובד או בן/בת הזוג" },
    supportsChildren: { num: "10", required: false, label: "צילום פסק דין למזונות ילדים" },
    disabledChildren: { num: "11", required: true, label: "אישור גמלת ילד נכה מהמוסד לביטוח לאומי לשנת המס" },
    alimony: { num: "12", required: false, label: "צילום פסק דין למזונות" },
    dischargedSoldier: { num: "14", required: false, label: "צילום תעודת שחרור / סיום שירות לאומי" },
    academicDegree: { num: "15", required: false, label: "טופס 119 / אישור סיום לימודים" },
    reserveCombat: { num: "16", required: false, label: 'אישור מצה"ל על ימי שירות מילואים' },
};

/**
 * Pura form check karta hai. Galat ho toh Form101Error (message coach ko dikhane layak).
 * @returns saaf kiya hua form object (sirf PDF banane ke liye, save nahi hota)
 */
const parseForm101 = (body, taxYear) => {
    if (!isObj(body)) fail("Form data is missing.");

    const employee = parseEmployee(body.employee);
    const otherIncome = parseOtherIncome(body.otherIncome);
    const children = parseChildren(body.children, taxYear);

    if (!bool(body.declaration?.agreed)) fail("Please confirm the declaration (section J) before submitting.");

    return {
        taxYear,
        employee,
        children,
        employerIncome: parseEmployerIncome(body.employerIncome),
        otherIncome,
        spouse: parseSpouse(body.spouse, employee.maritalStatus),
        changes: parseChanges(body.changes),
        taxCredits: parseTaxCredits(body.taxCredits, { children, israeliResident: employee.israeliResident }),
        taxCoordination: parseTaxCoordination(body.taxCoordination),
        // Form par note: "other income" hai aur coordination nahi -> employee ko tax assessor ke paas bheja jayega
        referToAssessor: otherIncome.hasOther && !body.taxCoordination?.reason,
    };
};

module.exports = {
    parseForm101,
    CREDIT_DOCUMENTS,
    IDENTIFY_BY,
    HEALTH_FUNDS,
    isValidIsraeliId,
    Form101Error,
    INCOME_TYPES,
    GENDERS,
    MARITAL_STATUSES,
    KIBBUTZ_OPTIONS,
    CREDIT_POINTS_OPTIONS,
    SPOUSE_INCOME_TYPES,
    COORDINATION_REASONS,
    CHILD_AGE_GROUPS,
};
