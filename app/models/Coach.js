const mongoose = require("../../config/database");
const { WEEK_DAYS, TIME_RX } = require("../helpers/scheduleHelper");

// Coach ki login details (naam, mobile, role: "coach") User model mein hain.
// Yahan coach ko club se jodne wali cheezein + kab train kar sakta hai.


// Ek "nahi aa sakta" block: din + time (24 ghante, "HH:MM")
const UnavailableBlockSchema = new mongoose.Schema(
    {
        day: { type: String, enum: WEEK_DAYS, required: true },
        from: { type: String, match: TIME_RX, required: true }, // "16:00"
        to: { type: String, match: TIME_RX, required: true }, // "20:00"
    },
    { _id: false }
);

const CoachSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        // Self-employed coaches who issue invoices can be exempt from Form 101.
        // Default true preserves the existing mandatory behavior for old records.
        form101Required: { type: Boolean, default: true },

        // Coach kin dinon mein training lena pasand karta hai, jaise ["sun", "tue", "thu"]
        preferredTrainingDays: { type: [{ type: String, enum: WEEK_DAYS }], default: [] },

        // Har hafte kab NAHI aa sakta, jaise [{ day: "mon", from: "16:00", to: "20:00" }]
        unavailableHours: { type: [UnavailableBlockSchema], default: [] },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // superAdmin ya clubAdmin

        // Salary ke liye bank account. Sirf coach khud, uske club ka club admin aur super admin dekh sakte hain
        // (GET/PUT /user/coaches/:id/bank-details). select: false = normal Coach queries / responses mein
        // ye kabhi nahi aata, sirf .select("+bankDetails") se. accountNumber secretBox (AES-256-GCM) se encrypted.
        bankDetails: {
            type: new mongoose.Schema(
                {
                    bankCode: { type: String, trim: true, required: true }, // jaise "12" (Hapoalim)
                    branch: { type: String, trim: true, required: true }, // jaise "345"
                    accountNumber: { type: String, required: true }, // ENCRYPTED: "v1:<iv>:<tag>:<data>"
                    accountHolder: { type: String, trim: true, default: "" },
                    updatedAt: { type: Date, default: Date.now },
                    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
                },
                { _id: false }
            ),
            default: null,
            select: false,
        },
    },
    { timestamps: true }
);

const Coach = mongoose.model("Coach", CoachSchema);
module.exports = Coach;