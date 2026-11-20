const mongoose = require("../../config/database");

// Form 101 ke bhare hue fields (client ke kehne pe): coach adhoora chhode ya form wapas aaye (returned),
// toh dobara poora na bharna pade. Har coach ka har saal ek record.
//
// Rules (client, Nov 2026):
//   - Data sirf 7 din rehta hai (aakhri save / submit / return / approve se), status kuch bhi ho. Uske baad MongoDB khud delete karta hai
//     (TTL index on expiresAt). Phir coach ko shuru se bharna hoga.
//   - Approve pe bhi turant delete nahi, 7 din aur (phir apne aap). Status row (Form101Submission) aur PDF rehte hain.
//
// data ENCRYPTED hai (helpers/secretBox, AES-256-GCM): ID number, bachche, income... plain text mein kabhi nahi.
// Documents (ID card, ח / ט documents, attachments) submit pe GridFS "form101DraftFiles" mein encrypted
// (helpers/form101DraftFiles), yahan sirf unka reference. Signature kabhi save nahi (har submit pe naya).

const DRAFT_DAYS = 7;

const Form101DraftSchema = new mongoose.Schema(
    {
        coachId: { type: mongoose.Schema.Types.ObjectId, ref: "Coach", required: true },
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        year: { type: Number, required: true },
        data: { type: String, required: true }, // ENCRYPTED JSON: "v1:<iv>:<tag>:<data>"
        source: { type: String, enum: ["draft", "submitted"], default: "draft" }, // draft = coach ne save kiya, submitted = aakhri submit ka data
        // Aakhri submit ke documents. field = submit wala form-data key: idCard | doc_<reason> | doc_taxCoordination | attachments
        files: {
            type: [
                new mongoose.Schema(
                    {
                        fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
                        field: { type: String, required: true },
                        filename: { type: String, default: "" },
                        mimetype: { type: String, default: "" },
                        size: { type: Number, default: 0 },
                    },
                    { _id: false }
                ),
            ],
            default: [],
        },
        savedAt: { type: Date, default: Date.now },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);

Form101DraftSchema.index({ coachId: 1, year: 1 }, { unique: true });
Form101DraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // expiresAt aate hi MongoDB delete karta hai

const Form101Draft = mongoose.model("Form101Draft", Form101DraftSchema);
module.exports = Form101Draft;
module.exports.DRAFT_DAYS = DRAFT_DAYS;
module.exports.draftExpiry = (from = new Date()) => new Date(from.getTime() + DRAFT_DAYS * 24 * 60 * 60 * 1000);
