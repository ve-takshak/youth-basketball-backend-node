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
        categoryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "TeamCategory",
            required: [true, "Category is required"],
        },
        gender: {
            type: String,
            enum: ["boys", "girls", "mixed"],
            default: "mixed",
        },
        teamType: {
            type: String,
            enum: ["league", "non-league"],
            default: "league",
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
        // Coach assignment is optional
        coachId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Coach",
            default: null,
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
TeamSchema.index({ categoryId: 1 });

const Team = mongoose.model("Team", TeamSchema);
module.exports = Team;
