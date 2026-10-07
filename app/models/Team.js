const mongoose = require("../../config/database");

const TeamSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            trim: true,
            required: [true, "Team name is required"],
        },
        clubId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Club",
            required: [true, "Club is required"],
        },
        // Coach assignment is optional
        coachId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Coach",
            default: null,
        },
        categoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "TeamCategory",
            default: null,
        },
        ageCategory: {
            type: String,
            trim: true,
            default: "",
        },
        season: {
            type: String,
            trim: true,
            default: "",
        },
        teamCapacity: {
            type: Number,
            default: 20,
        },
        status: {
            type: String,
            enum: ["active", "inactive"],
            default: "active",
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
    },
    { timestamps: true }
);

TeamSchema.index({ clubId: 1, name: 1 });
TeamSchema.index({ coachId: 1 });

const Team = mongoose.model("Team", TeamSchema);
module.exports = Team;
