const mongoose = require("../../config/database");
const { TIME_RX } = require("../helpers/scheduleHelper");

// Schedule ka ek schedule (calendar ka ek event): training, home game, away game ya other.
// Admin ka "Create schedule" form isi ke fields hain.
const SCHEDULE_TYPES = ["training", "home_game", "away_game", "other"];
const GAME_TYPES = ["home_game", "away_game"];

// draft = sirf admin dekhta hai, "Send schedule" ke baad published (coach / parent portal par)
// cancelled = calendar par dikhta hai par hota nahi
const SCHEDULE_STATUSES = ["draft", "published", "cancelled"];

// "Repeat" dropdown
const REPEAT_FREQUENCIES = ["none", "daily", "weekly", "biweekly"];

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

const ScheduleSchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },

        type: { type: String, enum: SCHEDULE_TYPES, default: "training" },

        // Date "YYYY-MM-DD" string: timezone se din nahi badalta, aur string sort = date sort
        date: { type: String, match: DATE_RX, required: true }, // "2026-11-02"
        startTime: { type: String, match: TIME_RX, required: true }, // "09:00"
        endTime: { type: String, match: TIME_RX, required: true }, // "10:30"

        teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
        coachId: { type: mongoose.Schema.Types.ObjectId, ref: "Coach", default: null }, // optional
        facilityId: { type: mongoose.Schema.Types.ObjectId, ref: "Facility", default: null }, // optional

        // Game ke liye samne wali team (optional)
        opponent: { type: String, trim: true, default: "" },
        description: { type: String, trim: true, default: "" },

        status: { type: String, enum: SCHEDULE_STATUSES, default: "draft" },
        // Published schedule edit hua par abhi "Send schedule" nahi dabaya
        hasUnsentChanges: { type: Boolean, default: false },
        publishedAt: { type: Date, default: null },

        // Repeat: ek hi document. date = pehli date, until = aakhri. Beech ki dates list API banati hai.
        repeat: {
            frequency: { type: String, enum: REPEAT_FREQUENCIES, default: "none" },
            until: { type: String, default: "" }, // "YYYY-MM-DD", frequency none ho toh khaali
        },
        // Repeat ki jo dates hata di gayi (delete, ya alag se edit hokar naya schedule bani)
        excludedDates: { type: [String], default: [] },
        // Repeat ki jo dates cancel hain (calendar par dikhti hain, "cancelled")
        cancelledDates: { type: [String], default: [] },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

ScheduleSchema.index({ clubId: 1, date: 1, startTime: 1 }); // calendar range
ScheduleSchema.index({ teamId: 1, date: 1 });
ScheduleSchema.index({ coachId: 1, date: 1 });
ScheduleSchema.index({ facilityId: 1, date: 1 });
ScheduleSchema.index({ clubId: 1, "repeat.until": 1 }); // range mein chal rahe repeat

const Schedule = mongoose.model("Schedule", ScheduleSchema);
module.exports = Schedule;
module.exports.SCHEDULE_TYPES = SCHEDULE_TYPES;
module.exports.GAME_TYPES = GAME_TYPES;
module.exports.SCHEDULE_STATUSES = SCHEDULE_STATUSES;
module.exports.REPEAT_FREQUENCIES = REPEAT_FREQUENCIES;
module.exports.DATE_RX = DATE_RX;
