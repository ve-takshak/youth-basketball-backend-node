const mongoose = require("../../config/database");

// Form 101 ka SIRF status. Bhara hua form (ID, bachche, income...) yahan KABHI save nahi hota:
// PDF memory mein banta hai, club admin (+ accounting) ko email hota hai, phir khatam.
//
// Har coach ka har saal ek record. "Is saal bhara?" = is saal ka record hai ya nahi.
// Isliye January mein koi reset / cron nahi chahiye: naye saal ka record hota hi nahi,
// toh status apne aap "not submitted", aur pichhle saal ke records history mein bache rehte hain.

const FORM101_STATUSES = ["submitted", "approved", "returned"];

const HistorySchema = new mongoose.Schema(
    {
        status: { type: String, enum: FORM101_STATUSES, required: true },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        reason: { type: String, trim: true, default: "" }, // sirf "returned" pe
    },
    { _id: false }
);

const Form101SubmissionSchema = new mongoose.Schema(
    {
        coachId: { type: mongoose.Schema.Types.ObjectId, ref: "Coach", required: true },
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true, index: true },
        year: { type: Number, required: true }, // tax year, jaise 2026

        status: { type: String, enum: FORM101_STATUSES, required: true },
        submittedAt: { type: Date, required: true }, // aakhri submit
        reviewedAt: { type: Date, default: null },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        returnReason: { type: String, trim: true, default: "" }, // coach ko dikhta hai

        history: { type: [HistorySchema], default: [] },
    },
    { timestamps: true }
);

Form101SubmissionSchema.index({ coachId: 1, year: 1 }, { unique: true });
Form101SubmissionSchema.index({ clubId: 1, year: 1 });

const Form101Submission = mongoose.model("Form101Submission", Form101SubmissionSchema);
module.exports = Form101Submission;
module.exports.FORM101_STATUSES = FORM101_STATUSES;
