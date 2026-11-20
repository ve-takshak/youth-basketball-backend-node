const jwt = require("jsonwebtoken");
const Club = require("../../models/Club");
const Coach = require("../../models/Coach");
const ClubAdmin = require("../../models/ClubAdmin");
const Form101Submission = require("../../models/Form101Submission");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { parseForm101, parseForm101Draft, Form101Error, CREDIT_DOCUMENTS } = require("../../helpers/form101Fields");
const { buildForm101Pdf, Form101PdfNotReady, Form101AttachmentError } = require("../../helpers/form101Pdf");
const { sendMail } = require("../../../utils/mailer");
const { savePdf, readPdf, deletePdf, Form101StorageError } = require("../../helpers/form101Storage");
const Form101Draft = require("../../models/Form101Draft");
const { DRAFT_DAYS, draftExpiry } = require("../../models/Form101Draft");
const { encrypt, decrypt } = require("../../helpers/secretBox");
const { saveDraftFile, readDraftFile, deleteDraftFiles, setDraftFilesExpiry } = require("../../helpers/form101DraftFiles");

// Form 101 (טופס 101) — coach mobile app se bharta hai.
//   GET  /user/coach/form101                   coach: club ka employer data (read-only) + profile prefill + status + saved data
//   PUT  /user/coach/form101/draft             coach: adhoora form save (7 din rehta hai)
//   GET  /user/coach/form101/preview-link      coach: apne saved form (draft / submitted) ka PDF preview, 5 min link
//   GET  /user/coaches/:id/form101/preview-link  club admin: coach ke saved form ka PDF preview, 5 min link
//   GET  /form101/preview/:token               bina login: preview link wala PDF (abhi ke saved data se banta hai)
//   DELETE /user/coach/form101/draft           coach: saved data hatao, shuru se bharo
//   GET  /user/coach/form101/saved             coach: reject hua form / adhoora form ka bhara data + documents + reason
//   GET  /form101/saved-file/:token            bina login: saved document ka 30 min link (coach ke liye)
//   POST /user/coach/form101/submit            coach: form + signature + ID photo -> PDF -> email
//   GET  /user/form101?year=                   club admin: apne club ke coaches ka status
//   GET  /user/form101/submitted?year=&status=&search=&page=&limit=  club admin: jinhone bhara, details ke saath
//   GET  /user/coaches/:id/form101/history     club admin: ek coach ki poori history (har saal, kisne kya kiya)
//   PUT  /user/form101/:id/review              club admin: approve / send back (reason)
//   GET  /user/form101/:id/pdf-link            club admin: 5 min ka download link (JSON)
//   GET  /form101/pdf/:token                   bina login: link wala download
//   GET  /user/clubs/:id/form101-settings      club admin
//   PUT  /user/clubs/:id/form101-settings      club admin: mandatory, accounting email, approval on/off
//   GET  /user/clubs/:id/form101-mandatory     club admin: mandatory on/off + is saal ka count
//   PUT  /user/clubs/:id/form101-mandatory     club admin: { mandatory: true|false }
//
// STORAGE: PDF club admin (+ accounting) aur coach (employee) ko email hoti hai, aur (client ke kehne pe) encrypted save hoti hai
// (GridFS, helpers/form101Storage.js). Har coach ka har saal sirf aakhri PDF. Download sirf club admin (super admin ko abhi Form 101 ka access nahi).
// Form ke fields (client ke kehne pe): models/Form101Draft mein ENCRYPTED, sirf 7 din (TTL), status kuch bhi ho (draft /
// submitted / returned / approved). Har save / submit / return / approve pe 7 din phir se.
// Coach ko wapas pre-fill ke liye. Logs mein kabhi nahi. Files (signature, ID, documents) save nahi hoti.

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

// Section א: employer details hamesha coach ke APNE club se (club admin / super admin bharte hain,
// GET/PUT /user/clubs/:id/legal-details). Coach ke liye read-only: app jo bheje wo ignore.
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

// Employer (club) ka email = club admin ka email (club ko Form 101 isi pe jaata hai). Club ki apni email field nahi hai.
const clubEmailOf = async (club) => {
    const admin = await ClubAdmin.findOne({ clubId: club._id }).sort({ createdAt: 1 }).populate("userId", "email");
    return admin?.userId?.email ? admin.userId.email.toLowerCase() : "";
};

// Coach ko dikhane wala employer (read-only): club ki legal details + club ka email
const employerForCoach = async (club) => ({ ...employerOf(club), email: await clubEmailOf(club) });

// Saved form mein employer hamesha club wala (coach badal nahi sakta, purana / app ka bheja hua ignore)
const withClubEmployer = (data, employer) => (data ? { ...data, employer } : data);

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

// ---------- Saved form data (draft) ----------
// Client: bhara hua data 7 din DB mein (encrypted), status kuch bhi ho. Signature kabhi save nahi.
const MAX_DRAFT_BYTES = 200 * 1024;

// App jo JSON bhejta hai wahi rakhte hain (adhoora bhi chalega), bas signature / base64 files hata ke
const cleanDraftData = (data) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const { signature, ...rest } = data;
    return rest;
};

// files bheje (submit) toh document list badlo, warna purani files rehti hain. Files ki expiry bhi draft ke saath.
const saveDraft = async ({ coach, year, data, source, files }) => {
    const now = new Date();
    const expiresAt = draftExpiry(now);
    const draft = await Form101Draft.findOneAndUpdate(
        { coachId: coach._id, year },
        { clubId: coach.clubId, data: encrypt(JSON.stringify(data)), source, savedAt: now, expiresAt, ...(files ? { files } : {}) },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await setDraftFilesExpiry(draft.files.map((f) => f.fileId), expiresAt);
    return draft;
};

// Return / approve pe: data + files 7 din aur
const extendDraft = async (coachId, year) => {
    const expiresAt = draftExpiry();
    const draft = await Form101Draft.findOneAndUpdate({ coachId, year }, { expiresAt }, { new: true });
    if (draft) await setDraftFilesExpiry(draft.files.map((f) => f.fileId), expiresAt);
};

// Coach ko wapas dene ke liye. Expire ho chuka (TTL thoda late chalta hai) ya decrypt na ho -> null
const draftOf = async (coachId, year) => {
    const draft = await Form101Draft.findOne({ coachId, year });
    if (!draft || draft.expiresAt <= new Date()) return null;
    try {
        return { data: JSON.parse(decrypt(draft.data)), source: draft.source, savedAt: draft.savedAt, expiresAt: draft.expiresAt, files: draft.files };
    } catch (e) {
        console.error("Form 101 draft decrypt failed:", e?.message || e);
        return null;
    }
};

// Data + saari saved files delete (approve / coach "shuru se")
const deleteDraft = async (coachId, year) => {
    const draft = await Form101Draft.findOneAndDelete({ coachId, year });
    if (draft?.files?.length) await deleteDraftFiles(draft.files.map((f) => f.fileId));
};

// ---------- Saved documents (signature nahi) ----------
const SAVED_FILE_LINK_TYPE = "form101-saved-file";
const SAVED_FILE_LINK_MINUTES = 30;
// Submit ke form-data keys jinki files save hoti hain (signature nahi)
const SAVED_FILE_FIELDS = () => ["idCard", ...Object.keys(CREDIT_DOCUMENTS).map((k) => `doc_${k}`), "doc_taxCoordination", "attachments"];

// App ke liye: har saved file + 30 min ka link (preview / download). keepFiles mein isi ka _id bhejo.
const savedFilesOf = (req, coachId, files = []) => {
    const base = apiBaseOf(req);
    const expiresAt = new Date(Date.now() + SAVED_FILE_LINK_MINUTES * 60 * 1000);
    return files.map((f) => ({
        _id: f.fileId,
        field: f.field, // idCard | doc_<reason> | doc_taxCoordination | attachments
        filename: f.filename,
        mimetype: f.mimetype,
        size: f.size,
        url: `${base}/api/form101/saved-file/${jwt.sign({ type: SAVED_FILE_LINK_TYPE, fid: String(f.fileId), cid: String(coachId) }, process.env.JWTKEY, { algorithm: "HS256", expiresIn: `${SAVED_FILE_LINK_MINUTES}m` })}`,
        urlExpiresAt: expiresAt,
    }));
};

// Draft ki file ko express-fileupload jaisa object (submit mein dobara use)
const keptFileOf = async (meta) => {
    const data = await readDraftFile(meta.fileId);
    return { name: meta.filename, data, size: data.length, mimetype: meta.mimetype, keptFileId: meta.fileId };
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
 * Employer details (א) sirf coach ke apne club se, READ-ONLY (club admin / super admin bharte hain).
 * employee = profile se suggestion (app form mein pehle se bhar de).
 */
const getMyForm101 = async (req, res) => {
    try {
        const { coach, club, status, message } = await coachOf(req);
        if (!coach) return sendError(res, status, message);

        const year = currentTaxYear();
        const [current, history, draft, employer] = await Promise.all([
            Form101Submission.findOne({ coachId: coach._id, year }),
            Form101Submission.find({ coachId: coach._id }).sort({ year: -1 }).select("year status submittedAt"),
            draftOf(coach._id, year),
            employerForCoach(club),
        ]);
        const missing = missingEmployerFields(employer);

        return sendOk(res, "Form 101 fetched.", {
            taxYear: year,
            employer, // read-only: { name, address, phone, taxId, deductionFileNumber, email (club admin) }
            employerReady: !missing.length, // false = club ne details nahi bhari, coach submit nahi kar sakta
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
            // Pehle bhara hua data (adhoora save ya wapas aaya form): app isse form pre-fill kare. null = khali form.
            // files = saved documents (link ke saath). Signature kabhi save nahi, har submit pe naya.
            savedForm: draft ? { ...draft, data: withClubEmployer(draft.data, employer), files: savedFilesOf(req, coach._id, draft.files) } : null,
        });
    } catch (e) {
        return sendServerError(res, "getMyForm101", e);
    }
};

// Draft mein har field ki max files (submit jaisa). Signature draft mein kabhi nahi.
const draftFieldLimit = (field) => (field === "idCard" ? 2 : field === "attachments" ? MAX_ATTACHMENTS : MAX_FILES_PER_REASON);

/**
 * PUT /user/coach/form101/draft   (coach)
 * Do tarike:
 *   JSON:       { data: { employee, children, ... } }          -> sirf fields, pehle se saved documents waise hi rehte hain
 *   form-data:  data (JSON string) + documents (submit wale keys: idCard, doc_<reason>, doc_taxCoordination, attachments)
 *               + keepFiles (JSON array, /saved ke files[]._id jo rakhne hain)
 *               -> documents ki list = keepFiles + nayi files. Jo na kept na naya, wo delete.
 * Adhoora form chalega (koi validation nahi, reason select ho ya na ho). Signature save nahi hota.
 * 7 din rehta hai (har save pe phir se 7 din).
 */
const saveMyForm101Draft = async (req, res) => {
    try {
        const { coach, status, message } = await coachOf(req);
        if (!coach) return sendError(res, status, message);

        let data = req.body?.data;
        if (typeof data === "string") {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return sendError(res, 400, "Form data is not valid JSON.");
            }
        }
        data = cleanDraftData(data);
        if (!data) return sendError(res, 400, "Please send the form data as an object in \"data\".");
        if (Buffer.byteLength(JSON.stringify(data)) > MAX_DRAFT_BYTES) return sendError(res, 400, "Form data is too large. Please send documents as files, not inside data.");

        const year = currentTaxYear();
        const fields = SAVED_FILE_FIELDS();

        // Documents bheje ya keepFiles bheja? Tabhi documents ki list badlo, warna purani list waisi hi.
        let keepIds = req.body?.keepFiles;
        if (typeof keepIds === "string") {
            try {
                keepIds = keepIds.trim() ? JSON.parse(keepIds) : [];
            } catch (e) {
                return sendError(res, 400, "keepFiles must be a JSON array of saved file ids.");
            }
        }
        if (keepIds !== undefined && keepIds !== null && !Array.isArray(keepIds)) return sendError(res, 400, "keepFiles must be a JSON array of saved file ids.");
        const unknown = Object.keys(req.files || {}).find((k) => !fields.includes(k));
        if (unknown) return sendError(res, 400, unknown === "signature" ? "The signature is not saved in a draft. Add it when you submit." : `Unknown document field "${unknown}".`);
        const uploads = fields.flatMap((field) => filesOf(req, field).map((file) => ({ field, file })));
        const touchFiles = uploads.length > 0 || Array.isArray(keepIds);

        if (!touchFiles) {
            const draft = await saveDraft({ coach, year, data, source: "draft" });
            return sendOk(res, "Form 101 saved.", { savedAt: draft.savedAt, expiresAt: draft.expiresAt, keepDays: DRAFT_DAYS, files: savedFilesOf(req, coach._id, draft.files) });
        }

        // keepFiles: sirf abhi saved files (purani / expire id chhod do)
        const existing = await Form101Draft.findOne({ coachId: coach._id, year }).select("files expiresAt");
        const usable = existing && existing.expiresAt > new Date() ? existing.files : [];
        const keepSet = new Set((keepIds || []).map(String));
        const kept = usable.filter((f) => keepSet.has(String(f.fileId)));

        // Checks: type, har field ki ginti, kul size
        if (uploads.some(({ file }) => !DOC_TYPES.includes(file.mimetype))) return sendError(res, 400, "Documents must be PNG, JPG or PDF files.");
        for (const field of fields) {
            const count = kept.filter((f) => f.field === field).length + uploads.filter((u) => u.field === field).length;
            if (count > draftFieldLimit(field)) return sendError(res, 400, `Too many files for "${field}" (maximum ${draftFieldLimit(field)}).`);
        }
        const totalBytes = kept.reduce((n, f) => n + (f.size || 0), 0) + uploads.reduce((n, { file }) => n + (file.size || file.data?.length || 0), 0);
        if (totalBytes > MAX_TOTAL_BYTES) return sendError(res, 400, "The documents are too large in total (maximum 20MB). Please use smaller photos.");

        // Nayi files save, phir list = kept + nayi. Fail hua toh nayi wapas delete.
        const expiresAt = draftExpiry();
        const newlySaved = [];
        let draft;
        try {
            for (const { field, file } of uploads) {
                const meta = await saveDraftFile(file, { field, coachId: coach._id, year, expiresAt });
                newlySaved.push(meta);
            }
            const files = [...kept.map((f) => ({ fileId: f.fileId, field: f.field, filename: f.filename, mimetype: f.mimetype, size: f.size })), ...newlySaved];
            draft = await saveDraft({ coach, year, data, source: "draft", files });
        } catch (e) {
            await deleteDraftFiles(newlySaved.map((f) => f.fileId));
            throw e;
        }
        const keepNow = new Set(draft.files.map((f) => String(f.fileId)));
        await deleteDraftFiles(usable.map((f) => f.fileId).filter((id) => !keepNow.has(String(id))));

        return sendOk(res, "Form 101 saved.", { savedAt: draft.savedAt, expiresAt: draft.expiresAt, keepDays: DRAFT_DAYS, files: savedFilesOf(req, coach._id, draft.files) });
    } catch (e) {
        return sendServerError(res, "saveMyForm101Draft", e);
    }
};

/**
 * GET /user/coach/form101/saved   (coach)
 * Form wapas aaya (rejected / returned) ya adhoora chhoda: coach ne jo bhara tha wo + reject ka reason.
 * App isse form pre-fill kare, coach sirf galat cheez theek karke dobara submit kare.
 *   hasSavedForm false = kuch save nahi (7 din nikal gaye / kabhi bhara nahi) -> khali form
 *   form = wahi JSON structure jo submit ke "data" mein jaata hai
 *   files = pichhle submit ke documents (ID card, ח / ט documents, attachments), har ek ka 30 min ka link.
 *           Resubmit pe jo rakhni hai unke _id "keepFiles" mein bhejo, dobara upload nahi karni.
 *   reupload = sirf signature (kabhi save nahi hota)
 */
const getMyForm101Saved = async (req, res) => {
    try {
        const { coach, club, status, message } = await coachOf(req);
        if (!coach) return sendError(res, status, message);

        const year = currentTaxYear();
        const [current, draft, employer] = await Promise.all([
            Form101Submission.findOne({ coachId: coach._id, year }),
            draftOf(coach._id, year),
            employerForCoach(club),
        ]);
        const st = formatStatus(current, year, settingsOf(club));

        return sendOk(res, draft ? "Saved Form 101 fetched." : "No saved Form 101 data.", {
            year,
            status: st.status, // not_submitted | submitted | approved | returned
            isReturned: st.isReturned,
            returnReason: st.returnReason, // club admin ne kya theek karne ko kaha
            returnedAt: st.isReturned ? current.reviewedAt : null,
            hasSavedForm: !!draft,
            source: draft?.source || null, // draft = adhoora save, submitted = pichhla bheja hua form
            savedAt: draft?.savedAt || null,
            expiresAt: draft?.expiresAt || null, // is date ke baad data delete, shuru se bharna hoga
            form: draft ? withClubEmployer(draft.data, employer) : null, // employer hamesha club wala (read-only)
            employer, // club ki details + email, form khali ho tab bhi (read-only)
            files: draft ? savedFilesOf(req, coach._id, draft.files) : [],
            reupload: ["signature"],
        });
    } catch (e) {
        return sendServerError(res, "getMyForm101Saved", e);
    }
};

/**
 * DELETE /user/coach/form101/draft   (coach)  saved data hatao, form shuru se.
 */
const deleteMyForm101Draft = async (req, res) => {
    try {
        const { coach, status, message } = await coachOf(req);
        if (!coach) return sendError(res, status, message);
        await deleteDraft(coach._id, currentTaxYear());
        return sendOk(res, "Saved Form 101 data deleted.");
    } catch (e) {
        return sendServerError(res, "deleteMyForm101Draft", e);
    }
};

/**
 * POST /user/coach/form101/submit   (coach)
 * multipart/form-data:
 *   data        JSON string: { employee, children, employerIncome, otherIncome, spouse, changes,
 *                              taxCredits, taxCoordination, declaration: { agreed: true } }
 *               employer (section א) app NAHI bhejta / bheje toh ignore: hamesha club ki legal details se.
 *   signature   PNG / JPG file (signature pad se) YA text field: "data:image/png;base64,..."
 *   idCard      1-2 files: ID card + ספח (photo ya PDF)
 *   doc_<reason> section ח ke reason ki file(s), max 3 har reason: doc_disabled, doc_disabilityAllowance,
 *               doc_qualifyingSettlement, doc_newImmigrant (zaroori), doc_spouseNoIncome, doc_supportsChildren,
 *               doc_disabledChildren (zaroori), doc_alimony, doc_dischargedSoldier, doc_academicDegree, doc_reserveCombat
 *   doc_taxCoordination  section ט: assessor approval (reason assessorApproved pe zaroori) / salary slips
 *   attachments 0-5 files: koi aur document
 *   keepFiles   (optional) JSON array: pichhle submit ki saved files ke _id (GET /user/coach/form101/saved -> files[]).
 *               Wo file apne purane field mein lagti hai, dobara upload nahi karni. Limits mein ginti hoti hai.
 *               Jo id ab saved nahi (purani / expire) wo chhod di jaati hai, response mein skippedKeepFiles.
 *               Document badla? Us purani file ki id keepFiles se hata do, nayi file us field mein bhejo.
 * Email fail = status nahi badalta, coach dobara bheje.
 * Success pe: PDF (encrypted) + status save, aur bhara hua data + documents (signature nahi) 7 din ke liye
 * (wapas aaye toh pre-fill / preview). Approve ke baad bhi 7 din. Email: club admin (+ accounting) aur coach dono ko.
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

        // ---- keepFiles: pichhle submit ki saved files dobara use (app ko phir upload nahi karni) ----
        // keepFiles = JSON array of _id (GET /user/coach/form101/saved -> files[]._id). File apne purane field mein lagti hai.
        let keepIds = req.body?.keepFiles;
        if (typeof keepIds === "string") {
            try {
                keepIds = keepIds.trim() ? JSON.parse(keepIds) : [];
            } catch (e) {
                return sendError(res, 400, "keepFiles must be a JSON array of saved file ids.");
            }
        }
        if (keepIds !== undefined && keepIds !== null && !Array.isArray(keepIds)) return sendError(res, 400, "keepFiles must be a JSON array of saved file ids.");
        keepIds = [...new Set((keepIds || []).map(String))];
        // Purani / expire / replace ho chuki id (app ke paas purana /saved tha) -> error nahi, chhod do.
        // Zaroori document (ID card, newImmigrant ...) na bache toh neeche wali normal check sahi message deti hai.
        const skippedKeepFiles = [];
        if (keepIds.length) {
            const saved = await Form101Draft.findOne({ coachId: coach._id, year });
            const usable = saved && saved.expiresAt > new Date() ? saved.files : [];
            req.files = req.files || {};
            for (const id of keepIds) {
                const meta = usable.find((f) => String(f.fileId) === id);
                if (!meta) {
                    skippedKeepFiles.push(id);
                    continue;
                }
                let kept;
                try {
                    kept = await keptFileOf(meta);
                } catch (e) {
                    console.error("Form 101 saved file read failed:", e?.message || e);
                    skippedKeepFiles.push(id);
                    continue;
                }
                req.files[meta.field] = [kept, ...filesOf(req, meta.field)];
            }
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
            pdf = null;
            return sendError(res, 502, "We could not send your form. Please try again.");
        }

        // ---- employee (coach) ko bhi copy. Alag email, taaki club admins ke email coach ko na dikhein. ----
        // Form ka email + account ka email (jo club admin list mein pehle se hai wo nahi). Fail hua toh bhi submit ho chuka, sirf log.
        const sent = new Set(recipients.map((e) => String(e).toLowerCase()));
        const employeeTo = [...new Set([form.employee.email, req.user.email].filter(Boolean).map((e) => String(e).trim().toLowerCase()))].filter((e) => !sent.has(e));
        let employeeEmailSent = false;
        if (employeeTo.length) {
            try {
                await sendMail({
                    to: employeeTo,
                    subject: `Your Form 101 ${year}${isResubmit ? " (resubmitted)" : ""} - ${club.legalName || club.name || "your club"}`,
                    text:
                        `Hi ${form.employee.firstName || fullName},\n\n` +
                        `Your Form 101 for ${year} has been ${isResubmit ? "resubmitted" : "submitted"} to ${club.legalName || club.name || "your club"}.\n` +
                        `A copy of the completed form is attached for your records.` +
                        (club.form101Settings?.requireApproval ? `\nYour club admin will review it. You will see the result in the app.` : ""),
                    attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
                });
                employeeEmailSent = true;
            } catch (e) {
                console.error("Form 101 employee email failed:", e?.message || e);
            }
        }
        pdf = null;

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

        // Bhara hua data + documents (signature nahi) 7 din rakho: club admin wapas bheje toh coach ko sirf galat
        // cheez theek karni ho. keepFiles wali files pehle se saved hain, sirf nayi upload save hoti hain.
        // Fail hua toh bhi submit ho chuka hai, isliye sirf log.
        const newlySaved = [];
        try {
            const expiresAt = draftExpiry();
            const files = [];
            for (const field of SAVED_FILE_FIELDS()) {
                for (const f of filesOf(req, field)) {
                    if (f.keptFileId) {
                        files.push({ fileId: f.keptFileId, field, filename: f.name, mimetype: f.mimetype, size: f.size });
                    } else {
                        const meta = await saveDraftFile(f, { field, coachId: coach._id, year, expiresAt });
                        newlySaved.push(meta.fileId);
                        files.push(meta);
                    }
                }
            }
            const old = await Form101Draft.findOne({ coachId: coach._id, year }).select("files");
            await saveDraft({ coach, year, data: cleanDraftData(body) || {}, source: "submitted", files });
            const keep = new Set(files.map((f) => String(f.fileId)));
            await deleteDraftFiles((old?.files || []).map((f) => f.fileId).filter((id) => !keep.has(String(id))));
        } catch (e) {
            console.error("Form 101 data save failed:", e?.message || e);
            await deleteDraftFiles(newlySaved);
        }

        return sendOk(res, "Form 101 submitted.", {
            status: formatStatus(sub, year, settingsOf(club)),
            sentTo: recipients.length, // club admins + accounting
            employeeEmailSent, // coach ko copy gayi (form / account ka email)
            requiresApproval: !!club.form101Settings?.requireApproval,
            ...(mail?.skipped ? { emailSkipped: true } : {}),
            // keepFiles ki jo id ab saved nahi thi (purani / expire), chhod di gayi. App apni list refresh kare.
            ...(skippedKeepFiles.length ? { skippedKeepFiles } : {}),
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

        const [coaches, subs, settings, saved] = await Promise.all([
            Coach.find({ clubId }).populate("userId", "firstname lastname profile_image"),
            Form101Submission.find({ clubId, year }),
            settingsFor(clubId),
            savedFormsOf(clubId, year),
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
                ...savedFormFields(saved.get(String(c._id))),
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
 * GET /user/form101/submitted?year=2026&status=&search=&page=1&limit=20   (club admin: apna club)
 * Sirf wo coaches jinhone is saal Form 101 bhara hai (submitted / approved / returned), naye submit pehle.
 * Har row: coach (naam, email, phone) + status + dates + reviewer + hasPdf. Timeline nahi (wo history API mein).
 * Form ke andar ka data nahi (wo save nahi hota, PDF mein hai).
 *   status  submitted | approved | returned (khali = teeno)
 *   search  coach ka naam / email / mobile
 */
const listSubmittedForm101 = async (req, res) => {
    try {
        const clubId = req.clubId;
        if (!isValidId(clubId)) return sendError(res, 400, "Please choose a valid club.");

        const year = Number(req.query.year) || currentTaxYear();
        if (year < 2000 || year > 2100) return sendError(res, 400, "Invalid year.");

        const status = String(req.query.status || "");
        if (status && !["submitted", "approved", "returned"].includes(status)) {
            return sendError(res, 400, 'Status must be "submitted", "approved" or "returned".');
        }
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const search = String(req.query.search || "").trim().toLowerCase().slice(0, 100);

        const [subs, settings, saved] = await Promise.all([
            Form101Submission.find({ clubId, year, ...(status ? { status } : {}) })
                .sort({ submittedAt: -1 })
                .populate({ path: "coachId", select: "userId", populate: { path: "userId", select: "firstname lastname email countryCode mobileNumber profile_image" } })
                .populate("reviewedBy", "firstname lastname"),
            settingsFor(clubId),
            savedFormsOf(clubId, year),
        ]);

        // Sirf zaroori fields. Poori timeline / history: GET /user/coaches/:coachId/form101/history
        let list = subs.map((sub) => {
            const user = sub.coachId?.userId;
            const reviewer = sub.reviewedBy;
            const { resubmitted } = formatStatus(sub, year, settings, { admin: true });
            return {
                _id: sub._id, // submission id: review + pdf-link isi se
                coachId: sub.coachId?._id || null,
                name: `${user?.firstname || ""} ${user?.lastname || ""}`.trim(),
                email: user?.email || "",
                phone: user?.mobileNumber ? `${user.countryCode || ""} ${user.mobileNumber}`.trim() : "",
                profile_image: user?.profile_image || "",
                status: sub.status, // submitted | approved | returned
                resubmitted,
                returnReason: sub.status === "returned" ? sub.returnReason : "",
                submittedAt: sub.submittedAt,
                reviewedAt: sub.reviewedAt || null,
                reviewedBy: reviewer ? `${reviewer.firstname || ""} ${reviewer.lastname || ""}`.trim() : "",
                hasPdf: !!sub.pdf?.fileId,
                ...savedFormFields(saved.get(String(sub.coachId?._id))),
            };
        });

        if (search) {
            list = list.filter((row) => [row.name, row.email, row.phone].some((v) => v.toLowerCase().includes(search)));
        }

        const summary = { total: subs.length, submitted: 0, approved: 0, returned: 0 };
        subs.forEach((s) => {
            summary[s.status] += 1;
        });
        const total = list.length;

        return sendOk(res, "Submitted Form 101 list fetched.", {
            year,
            summary,
            list: list.slice((page - 1) * limit, page * limit),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (e) {
        return sendServerError(res, "listSubmittedForm101", e);
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

        // Client rule (Nov 2026): status kuch bhi ho, bhara hua data 7 din rehta hai. Approve / wapas bheja -> 7 din aur,
        // phir apne aap delete (status row + PDF rehte hain).
        await extendDraft(sub.coachId, sub.year);

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
 * GET /form101/saved-file/:token   (bina login, link hi permission hai). /user/coach/form101/saved ke files[].url.
 * Coach ki apni saved document (ID card / documents). 30 min ka link. inline: app / browser preview kar sake.
 */
const downloadSavedForm101File = async (req, res) => {
    try {
        let payload;
        try {
            payload = jwt.verify(req.params.token, process.env.JWTKEY, { algorithms: ["HS256"] });
        } catch (e) {
            return sendError(res, e.name === "TokenExpiredError" ? 410 : 400, e.name === "TokenExpiredError" ? "This link has expired. Please open the form again." : "Invalid link.");
        }
        if (payload.type !== SAVED_FILE_LINK_TYPE || !isValidId(payload.fid) || !isValidId(payload.cid)) return sendError(res, 400, "Invalid link.");

        // File abhi bhi coach ke draft mein honi chahiye (approve / expire / naya submit ke baad nahi)
        const draft = await Form101Draft.findOne({ coachId: payload.cid, "files.fileId": payload.fid, expiresAt: { $gt: new Date() } }).select("files");
        const meta = draft?.files.find((f) => String(f.fileId) === payload.fid);
        if (!meta) return sendError(res, 410, "This document is no longer saved. Please upload it again.");

        const data = await readDraftFile(meta.fileId);
        const safeName = String(meta.filename || "document").replace(/[^\w.\-]+/g, "_");
        res.set({
            "Content-Type": meta.mimetype || "application/octet-stream",
            "Content-Length": data.length,
            "Content-Disposition": `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(meta.filename || "document")}`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        });
        return res.end(data);
    } catch (e) {
        return sendServerError(res, "downloadSavedForm101File", e);
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

// ---------- draft preview (saved data ka PDF, 5 min link) ----------
// Coach ne jo bhara hai (adhoora draft ya aakhri submit ka data) usi se PDF abhi banta hai. Kahin save nahi hota.
// Signature kabhi save nahi hota, isliye uski jagah khaali.
const PREVIEW_LINK_TYPE = "form101-preview";

// Saved data check (PDF nahi): kya preview ho sakta hai + kya kya abhi bharna baaki hai
const previewInfoOf = (draft, year) => {
    const { issues } = parseForm101Draft(draft.data, year);
    return { source: draft.source, savedAt: draft.savedAt, savedUntil: draft.expiresAt, missing: [...new Set(issues)] };
};

const previewLinkOf = (req, coachId, year) => {
    const token = jwt.sign({ type: PREVIEW_LINK_TYPE, cid: String(coachId), year, by: String(req.user._id) }, process.env.JWTKEY, {
        algorithm: "HS256",
        expiresIn: `${LINK_MINUTES}m`,
    });
    return { url: `${apiBaseOf(req)}/api/form101/preview/${token}`, expiresAt: new Date(Date.now() + LINK_MINUTES * 60 * 1000) };
};

// Draft ki saved files -> PDF ke documents (submit jaisa label). File na khule toh chhod do.
const previewDocumentsOf = async (files, form) => {
    const out = { idCard: [], creditDocs: [], attachments: [] };
    const coordLabel = form.taxCoordination.reason === "assessorApproved" ? "אישור פקיד השומה לתיאום מס" : "תלושי שכר מהכנסות נוספות";
    for (const meta of files || []) {
        let data;
        try {
            data = await readDraftFile(meta.fileId);
        } catch (e) {
            console.error("Form 101 preview file read failed:", e?.message || e);
            continue;
        }
        const file = { data, mimetype: meta.mimetype, name: meta.filename };
        if (meta.field === "idCard") out.idCard.push(file);
        else if (meta.field === "attachments") out.attachments.push(file);
        else if (meta.field === "doc_taxCoordination") out.creditDocs.push({ ...file, label: `חלק ט: ${coordLabel}` });
        else if (meta.field.startsWith("doc_") && CREDIT_DOCUMENTS[meta.field.slice(4)]) {
            const info = CREDIT_DOCUMENTS[meta.field.slice(4)];
            out.creditDocs.push({ ...file, label: `חלק ח סעיף ${info.num}: ${info.label}` });
        }
    }
    out.idCard = out.idCard.slice(0, 2);
    return out;
};

/**
 * GET /user/coach/form101/preview-link   (coach: apna form)
 * Saved form (adhoora draft ya bheja hua) ka PDF preview. Response:
 *   { url, expiresAt, filename, source: draft | submitted, savedAt, savedUntil, missing: ["Last name is required.", ...] }
 *   url 5 min, bina token khulta hai (browser mein dikhta hai). missing = submit se pehle kya bharna baaki.
 * Kuch saved nahi -> 404.
 */
const getMyForm101PreviewLink = async (req, res) => {
    try {
        const { coach, status, message } = await coachOf(req);
        if (!coach) return sendError(res, status, message);
        const year = currentTaxYear();
        const draft = await draftOf(coach._id, year);
        if (!draft) return sendError(res, 404, "No saved Form 101 to preview. Please fill and save the form first.");

        return sendOk(res, "Preview link created.", {
            ...previewLinkOf(req, coach._id, year),
            filename: pdfFilename(year, `${req.user.firstname || ""} ${req.user.lastname || ""}`.trim()).replace(/\.pdf$/, "_DRAFT.pdf"),
            ...previewInfoOf(draft, year),
        });
    } catch (e) {
        return sendServerError(res, "getMyForm101PreviewLink", e);
    }
};

/**
 * GET /user/coaches/:id/form101/preview-link?year=   (club admin: apne club ka coach)
 * Coach ka saved form (adhoora / bheja hua) PDF mein. Response coach wale jaisa. Kuch saved nahi -> 404.
 */
const getCoachForm101PreviewLink = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid coach id.");
        const coach = await Coach.findById(id).select("clubId userId").populate("userId", "firstname lastname");
        if (!coach || String(coach.clubId) !== String(req.clubId)) return sendError(res, 404, "Coach not found.");

        const year = Number(req.query.year) || currentTaxYear();
        if (year < 2000 || year > 2100) return sendError(res, 400, "Invalid year.");
        const draft = await draftOf(coach._id, year);
        if (!draft) return sendError(res, 404, "This coach has no saved Form 101 data to preview.");

        return sendOk(res, "Preview link created.", {
            ...previewLinkOf(req, coach._id, year),
            filename: pdfFilename(year, `${coach.userId?.firstname || ""} ${coach.userId?.lastname || ""}`.trim()).replace(/\.pdf$/, "_DRAFT.pdf"),
            ...previewInfoOf(draft, year),
        });
    } catch (e) {
        return sendServerError(res, "getCoachForm101PreviewLink", e);
    }
};

/**
 * GET /form101/preview/:token   (bina login, link hi permission hai). preview-link se mila url.
 * Har baar abhi ka saved data (link ke baad coach ne save kiya toh naya data dikhega). inline = browser mein khulta hai.
 */
const downloadForm101Preview = async (req, res) => {
    try {
        let payload;
        try {
            payload = jwt.verify(req.params.token, process.env.JWTKEY, { algorithms: ["HS256"] });
        } catch (e) {
            return sendError(res, e.name === "TokenExpiredError" ? 410 : 400, e.name === "TokenExpiredError" ? "This preview link has expired. Please open the preview again." : "Invalid preview link.");
        }
        if (payload.type !== PREVIEW_LINK_TYPE || !isValidId(payload.cid) || !Number.isInteger(payload.year)) return sendError(res, 400, "Invalid preview link.");

        const coach = await Coach.findById(payload.cid).select("clubId");
        const club = coach ? await Club.findById(coach.clubId) : null;
        if (!club) return sendError(res, 404, "Coach not found.");
        const draft = await draftOf(coach._id, payload.year);
        if (!draft) return sendError(res, 410, "This saved form is no longer available.");

        const { form } = parseForm101Draft(draft.data, payload.year);
        let pdf;
        try {
            pdf = await buildForm101Pdf(form, employerOf(club), { preview: true, ...(await previewDocumentsOf(draft.files, form)) });
        } catch (e) {
            if (e instanceof Form101AttachmentError) return sendError(res, 422, e.message);
            if (e instanceof Form101PdfNotReady) return sendError(res, 503, "Form 101 is not available yet. Please try again later.");
            throw e;
        }

        const fullName = `${form.employee.firstName} ${form.employee.lastName}`.trim();
        const filename = pdfFilename(payload.year, fullName).replace(/\.pdf$/, "_DRAFT.pdf");
        const ascii = filename.replace(/[^\x20-\x7E]+/g, "_").replace(/"/g, "");
        res.set({
            "Content-Type": "application/pdf",
            "Content-Length": pdf.length,
            "Content-Disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        });
        return res.status(200).end(pdf);
    } catch (e) {
        return sendServerError(res, "downloadForm101Preview", e);
    }
};

// Admin lists ke liye: kis coach ka saved form hai (preview button). Map(coachId -> { source, savedAt, savedUntil })
const savedFormsOf = async (clubId, year) => {
    const rows = await Form101Draft.find({ clubId, year, expiresAt: { $gt: new Date() } }).select("coachId source savedAt expiresAt").lean();
    return new Map(rows.map((r) => [String(r.coachId), { source: r.source, savedAt: r.savedAt, savedUntil: r.expiresAt }]));
};
const savedFormFields = (saved) => ({
    hasSavedForm: !!saved, // preview button: GET /user/coaches/:coachId/form101/preview-link
    savedFormSource: saved?.source || null, // draft = adhoora, submitted = bheja hua data
    savedFormUntil: saved?.savedUntil || null,
});

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
        const [subs, settings, saved] = await Promise.all([
            Form101Submission.find({ coachId: coach._id }).sort({ year: -1 }),
            settingsFor(coach.clubId),
            savedFormsOf(coach.clubId, year),
        ]);
        const current = subs.find((s) => s.year === year);

        return sendOk(res, "Form 101 status fetched.", {
            taxYear: year,
            ...settings,
            status: formatStatus(current, year, settings, { admin: true }),
            ...savedFormFields(saved.get(String(coach._id))),
            timeline: timelineOf(current),
            years: subs.map((s) => ({ ...formatStatus(s, s.year, settings, { admin: true }), timeline: timelineOf(s) })),
        });
    } catch (e) {
        return sendServerError(res, "getCoachForm101", e);
    }
};

/**
 * GET /user/coaches/:id/form101/history   (club admin: apne club ka coach)
 * Coach ki details + har saal ka status + poori history (kab kisne submit / approve / wapas bheja, reason ke saath).
 * Naya saal / naya event pehle. Form ka data nahi (PDF mein hai: GET /user/form101/:id/pdf-link).
 */
const getCoachForm101History = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid coach id.");
        const coach = await Coach.findById(id).populate("userId", "firstname lastname email countryCode mobileNumber profile_image");
        if (!coach || String(coach.clubId) !== String(req.clubId)) {
            return sendError(res, 404, "Coach not found.");
        }

        const year = currentTaxYear();
        const [subs, settings] = await Promise.all([
            Form101Submission.find({ coachId: coach._id }).sort({ year: -1 }).populate("history.by", "firstname lastname role"),
            settingsFor(coach.clubId),
        ]);
        const nameOf = (u) => (u ? `${u.firstname || ""} ${u.lastname || ""}`.trim() : "");

        const years = subs.map((sub) => ({
            ...formatStatus(sub, sub.year, settings, { admin: true }),
            pdf: sub.pdf?.fileId ? { filename: sub.pdf.filename, size: sub.pdf.size, createdAt: sub.pdf.createdAt } : null,
            history: [...sub.history].reverse().map((h) => ({
                status: h.status, // submitted | approved | returned
                at: h.at,
                by: nameOf(h.by),
                byRole: h.by?.role || "",
                reason: h.status === "returned" ? h.reason || "" : "",
            })),
        }));
        const current = subs.find((s) => s.year === year);
        const user = coach.userId;

        return sendOk(res, "Form 101 history fetched.", {
            coach: {
                _id: coach._id,
                firstname: user?.firstname || "",
                lastname: user?.lastname || "",
                email: user?.email || "",
                countryCode: user?.countryCode || "",
                mobileNumber: user?.mobileNumber || "",
                profile_image: user?.profile_image || "",
            },
            taxYear: year,
            ...settings,
            current: formatStatus(current, year, settings, { admin: true }),
            totals: {
                years: subs.length,
                submissions: subs.reduce((n, s) => n + s.history.filter((h) => h.status === "submitted").length, 0),
                returned: subs.reduce((n, s) => n + s.history.filter((h) => h.status === "returned").length, 0),
                approved: subs.reduce((n, s) => n + s.history.filter((h) => h.status === "approved").length, 0),
            },
            years,
        });
    } catch (e) {
        return sendServerError(res, "getCoachForm101History", e);
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
    saveMyForm101Draft,
    deleteMyForm101Draft,
    getMyForm101Saved,
    downloadSavedForm101File,
    submitMyForm101,
    listForm101Status,
    listSubmittedForm101,
    reviewForm101,
    getCoachForm101,
    getCoachForm101History,
    getForm101PdfLink,
    downloadForm101PdfByLink,
    getMyForm101PreviewLink,
    getCoachForm101PreviewLink,
    downloadForm101Preview,
    getForm101Settings,
    updateForm101Settings,
    getForm101Mandatory,
    updateForm101Mandatory,
    currentTaxYear,
};
