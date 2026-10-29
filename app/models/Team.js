const mongoose = require("../../config/database");
const { WEEK_DAYS, TIME_RX } = require("../helpers/scheduleHelper");

// "HH:MM" ya khaali (athletics band ho toh time khaali rehta hai)
const optionalTime = {
    type: String,
    default: "",
    validate: { validator: (v) => v === "" || TIME_RX.test(v), message: "Time must be HH:MM." },
};

// Team kab NAHI khel / train sakti (har hafte): din + time
const UnavailableBlockSchema = new mongoose.Schema(
    {
        day: { type: String, enum: WEEK_DAYS, required: true },
        from: { type: String, match: TIME_RX, required: true }, // "16:00"
        to: { type: String, match: TIME_RX, required: true }, // "18:00"
    },
    { _id: false }
);

// Hafte mein ek athletics / conditioning session, alag jagah par
const AthleticsTrainingSchema = new mongoose.Schema(
    {
        enabled: { type: Boolean, default: false },
        locationName: { type: String, trim: true, default: "" }, // "Sharon Athletics Track"
        day: { type: String, enum: [...WEEK_DAYS, ""], default: "" },
        from: optionalTime, // "17:00"
        to: optionalTime, // "18:30"
    },
    { _id: false }
);

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
        // Sirf league team ke liye (optional). Non-league team ke liye hamesha null.
        // String rakha hai taaki aage ke zero (0123) na kat jaayein.
        associationNumber: {
            type: String,
            trim: true,
            default: null, // "6055"
        },
        leagueClassificationNumber: {
            type: String,
            trim: true,
            default: null, // "12433"
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

        // Har hafte team kab NAHI aa sakti, jaise [{ day: "fri", from: "12:00", to: "18:00" }]
        unavailableHours: {
            type: [UnavailableBlockSchema],
            default: [],
        },

        // Athletics / conditioning training (checkbox + location + din + time)
        athleticsTraining: {
            type: AthleticsTrainingSchema,
            default: () => ({}),
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