const mongoose = require("../../config/database");

// Coach ki login details (naam, mobile, role: "coach") User model mein hain.
// Yahan sirf coach ko club se jodne wali cheezein hain.
const CoachSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

const Coach = mongoose.model("Coach", CoachSchema);
module.exports = Coach;
