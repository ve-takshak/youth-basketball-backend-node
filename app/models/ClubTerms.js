const mongoose = require("../../config/database");

// Club ki Terms & Conditions ka ek version. Rich text (editor Delta), jis bhasha mein club chahe (Hebrew / English / mixed).
// Version kabhi badla ya hataya nahi jaata (acceptance log ke liye): badalna ho toh naya version banta hai.
const ClubTermsSchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        version: { type: Number, required: true, min: 1 },
        content: { type: mongoose.Schema.Types.Mixed, required: true }, // { ops: [...] }, helpers/termsDelta.js se checked
        plainText: { type: String, required: true }, // sirf text (length / empty check ke liye)

        // true: is version ke baad parents ko dobara accept karna hoga (pehla version hamesha true)
        requireReaccept: { type: Boolean, default: true },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

ClubTermsSchema.index({ clubId: 1, version: 1 }, { unique: true });

module.exports = mongoose.model("ClubTerms", ClubTermsSchema);
