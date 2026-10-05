const mongoose = require("../../config/database");

// Club admin ki login details (naam, mobile, role: "clubAdmin") User model mein hain.
// Yahan sirf usko club se jodne wali cheezein hain. Coach model jaisa hi pattern.
const ClubAdminSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // superAdmin
    },
    { timestamps: true }
);

const ClubAdmin = mongoose.model("ClubAdmin", ClubAdminSchema);
module.exports = ClubAdmin;
