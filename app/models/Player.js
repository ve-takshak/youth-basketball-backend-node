const mongoose = require("../../config/database");

// Proposal 2.3: Team & Player Registration
// Player do tarah ke:
//   senior -> User role "seniorPlayer": khud mobile + OTP se login, koi parent nahi
//   youth  -> User role "youthPlayer":  parent ke under (kam se kam ek parent), mobile optional
// Personal details (naam, DOB, gender, ID, mobile, email) User model mein hain.
// Yahan sirf khel se judi cheezein hain. Coach / Parent jaisa hi pattern.
const SHIRT_SIZES = ["YXS", "YS", "YM", "YL", "XS", "S", "M", "L", "XL", "XXL"]; // Y = youth (bachchon ke size)
const PLAYER_STATUSES = ["pending", "active", "waitlisted", "inactive", "left"];
const PLAYER_TYPES = ["youth", "senior"];
const PARENT_RELATIONS = ["father", "mother", "guardian", "other"];
const AGE_GROUPS = [
    { code: "mini", label: "Youth (Ages 4-6)", minAge: 4, maxAge: 6 },
    { code: "youth", label: "Youth (Ages 7-13)", minAge: 7, maxAge: 13 },
    { code: "junior", label: "Youth (Ages 14-17)", minAge: 14, maxAge: 17 },
];


// Player aur Parent ka rishta (sirf youth). Parent ki details Parent model (aur uske User) mein hain.
const PlayerParentSchema = new mongoose.Schema(
    {
        parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Parent", required: true },
        relation: { type: String, enum: PARENT_RELATIONS, default: "guardian" },
        isPrimary: { type: Boolean, default: false }, // payment reminder / SMS pehle isko
    },
    { _id: false }
);

const PlayerSchema = new mongoose.Schema(
    {
        // Player ka User (role: "seniorPlayer" ya "youthPlayer")
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },

        // ---- Club / team ----
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        // Waitlisted player ki team abhi tay nahi ho sakti, isliye optional
        teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
        season: { type: String, trim: true, default: "" }, // "2026 / 2027"

        // youth = parent ke under (parent zaroori), senior = khud login, parent nahi
        playerType: { type: String, enum: PLAYER_TYPES, default: "youth" },

        // ---- Shirt ----
        shirtSize: { type: String, enum: [...SHIRT_SIZES, ""], default: "" },
        shirtNumber: { type: Number, min: 0, default: null }, // 145 jaisa bhi ho sakta hai

        // ---- Photo / ID / passport attachment (IBBA ke liye), S3 URL jaise club logo ----
        idDocument: { type: String, default: "" },

        // ---- Parents / guardians (sirf youth, ek se zyada ho sakte hain) ----
        parents: { type: [PlayerParentSchema], default: [] },

        ageGroup: { type: String, enum: [...AGE_GROUPS.map((g) => g.code), ""], default: "" },

        registrationNumber: { type: String, trim: true },

        // ---- Registration status ----
        status: { type: String, enum: PLAYER_STATUSES, default: "active" },

        // ---- Medical / allergies (sirf coach, clubAdmin, parent dekh sakein) ----
        medicalNotes: { type: String, trim: true, maxlength: 500, default: "" },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // superAdmin ya clubAdmin
    },
    { timestamps: true }
);

PlayerSchema.index({ clubId: 1, status: 1 });
PlayerSchema.index({ teamId: 1, shirtNumber: 1 });
PlayerSchema.index({ "parents.parentId": 1 });
PlayerSchema.index(
    { registrationNumber: 1 },
    { unique: true, partialFilterExpression: { registrationNumber: { $type: "string" } } }
);

const Player = mongoose.model("Player", PlayerSchema);
module.exports = Player;
module.exports.SHIRT_SIZES = SHIRT_SIZES;
module.exports.PLAYER_STATUSES = PLAYER_STATUSES;
module.exports.PLAYER_TYPES = PLAYER_TYPES;
module.exports.PARENT_RELATIONS = PARENT_RELATIONS;
module.exports.AGE_GROUPS = AGE_GROUPS;