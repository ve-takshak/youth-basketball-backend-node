const mongoose = require("../../config/database");

// Hafte ke din (preferred training days). Order yahi rakhna, sort isi se hota hai.
const WEEK_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

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
        // Active / inactive (team form ka Status toggle)
        status: {
            type: String,
            enum: ["active", "inactive"],
            default: "active",
        },
        // Coach assignment is optional
        coachId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Coach",
            default: null,
        },

        // Home venue: isi club ki ek Facility. Team ke home games yahin hote hain.
        homeVenueId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Facility",
            default: null,
        },

        // Training ke pasandida din, jaise ["sun", "tue", "thu"]
        preferredTrainingDays: {
            type: [{ type: String, enum: WEEK_DAYS }],
            default: [],
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
TeamSchema.index({ homeVenueId: 1 }); // facility delete karte waqt check ke liye

const Team = mongoose.model("Team", TeamSchema);
module.exports = Team;
module.exports.WEEK_DAYS = WEEK_DAYS;