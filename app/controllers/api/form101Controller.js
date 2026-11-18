const Club = require("../../models/Club");
const Coach = require("../../models/Coach");
const ClubAdmin = require("../../models/ClubAdmin");
const Form101Submission = require("../../models/Form101Submission");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { parseForm101, Form101Error } = require("../../helpers/form101Fields");
const { buildForm101Pdf, Form101PdfNotReady, Form101AttachmentError } = require("../../helpers/form101Pdf");
const { sendMail } = require("../../../utils/mailer");

// Form 101 (טופס 101) — coach mobile app se bharta hai.
//   GET  /user/coach/form101                   coach: apne club ka employer data (prefill) + is saal ka status
//   POST /user/coach/form101/submit            coach: form + signature + ID photo -> PDF -> email
//   GET  /user/form101?year=&clubId=           club admin / super admin: coaches ka status
//   PUT  /user/form101/:id/review              club admin / super admin: approve / send back (reason)
//   GET  /user/clubs/:id/form101-settings      club admin / super admin
//   PUT  /user/clubs/:id/form101-settings      club admin / super admin: accounting email, approval on/off
//
// PRIVACY: bhara hua form KABHI save nahi hota (na DB, na S3, na disk, na logs).
// PDF memory mein banta hai -> club admin (+ accounting) ko email -> khatam. DB mein sirf status + history.

const TIME_ZONE = "Asia/Jerusalem";
const SIGNATURE_TYPES = ["image/png", "image/jpeg", "image/jpg"];
const DOC_TYPES = ["image/png", "image/jpeg", "image/jpg", "application/pdf"];
const MAX_ATTACHMENTS = 5;

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

const sendOk = (res, message, data = {}) => res.status(200).json({ error: false, status: 200, message, message_desc: message, data });

// Error log mein sirf message (stack mein form data nahi hota, par req.body kabhi log nahi karte)
const sendServerError = (res, label, e) => {
    console.error(`${label} error:`, e?.message || e);
    return res.status(500).json({ error: true, status: 500, message: "Something went wrong.", message_desc: "Something went wrong.", data: {} });
};

// Israel ka current tax year
const currentTaxYear = () => Number(new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric" }).format(new Date()));

// Section א: employer details, hamesha coach ke APNE club se (body se kabhi nahi)
const employerOf = (club) => ({
    name: club.legalName || club.name || "",
    address: club.officialAddress || "",
    phone: club.phone || "",
    taxId: club.taxId || "",
    deductionFileNumber: club.deductionFileNumber || "",
});

const missingEmployerFields = (employer) => {
    const labels = { name: "legal name", address: "official address", deductionFileNumber: "deduction file number (תיק ניכויים)" };
    return Object.keys(labels).filter((k) => !employer[k]).map((k) => labels[k]);
};

// Kis kis ko email jayega: club ke saare club admins (jinka email hai) + accounting (agar set hai)
const recipientsOf = async (club) => {
    const admins = await ClubAdmin.find({ clubId: club._id }).populate("userId", "email");
    const emails = admins.map((a) => a.userId?.email).filter(Boolean);
    const accounting = club.form101Settings?.accountingEmail;
    if (accounting) emails.push(accounting);
    return [...new Set(emails.map((e) => e.toLowerCase()))];
};

const formatStatus = (sub, year) => {
    if (!sub) return { year, status: "not_submitted", actionNeeded: true, submittedAt: null, reviewedAt: null, returnReason: "" };
    return {
        _id: sub._id,
        year: sub.year,
        status: sub.status,
        actionNeeded: sub.status === "returned",
        submittedAt: sub.submittedAt,
        reviewedAt: sub.reviewedAt,
        returnReason: sub.status === "returned" ? sub.returnReason : "",
    };
};

// express-fileupload: ek ya zyada files -> array
const filesOf = (req, key) => {
    const f = req.files?.[key];
    if (!f) return [];
    return Array.isArray(f) ? f : [f];
};

const coachOf = async (req) => {
    if (req.user.role !== ROLES.COACH) return { status: 403, message: "Only coaches can fill Form 101." };
    const coach = await Coach.findOne({ userId: req.user._id });
    if (!coach) return { status: 404, message: "Coach profile not found." };
    const club = await Club.findById(coach.clubId);
    if (!club) return { status: 404, message: "Club not found." };
    return { coach, club };
};

/**
 * GET /user/coach/form101   (coach)
 * Employer details sirf coach ke apne club se. employee = profile se suggestion (app form mein pehle se bhar de).
 */
const getMyForm101 = async (req, res) => {
    try {
        const { coach, club, status, message } = await coachOf(req);
        if (!coach) return sendError(res, status, message);

        const year = currentTaxYear();
        const [current, history] = await Promise.all([
            Form101Submission.findOne({ coachId: coach._id, year }),
            Form101Submission.find({ coachId: coach._id }).sort({ year: -1 }).select("year status submittedAt reviewedAt"),
        ]);

        const employer = employerOf(club);
        const missing = missingEmployerFields(employer);

        return sendOk(res, "Form 101 fetched.", {
            taxYear: year,
            employer,
            employerReady: !missing.length,
            employerMissing: missing,
            employee: {
                firstName: req.user.firstname || "",
                lastName: req.user.lastname || "",
                mobile: req.user.mobileNumber || "",
                email: req.user.email || "",
                birthDate: req.user.birthDate ? new Date(req.user.birthDate).toISOString().slice(0, 10) : "",
            },
            status: formatStatus(current, year),
            history: history.map((h) => ({ year: h.year, status: h.status, submittedAt: h.submittedAt, reviewedAt: h.reviewedAt })),
        });
    } catch (e) {
        return sendServerError(res, "getMyForm101", e);
    }
};

/**
 * POST /user/coach/form101/submit   (coach)
 * multipart/form-data:
 *   data        JSON string: { employee, children, employerIncome, otherIncome, spouse, changes,
 *                              taxCredits, taxCoordination, declaration: { agreed: true } }
 *   signature   PNG / JPG (signature pad se)
 *   idCard      1-2 files: ID card + ספח (photo ya PDF)
 *   attachments 0-5 files: reason ke hisaab se documents (discharge certificate, form 119...)
 * Kuch save nahi hota. Email fail = status nahi badalta, coach dobara bheje.
 */
const submitMyForm101 = async (req, res) => {
    try {
        const { coach, club, status, message } = await coachOf(req);
        if (!coach) return sendError(res, status, message);

        const year = currentTaxYear();
        const employer = employerOf(club);
        const missing = missingEmployerFields(employer);
        if (missing.length) {
            return sendError(res, 409, `Your club has not completed its employer details (${missing.join(", ")}). Please contact your club admin.`);
        }

        const recipients = await recipientsOf(club);
        if (!recipients.length) return sendError(res, 409, "Your club admin has no email address set. Please contact your club admin.");

        // ---- form data ----
        let body = req.body?.data ?? req.body;
        if (typeof body === "string") {
            try {
                body = JSON.parse(body);
            } catch (e) {
                return sendError(res, 400, "Form data is not valid JSON.");
            }
        }

        let form;
        try {
            form = parseForm101(body, year);
        } catch (e) {
            if (e instanceof Form101Error) return sendError(res, 400, e.message);
            throw e;
        }

        // ---- files (sirf memory mein) ----
        const [signature] = filesOf(req, "signature");
        if (!signature) return sendError(res, 400, "Signature is required.");
        if (filesOf(req, "signature").length > 1) return sendError(res, 400, "Only one signature is allowed.");
        if (!SIGNATURE_TYPES.includes(signature.mimetype)) return sendError(res, 400, "Signature must be a PNG or JPG image.");

        const idCard = filesOf(req, "idCard");
        if (!idCard.length) return sendError(res, 400, "Please attach a photo of your ID card including the appendix (ספח).");
        if (idCard.length > 2) return sendError(res, 400, "Please attach at most 2 ID card files (card + appendix).");

        const attachments = filesOf(req, "attachments");
        if (attachments.length > MAX_ATTACHMENTS) return sendError(res, 400, `Please attach at most ${MAX_ATTACHMENTS} documents.`);
        if ([...idCard, ...attachments].some((f) => !DOC_TYPES.includes(f.mimetype))) {
            return sendError(res, 400, "Documents must be PNG, JPG or PDF files.");
        }

        // ---- PDF (memory) ----
        const signedAt = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
        let pdf;
        try {
            pdf = await buildForm101Pdf(form, employer, { signature, idCard, attachments, signedAt });
        } catch (e) {
            if (e instanceof Form101AttachmentError) return sendError(res, 400, e.message);
            if (e instanceof Form101PdfNotReady) return sendError(res, 503, "Form 101 is not available yet. Please try again later.");
            throw e;
        }

        // ---- email ----
        const fullName = `${form.employee.firstName} ${form.employee.lastName}`.trim();
        let mail;
        try {
            mail = await sendMail({
                to: recipients,
                subject: `Form 101 ${year} - ${fullName}`,
                text:
                    `Coach ${fullName} has submitted Form 101 for ${year}.\n` +
                    `The completed form is attached. Courtside does not keep a copy of this form.` +
                    (form.referToAssessor ? `\n\nNote: the employee reported other income without tax coordination.` : ""),
                attachments: [{ filename: `Form101_${year}_${fullName.replace(/[^\p{L}\p{N}]+/gu, "_")}.pdf`, content: pdf, contentType: "application/pdf" }],
            });
        } catch (e) {
            console.error("Form 101 email failed:", e?.message || e);
            return sendError(res, 502, "We could not send your form. Please try again.");
        } finally {
            pdf = null;
        }

        // ---- sirf status ----
        const now = new Date();
        const sub = (await Form101Submission.findOne({ coachId: coach._id, year })) || new Form101Submission({ coachId: coach._id, clubId: club._id, year });
        sub.clubId = club._id;
        sub.status = "submitted";
        sub.submittedAt = now;
        sub.reviewedAt = null;
        sub.reviewedBy = null;
        sub.returnReason = "";
        sub.history.push({ status: "submitted", at: now, by: req.user._id });
        await sub.save();

        return sendOk(res, "Form 101 submitted.", {
            status: formatStatus(sub, year),
            sentTo: recipients.length,
            requiresApproval: !!club.form101Settings?.requireApproval,
            ...(mail?.skipped ? { emailSkipped: true } : {}),
        });
    } catch (e) {
        return sendServerError(res, "submitMyForm101", e);
    }
};

/**
 * GET /user/form101?year=2026&status=&clubId=   (club admin: apna club, super admin: clubId zaroori)
 * Club ke saare coaches + unka is saal ka status (jinka record nahi = not_submitted).
 */
const listForm101Status = async (req, res) => {
    try {
        const clubId = req.user.role === ROLES.SUPER_ADMIN ? req.query.clubId : req.clubId;
        if (!isValidId(clubId)) return sendError(res, 400, "Please choose a valid club.");

        const year = Number(req.query.year) || currentTaxYear();
        if (year < 2000 || year > 2100) return sendError(res, 400, "Invalid year.");

        const [coaches, subs] = await Promise.all([
            Coach.find({ clubId }).populate("userId", "firstname lastname profile_image"),
            Form101Submission.find({ clubId, year }),
        ]);
        const subByCoach = new Map(subs.map((s) => [String(s.coachId), s]));

        let list = coaches.map((c) => ({
            coachId: c._id,
            firstname: c.userId?.firstname || "",
            lastname: c.userId?.lastname || "",
            profile_image: c.userId?.profile_image || "",
            ...formatStatus(subByCoach.get(String(c._id)), year),
        }));

        if (req.query.status) list = list.filter((row) => row.status === req.query.status);

        const summary = { total: coaches.length, not_submitted: 0, submitted: 0, approved: 0, returned: 0 };
        coaches.forEach((c) => {
            summary[subByCoach.get(String(c._id))?.status || "not_submitted"] += 1;
        });

        return sendOk(res, "Form 101 status fetched.", { year, summary, list });
    } catch (e) {
        return sendServerError(res, "listForm101Status", e);
    }
};

/**
 * PUT /user/form101/:id/review   (club admin / super admin)
 * body: { action: "approve" | "return", reason? }   return pe reason zaroori (coach ko dikhta hai)
 */
const reviewForm101 = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid submission id.");

        const sub = await Form101Submission.findById(id);
        if (!sub || (req.user.role !== ROLES.SUPER_ADMIN && String(sub.clubId) !== String(req.clubId))) {
            return sendError(res, 404, "Submission not found.");
        }

        const action = String(req.body?.action || "");
        const reason = String(req.body?.reason || "").trim();
        if (!["approve", "return"].includes(action)) return sendError(res, 400, 'Action must be "approve" or "return".');
        if (action === "return" && !reason) return sendError(res, 400, "Please write a reason so the coach knows what to fix.");
        if (reason.length > 500) return sendError(res, 400, "Reason must be 500 characters or fewer.");
        if (sub.status !== "submitted") return sendError(res, 409, `This form is already ${sub.status}.`);

        const now = new Date();
        sub.status = action === "approve" ? "approved" : "returned";
        sub.reviewedAt = now;
        sub.reviewedBy = req.user._id;
        sub.returnReason = action === "return" ? reason : "";
        sub.history.push({ status: sub.status, at: now, by: req.user._id, reason: sub.returnReason });
        await sub.save();

        return sendOk(res, action === "approve" ? "Form 101 approved." : "Form 101 sent back to the coach.", { status: formatStatus(sub, sub.year) });
    } catch (e) {
        return sendServerError(res, "reviewForm101", e);
    }
};

const findClub = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid club id." };
    if (req.user.role !== ROLES.SUPER_ADMIN && String(req.clubId) !== String(id)) return { status: 404, message: "Club not found." };
    const club = await Club.findById(id);
    if (!club) return { status: 404, message: "Club not found." };
    return { club };
};

const formatSettings = (club) => ({
    accountingEmail: club.form101Settings?.accountingEmail || "",
    requireApproval: !!club.form101Settings?.requireApproval,
    employer: employerOf(club),
    employerMissing: missingEmployerFields(employerOf(club)),
});

/** GET /user/clubs/:id/form101-settings */
const getForm101Settings = async (req, res) => {
    try {
        const { club, status, message } = await findClub(req, req.params.id);
        if (!club) return sendError(res, status, message);
        return sendOk(res, "Form 101 settings fetched.", formatSettings(club));
    } catch (e) {
        return sendServerError(res, "getForm101Settings", e);
    }
};

/**
 * PUT /user/clubs/:id/form101-settings
 * body: { accountingEmail?: "payroll@..." ("" = band), requireApproval?: boolean }
 */
const updateForm101Settings = async (req, res) => {
    try {
        const { club, status, message } = await findClub(req, req.params.id);
        if (!club) return sendError(res, status, message);

        const body = req.body || {};
        const settings = club.form101Settings || {};

        if (body.accountingEmail !== undefined) {
            const value = String(body.accountingEmail || "").trim().toLowerCase();
            if (value && (value.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
                return sendError(res, 400, "Accounting email is not valid.");
            }
            settings.accountingEmail = value;
        }
        if (body.requireApproval !== undefined) settings.requireApproval = [true, "true", "1", 1].includes(body.requireApproval);

        club.form101Settings = settings;
        await club.save();
        return sendOk(res, "Form 101 settings saved.", formatSettings(club));
    } catch (e) {
        return sendServerError(res, "updateForm101Settings", e);
    }
};

// Coach dashboard ke "action needed" card ke liye
const getCoachForm101Card = async (coachId) => {
    const year = currentTaxYear();
    const sub = await Form101Submission.findOne({ coachId, year });
    return formatStatus(sub, year);
};

module.exports = {
    getMyForm101,
    submitMyForm101,
    listForm101Status,
    reviewForm101,
    getForm101Settings,
    updateForm101Settings,
    getCoachForm101Card,
    currentTaxYear,
};
