const mongoose = require("../../config/database");

// Parent ki login details (naam, mobile, email, role: "parent") User model mein hain.
// Yahan sirf parent ko club se jodne wali cheezein hain. Coach / ClubAdmin jaisa hi pattern.
// Bachchon se rishta Player model ke "parents" mein hai (ek parent ke kai bachche ho sakte hain).
const ParentSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // superAdmin ya clubAdmin
    },
    { timestamps: true }
);

ParentSchema.index({ clubId: 1 });

const Parent = mongoose.model("Parent", ParentSchema);
module.exports = Parent;