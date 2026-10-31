const mongoose = require("../../config/database");

// Kisne (parent user) kaunsa Terms version kab accept kiya. Sirf add hota hai, kabhi badla / hataya nahi jaata.
const TermsAcceptanceSchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        termsId: { type: mongoose.Schema.Types.ObjectId, ref: "ClubTerms", required: true },
        version: { type: Number, required: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

        acceptedAt: { type: Date, default: Date.now },
        ip: { type: String, default: "" },
        deviceType: { type: String, default: "" }, // android / ios / web
        userAgent: { type: String, default: "" },
    },
    { timestamps: false }
);

TermsAcceptanceSchema.index({ userId: 1, termsId: 1 }, { unique: true });
TermsAcceptanceSchema.index({ clubId: 1, version: 1 });

module.exports = mongoose.model("TermsAcceptance", TermsAcceptanceSchema);
