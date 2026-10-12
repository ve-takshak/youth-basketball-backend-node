const mongoose = require("../../config/database");

// Proposal 2.3: Team & Player Registration
// Player ki personal details (naam, DOB, gender, ID, mobile) User model mein hain (role: "player").
// Yahan sirf khel se judi cheezein hain. Coach / Parent jaisa hi pattern.
const SHIRT_SIZES = ["YXS", "YS", "YM", "YL", "XS", "S", "M", "L", "XL", "XXL"]; // Y = youth (bachchon ke size)
const PLAYER_STATUSES = ["active", "waitlisted", "inactive", "left"];
const PLAYER_TYPES = ["youth", "senior"];
const PARENT_RELATIONS = ["father", "mother", "guardian", "other"];

// Player aur Parent ka rishta. Parent ki details Parent model (aur uske User) mein hain.
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
        // Player ka User (role: "player"): naam, DOB, gender, ID, mobile wahan hain
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },

        // ---- Club / team ----
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        // Waitlisted player ki team abhi tay nahi ho sakti, isliye optional
        teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
        season: { type: String, trim: true, default: "" }, // "2026 / 2027"

        // youth = parent ke under (parent zaroori), senior = adult
        playerType: { type: String, enum: PLAYER_TYPES, default: "youth" },

        // ---- Shirt ----
        shirtSize: { type: String, enum: [...SHIRT_SIZES, ""], default: "" },
        shirtNumber: { type: Number, min: 0, max: 99, default: null },

        // ---- Parents / guardians (ek se zyada ho sakte hain) ----
        parents: { type: [PlayerParentSchema], default: [] },

        // ---- Registration status ----
        status: { type: String, enum: PLAYER_STATUSES, default: "active" },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // superAdmin ya clubAdmin
    },
    { timestamps: true }
);

PlayerSchema.index({ clubId: 1, status: 1 });
PlayerSchema.index({ teamId: 1, shirtNumber: 1 });
PlayerSchema.index({ "parents.parentId": 1 });

const Player = mongoose.model("Player", PlayerSchema);
module.exports = Player;
module.exports.SHIRT_SIZES = SHIRT_SIZES;
module.exports.PLAYER_STATUSES = PLAYER_STATUSES;
module.exports.PLAYER_TYPES = PLAYER_TYPES;
module.exports.PARENT_RELATIONS = PARENT_RELATIONS;