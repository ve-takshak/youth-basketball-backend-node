const jwt = require("jsonwebtoken");
const Club = require("../../models/Club");
const Coach = require("../../models/Coach");
const ClubAdmin = require("../../models/ClubAdmin");
const Form101Submission = require("../../models/Form101Submission");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { parseForm101, Form101Error, CREDIT_DOCUMENTS } = require("../../helpers/form101Fields");
const { buildForm101Pdf, Form101PdfNotReady, Form101AttachmentError } = require("../../helpers/form101Pdf");
const { sendMail } = require("../../../utils/mailer");
const { savePdf, readPdf, deletePdf, Form101StorageError } = require("../../helpers/form101Storage");

// Form 101 (טופס 101) — coach mobile app se bharta hai.
//   GET  /user/coach/form101                   coach: apne club ka employer data (prefill) + is saal ka status
//   POST /user/coach/form101/submit            coach: form + signature + ID photo -> PDF -> email
//   GET  /user/form101?year=                   club admin: apne club ke coaches ka status
//   PUT  /user/form101/:id/review              club admin: approve / send back (reason)
//   GET  /user/form101/:id/pdf-link            club admin: 5 min ka download link (JSON)
//   GET  /form101/pdf/:token                   bina login: link wala download
//   GET  /user/clubs/:id/form101-settings      club admin
//   PUT  /user/clubs/:id/form101-settings      club admin: mandatory, accounting email, approval on/off
//   GET  /user/clubs/:id/form101-mandatory     club admin: mandatory on/off + is saal ka count
//   PUT  /user/clubs/:id/form101-mandatory     club admin: { mandatory: true|false }
//
// STORAGE: PDF club admin (+ accounting) ko email hoti hai, aur (client ke kehne pe) encrypted save hoti hai
// (GridFS, helpers/form101Storage.js). Har coach ka har saal sirf aakhri PDF. Download sirf club admin (super admin ko abhi Form 101 ka access nahi).
// Form ke fields (ID, bachche, income...) alag se DB mein nahi jaate, logs mein bhi nahi.

const TIME_ZONE = "Asia/Jerusalem";
const SIGNATURE_TYPES = ["image/png", "image/jpeg", "image/jpg"];
const DOC_TYPES = ["image/png", "image/jpeg", "image/jpg", "application/pdf"];
const MAX_ATTACHMENTS = 5;
const MAX_FILES_PER_REASON = 3;
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // saare documents milake (email size)

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

// Timeline: submitted -> returned (reason) -> submitted (dobara) -> approved ... (naya pehle)
const timelineOf = (sub) =>
    (sub?.history || [])
        .map((h) => ({ status: h.status, at: h.at, reason: h.status === "returned" ? h.reason || "" : "" }))
        .reverse();

// Club ki Form 101 settings: approval step on hai? form bharna zaroori hai? (mandatory default true)
const settingsOf = (club) => ({
    isApprovalRequired: !!club?.form101Settings?.requireApproval,
    isMandatory: club?.form101Settings?.mandatory !== false,
});
const settingsFor = async (clubId) => settingsOf(await Club.findById(clubId).select("form101Settings"));

/**
 * Status + seedhe true/false flags (app ko status string compare na karna pade):
 *   isSubmitted        form bhar diya (submitted ya approved). false = coach ko bharna hai (naya ya wapas aaya)
 *   isApproved         club admin ne approve kiya
 *   isReturned         wapas bheja gaya, coach theek karke dobara bhare (returnReason dekho)
 *   isApprovalRequired club ne approval step on kiya hai
 *   isMandatory        club ne Form 101 zaroori kiya hai (false = optional, "Action needed" card nahi)
 * admin = true (sirf web panel wali APIs): reviewedAt, resubmitted, lastReturnReason, submissions, hasPdf bhi
 */
const formatStatus = (sub, year, settings = {}, { admin = false } = {}) => {
    const status = sub?.status || "not_submitted";
    const out = {
        ...(sub ? { _id: sub._id } : {}),
        year: sub?.year || year,
        status,
        isSubmitted: status === "submitted" || status === "approved",
        isApproved: status === "approved",
        isReturned: status === "returned",
        isApprovalRequired: !!settings.isApprovalRequired,
        isMandatory: settings.isMandatory !== false,
        submittedAt: sub?.submittedAt || null,
        returnReason: status === "returned" ? sub.returnReason : "",
    };
    if (!admin) return out;

    const history = sub?.history || [];
    // Resubmitted = aakhri submit theek "returned" ke baad hua (sudhara hua form). Approve ke baad dobara bhara toh nahi.
    let lastSubmitIndex = -1;
    history.forEach((h, i) => {
        if (h.status === "submitted") lastSubmitIndex = i;
    });
    const fixedReturn = lastSubmitIndex > 0 && history[lastSubmitIndex - 1].status === "returned" ? history[lastSubmitIndex - 1] : null;
    return {
        ...out,
        reviewedAt: sub?.reviewedAt || null,
        resubmitted: !!fixedReturn && status !== "returned",
        lastReturnReason: status !== "returned" ? fixedReturn?.reason || "" : "",
        submissions: history.filter((h) => h.status === "submitted").length,
        hasPdf: !!sub?.pdf?.fileId, // download button: GET /user/form101/:id/pdf-link
    };
};

// "Form101_2026_coach_atul.pdf"
const pdfFilename = (year, fullName) => `Form101_${year}_${String(fullName || "coach").replace(/[^\p{L}\p{N}]+/gu, "_")}.pdf`;

// "data:image/png;base64,iVBOR..." (signature pad ka output) -> file jaisa object. Galat ho toh null.
const signatureFromBase64 = (value) => {
    const match = typeof value === "string" ? value.trim().match(/^data:(image\/(?:png|jpe?g));base64,([A-Za-z0-9+/=\s]+)$/) : null;
    if (!match) return null;
    const data = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    return data.length ? { data, mimetype: match[1] === "image/jpg" ? "image/jpeg" : match[1], name: "signature" } : null;
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
            Form101Submission.find({ coachId: coach._id }).sort({ year: -1 }).select("year status submittedAt"),
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
            status: formatStatus(current, year, settingsOf(club)),
            timeline: timelineOf(current), // is saal: kab bhara, kab wapas aaya (reason), kab dobara
            history: history.map((h) => ({ year: h.year, status: h.status, submittedAt: h.submittedAt })),
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
 *   signature   PNG / JPG file (signature pad se) YA text field: "data:image/png;base64,..."
 *   idCard      1-2 files: ID card + ספח (photo ya PDF)
 *   doc_<reason> section ח ke reason ki file(s), max 3 har reason: doc_disabled, doc_disabilityAllowance,
 *               doc_qualifyingSettlement, doc_newImmigrant (zaroori), doc_spouseNoIncome, doc_supportsChildren,
 *               doc_disabledChildren (zaroori), doc_alimony, doc_dischargedSoldier, doc_academicDegree, doc_reserveCombat
 *   doc_taxCoordination  section ט: assessor approval (reason assessorApproved pe zaroori) / salary slips
 *   attachments 0-5 files: koi aur document
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
        // Signature pad ki image: file (signature) YA base64 text (signature = "data:image/png;base64,...")
        if (filesOf(req, "signature").length > 1) return sendError(res, 400, "Only one signature is allowed.");
        const signature = filesOf(req, "signature")[0] || signatureFromBase64(req.body?.signature ?? body?.signature);
        if (!signature) return sendError(res, 400, "Signature is required.");
        if (!SIGNATURE_TYPES.includes(signature.mimetype)) return sendError(res, 400, "Signature must be a PNG or JPG image.");
        if (signature.data.length > MAX_SIGNATURE_BYTES) return sendError(res, 400, "Signature image is too large.");

        const idCard = filesOf(req, "idCard");
        if (!idCard.length) return sendError(res, 400, "Please attach a photo of your ID card including the appendix (ספח).");
        if (idCard.length > 2) return sendError(res, 400, "Please attach at most 2 ID card files (card + appendix).");

        const attachments = filesOf(req, "attachments");
        if (attachments.length > MAX_ATTACHMENTS) return sendError(res, 400, `Please attach at most ${MAX_ATTACHMENTS} documents.`);

        // ח: har reason ki file alag field mein (doc_newImmigrant, doc_disabledChildren ...)
        const creditDocs = [];
        for (const [key, info] of Object.entries(CREDIT_DOCUMENTS)) {
            const files = filesOf(req, `doc_${key}`);
            const selected = !!form.taxCredits[key];
            if (files.length && !selected) return sendError(res, 400, `A document was attached for tax credit ${info.num}, but that reason is not selected.`);
            if (selected && info.required && !files.length) return sendError(res, 400, `Tax credit ${info.num}: please attach the required document.`);
            if (files.length > MAX_FILES_PER_REASON) return sendError(res, 400, `Tax credit ${info.num}: please attach at most ${MAX_FILES_PER_REASON} files.`);
            files.forEach((f, i) => creditDocs.push({ ...f, label: `חלק ח סעיף ${info.num}: ${info.label}${files.length > 1 ? ` (${i + 1})` : ""}` }));
        }
        // ט: tax coordination ka document (assessor approval = zaroori, additional income = salary slips optional)
        const coordinationFiles = filesOf(req, "doc_taxCoordination");
        const coordReason = form.taxCoordination.reason;
        if (coordinationFiles.length && !coordReason) return sendError(res, 400, "A tax coordination document was attached, but no tax coordination reason is selected.");
        if (coordReason === "assessorApproved" && !coordinationFiles.length) return sendError(res, 400, "Please attach the tax assessor's approval for tax coordination.");
        if (coordinationFiles.length > MAX_FILES_PER_REASON) return sendError(res, 400, `Tax coordination: please attach at most ${MAX_FILES_PER_REASON} files.`);
        const coordLabel = coordReason === "assessorApproved" ? "אישור פקיד השומה לתיאום מס" : "תלושי שכר מהכנסות נוספות";
        coordinationFiles.forEach((f, i) => creditDocs.push({ ...f, label: `חלק ט: ${coordLabel}${coordinationFiles.length > 1 ? ` (${i + 1})` : ""}` }));

        const unknownDoc = Object.keys(req.files || {}).find((k) => k.startsWith("doc_") && k !== "doc_taxCoordination" && !CREDIT_DOCUMENTS[k.slice(4)]);
        if (unknownDoc) return sendError(res, 400, `Unknown document field "${unknownDoc}".`);

        const allDocs = [...idCard, ...creditDocs, ...attachments];
        if (allDocs.some((f) => !DOC_TYPES.includes(f.mimetype))) {
            return sendError(res, 400, "Documents must be PNG, JPG or PDF files.");
        }
        // Email mein jaata hai, isliye kul size limit (har file 5MB alag se, express-fileupload)
        if (allDocs.reduce((sum, f) => sum + (f.size || f.data?.length || 0), 0) > MAX_TOTAL_BYTES) {
            return sendError(res, 400, "The attached files are too large in total (maximum 20MB). Please use smaller photos.");
        }

        // ---- PDF (memory) ----
        const signedAt = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
        let pdf;
        try {
            pdf = await buildForm101Pdf(form, employer, { signature, idCard, creditDocs, attachments, signedAt });
        } catch (e) {
            if (e instanceof Form101AttachmentError) return sendError(res, 400, e.message);
            if (e instanceof Form101PdfNotReady) return sendError(res, 503, "Form 101 is not available yet. Please try again later.");
            throw e;
        }

        // Pehle wapas bheja gaya tha? Toh email mein "resubmitted" likho
        const previous = await Form101Submission.findOne({ coachId: coach._id, year });
        const isResubmit = previous?.status === "returned";

        // ---- PDF save (encrypted). Email fail hua toh wapas delete ----
        const fullName = `${form.employee.firstName} ${form.employee.lastName}`.trim();
        const filename = pdfFilename(year, fullName);
        const pdfSize = pdf.length;
        let fileId;
        try {
            fileId = await savePdf(pdf, { filename, coachId: coach._id, clubId: club._id, year });
        } catch (e) {
            console.error("Form 101 PDF save failed:", e?.message || e);
            if (e instanceof Form101StorageError) return sendError(res, 503, "Form 101 cannot be saved right now. Please contact support.");
            throw e;
        }

        // ---- email ----
        let mail;
        try {
            mail = await sendMail({
                to: recipients,
                subject: `Form 101 ${year} - ${fullName}${isResubmit ? " (resubmitted)" : ""}`,
                text:
                    `Coach ${fullName} has ${isResubmit ? "resubmitted" : "submitted"} Form 101 for ${year}.\n` +
                    (isResubmit && previous.returnReason ? `It was sent back earlier with this reason: ${previous.returnReason}\n` : "") +
                    `The completed form is attached. Club admins can also download it from the club's Form 101 page.` +
                    (form.referToAssessor ? `\n\nNote: the employee reported other income without tax coordination.` : ""),
                attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
            });
        } catch (e) {
            console.error("Form 101 email failed:", e?.message || e);
            await deletePdf(fileId);
            return sendError(res, 502, "We could not send your form. Please try again.");
        } finally {
            pdf = null;
        }

        // ---- status + PDF reference (purani PDF delete) ----
        const now = new Date();
        const sub = previous || new Form101Submission({ coachId: coach._id, clubId: club._id, year });
        const oldFileId = sub.pdf?.fileId;
        sub.pdf = { fileId, filename, size: pdfSize, createdAt: now };
        sub.clubId = club._id;
        sub.status = "submitted";
        sub.submittedAt = now;
        sub.reviewedAt = null;
        sub.reviewedBy = null;
        sub.returnReason = "";
        sub.history.push({ status: "submitted", at: now, by: req.user._id });
        try {
            await sub.save();
        } catch (e) {
            await deletePdf(fileId);
            throw e;
        }
        if (oldFileId && String(oldFileId) !== String(fileId)) await deletePdf(oldFileId);

        return sendOk(res, "Form 101 submitted.", {
            status: formatStatus(sub, year, settingsOf(club)),
            sentTo: recipients.length,
            requiresApproval: !!club.form101Settings?.requireApproval,
            ...(mail?.skipped ? { emailSkipped: true } : {}),
        });
    } catch (e) {
        return sendServerError(res, "submitMyForm101", e);
    }
};

/**
 * GET /user/form101?year=2026&status=   (club admin: apna club)
 * Club ke saare coaches + unka is saal ka status (jinka record nahi = not_submitted).
 */
const listForm101Status = async (req, res) => {
    try {
        const clubId = req.clubId;
        if (!isValidId(clubId)) return sendError(res, 400, "Please choose a valid club.");

        const year = Number(req.query.year) || currentTaxYear();
        if (year < 2000 || year > 2100) return sendError(res, 400, "Invalid year.");

        const [coaches, subs, settings] = await Promise.all([
            Coach.find({ clubId }).populate("userId", "firstname lastname profile_image"),
            Form101Submission.find({ clubId, year }),
            settingsFor(clubId),
        ]);
        const subByCoach = new Map(subs.map((s) => [String(s.coachId), s]));

        let list = coaches.map((c) => {
            const sub = subByCoach.get(String(c._id));
            return {
                coachId: c._id,
                firstname: c.userId?.firstname || "",
                lastname: c.userId?.lastname || "",
                profile_image: c.userId?.profile_image || "",
                ...formatStatus(sub, year, settings, { admin: true }),
                timeline: timelineOf(sub),
            };
        });

        if (req.query.status) list = list.filter((row) => row.status === req.query.status);

        const summary = { total: coaches.length, not_submitted: 0, submitted: 0, approved: 0, returned: 0 };
        coaches.forEach((c) => {
            summary[subByCoach.get(String(c._id))?.status || "not_submitted"] += 1;
        });

        return sendOk(res, "Form 101 status fetched.", { year, ...settings, summary, list });
    } catch (e) {
        return sendServerError(res, "listForm101Status", e);
    }
};

/**
 * PUT /user/form101/:id/review   (club admin: apne club ka)
 * body: { action: "approve" | "return", reason? }   return pe reason zaroori (coach ko dikhta hai)
 */
const reviewForm101 = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid submission id.");

        const sub = await Form101Submission.findById(id);
        if (!sub || String(sub.clubId) !== String(req.clubId)) {
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

        return sendOk(res, action === "approve" ? "Form 101 approved." : "Form 101 sent back to the coach.", { status: formatStatus(sub, sub.year, await settingsFor(sub.clubId), { admin: true }) });
    } catch (e) {
        return sendServerError(res, "reviewForm101", e);
    }
};

// Club admin (apna club) ke liye submission + PDF check. Galat ho toh { status, message }.
const findPdfSubmission = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid submission id." };
    const sub = await Form101Submission.findById(id).select("clubId pdf year");
    if (!sub || String(sub.clubId) !== String(req.clubId)) {
        return { status: 404, message: "Submission not found." };
    }
    if (!sub.pdf?.fileId) return { status: 404, message: "No saved PDF for this form (it was submitted before PDFs were saved)." };
    return { sub };
};

// PDF bhejna (decrypt karke). Direct download aur link wala download dono yahi use karte hain.
const sendPdf = async (res, sub) => {
    let pdf;
    try {
        pdf = await readPdf(sub.pdf.fileId);
    } catch (e) {
        console.error("Form 101 PDF read failed:", e?.message || e);
        return sendError(res, 410, "The saved PDF could not be opened. Please ask the coach to submit the form again.");
    }

    const filename = sub.pdf.filename || `Form101_${sub.year}.pdf`;
    const ascii = filename.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdf.length);
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).end(pdf);
};

// ---------- download link (5 minute) ----------
// Link mein ek chhota JWT hota hai (sirf ye submission + ye PDF file, 5 min). Link khulne pe token nahi chahiye,
// isliye frontend / app seedha window.open / <a href> kar sakta hai. Coach dobara submit kare toh purana link band.
const LINK_MINUTES = 5;
const LINK_TYPE = "form101-pdf";

// Backend ka public address: API_PUBLIC_URL (.env) warna request se (proxy ke peeche x-forwarded-proto)
const apiBaseOf = (req) => {
    const fromEnv = String(process.env.API_PUBLIC_URL || "").replace(/\/+$/, "");
    if (fromEnv) return fromEnv;
    const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
    return `${proto}://${req.get("host")}`;
};

/**
 * GET /user/form101/:id/pdf-link   (club admin: apne club ka). Coach ko nahi.
 * Response: { url, filename, expiresAt }. url 5 minute tak chalta hai, bina token ke PDF download.
 */
const getForm101PdfLink = async (req, res) => {
    try {
        const { sub, status, message } = await findPdfSubmission(req, req.params.id);
        if (!sub) return sendError(res, status, message);

        const token = jwt.sign({ type: LINK_TYPE, sid: String(sub._id), fid: String(sub.pdf.fileId), by: String(req.user._id) }, process.env.JWTKEY, {
            algorithm: "HS256",
            expiresIn: `${LINK_MINUTES}m`,
        });
        return sendOk(res, "Download link created.", {
            url: `${apiBaseOf(req)}/api/form101/pdf/${token}`,
            filename: sub.pdf.filename || `Form101_${sub.year}.pdf`,
            expiresAt: new Date(Date.now() + LINK_MINUTES * 60 * 1000),
        });
    } catch (e) {
        return sendServerError(res, "getForm101PdfLink", e);
    }
};

/**
 * GET /form101/pdf/:token   (bina login, link hi permission hai). /pdf-link se mila url.
 */
const downloadForm101PdfByLink = async (req, res) => {
    try {
        let payload;
        try {
            payload = jwt.verify(req.params.token, process.env.JWTKEY, { algorithms: ["HS256"] });
        } catch (e) {
            return sendError(res, e.name === "TokenExpiredError" ? 410 : 400, e.name === "TokenExpiredError" ? "This download link has expired. Please download again." : "Invalid download link.");
        }
        if (payload.type !== LINK_TYPE || !isValidId(payload.sid)) return sendError(res, 400, "Invalid download link.");

        const sub = await Form101Submission.findById(payload.sid).select("clubId pdf year");
        // Coach ne dobara bhar diya (nayi PDF) toh purana link kaam nahi karega
        if (!sub?.pdf?.fileId || String(sub.pdf.fileId) !== payload.fid) {
            return sendError(res, 410, "This form has been updated. Please download again.");
        }
        return await sendPdf(res, sub);
    } catch (e) {
        return sendServerError(res, "downloadForm101PdfByLink", e);
    }
};

/**
 * GET /user/coaches/:id/form101   (club admin: apne club ka coach)
 * Ek coach ka is saal ka status + timeline + pichhle saalon ka record. Form ka data nahi (wo save hi nahi hota).
 */
const getCoachForm101 = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid coach id.");
        const coach = await Coach.findById(id).select("clubId");
        if (!coach || String(coach.clubId) !== String(req.clubId)) {
            return sendError(res, 404, "Coach not found.");
        }

        const year = currentTaxYear();
        const [subs, settings] = await Promise.all([
            Form101Submission.find({ coachId: coach._id }).sort({ year: -1 }),
            settingsFor(coach.clubId),
        ]);
        const current = subs.find((s) => s.year === year);

        return sendOk(res, "Form 101 status fetched.", {
            taxYear: year,
            ...settings,
            status: formatStatus(current, year, settings, { admin: true }),
            timeline: timelineOf(current),
            years: subs.map((s) => ({ ...formatStatus(s, s.year, settings, { admin: true }), timeline: timelineOf(s) })),
        });
    } catch (e) {
        return sendServerError(res, "getCoachForm101", e);
    }
};

const findClub = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid club id." };
    if (String(req.clubId) !== String(id)) return { status: 404, message: "Club not found." };
    const club = await Club.findById(id);
    if (!club) return { status: 404, message: "Club not found." };
    return { club };
};

const formatSettings = (club) => ({
    mandatory: club.form101Settings?.mandatory !== false,
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
 * body: { mandatory?: boolean, accountingEmail?: "payroll@..." ("" = band), requireApproval?: boolean }
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
        if (body.mandatory !== undefined) settings.mandatory = [true, "true", "1", 1].includes(body.mandatory);

        club.form101Settings = settings;
        await club.save();
        return sendOk(res, "Form 101 settings saved.", formatSettings(club));
    } catch (e) {
        return sendServerError(res, "updateForm101Settings", e);
    }
};

// Mandatory ka response: setting + is saal kitne coaches ne bhara (club admin ko ek nazar mein dikhe)
const mandatoryStatusOf = async (club) => {
    const year = currentTaxYear();
    const [totalCoaches, submittedCoaches] = await Promise.all([
        Coach.countDocuments({ clubId: club._id }),
        Form101Submission.countDocuments({ clubId: club._id, year, status: { $in: ["submitted", "approved"] } }),
    ]);
    return {
        clubId: club._id,
        mandatory: club.form101Settings?.mandatory !== false,
        year,
        totalCoaches,
        submittedCoaches,
        pendingCoaches: Math.max(totalCoaches - submittedCoaches, 0),
    };
};

/**
 * GET /user/clubs/:id/form101-mandatory   (club admin: apna club)
 * Form 101 coaches ke liye zaroori hai ya nahi + is saal ka count.
 */
const getForm101Mandatory = async (req, res) => {
    try {
        const { club, status, message } = await findClub(req, req.params.id);
        if (!club) return sendError(res, status, message);
        return sendOk(res, "Form 101 mandatory status fetched.", await mandatoryStatusOf(club));
    } catch (e) {
        return sendServerError(res, "getForm101Mandatory", e);
    }
};

/**
 * PUT /user/clubs/:id/form101-mandatory   (club admin: apna club)
 * body: { mandatory: true | false }   true = har coach ko "Action needed" card, false = optional
 */
const updateForm101Mandatory = async (req, res) => {
    try {
        const { club, status, message } = await findClub(req, req.params.id);
        if (!club) return sendError(res, status, message);

        const value = req.body?.mandatory;
        if (![true, false, "true", "false"].includes(value)) return sendError(res, 400, "mandatory must be true or false.");
        const mandatory = value === true || value === "true";

        club.form101Settings = { ...(club.form101Settings?.toObject?.() || club.form101Settings || {}), mandatory };
        await club.save();
        return sendOk(res, mandatory ? "Form 101 is now mandatory for coaches." : "Form 101 is now optional for coaches.", await mandatoryStatusOf(club));
    } catch (e) {
        return sendServerError(res, "updateForm101Mandatory", e);
    }
};

module.exports = {
    getMyForm101,
    submitMyForm101,
    listForm101Status,
    reviewForm101,
    getCoachForm101,
    getForm101PdfLink,
    downloadForm101PdfByLink,
    getForm101Settings,
    updateForm101Settings,
    getForm101Mandatory,
    updateForm101Mandatory,
    currentTaxYear,
};
