const mongoose = require("../../config/database");
const { ROLES } = require("../helpers/constants");

const UserSchema = new mongoose.Schema(
    {
        firstname: { type: String, trim: true, default: "" },
        lastname: { type: String, trim: true, default: "" },
        username: { type: String, trim: true, default: "" },
        profile_image: { type: String, default: "" },

        // Optional. sparse = jinke paas email nahi unpe unique check nahi lagega
        email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },

        // Optional date of birth (player ke liye controller mein required hai)
        birthDate: { type: Date, default: null },

        // Player ke liye (baaki roles ke liye khaali)
        gender: { type: String, enum: ["", "boys", "girls"], default: "" },
        idNumber: { type: String, trim: true, default: "" }, // Israeli ID (Teudat Zehut)

        // Login isi se hota hai. Youth player (bachche) ka mobile nahi hota, isliye optional.
        // Bina mobile wala user login nahi kar sakta.
        countryCode: { type: String, default: "+972" },
        mobileNumber: { type: String, trim: true, default: "" },

        // superAdmin | clubAdmin | coach | staff | seniorPlayer | youthPlayer | parent
        role: { type: String, enum: Object.values(ROLES), default: ROLES.PARENT },

        // OTP
        is_verify: { type: Boolean, default: false },
        otp: { type: String, default: "", select: false },
        otp_generated_at: { type: Date, default: null },
        otp_verify_at: { type: Date, default: null },

        // OTP rate limit / lockout (userController)
        otp_request_count: { type: Number, default: 0 },
        otp_request_window_started: { type: Date, default: null },
        otp_failed_attempts: { type: Number, default: 0 },
        otp_locked_until: { type: Date, default: null },

        // Mobile push notifications
        device_type: { type: String, enum: ["android", "ios", "web", ""], default: "" },
        device_token: { type: String, default: "" },
    },
    { timestamps: true }
);

// Same country code + mobile se do account nahi. Khaali mobile pe check nahi.
UserSchema.index(
    { countryCode: 1, mobileNumber: 1 },
    { unique: true, partialFilterExpression: { mobileNumber: { $type: "string", $gt: "" } } }
);

// Ek ID number ek hi insaan ka. Khaali ID pe check nahi.
UserSchema.index(
    { idNumber: 1 },
    { unique: true, partialFilterExpression: { idNumber: { $type: "string", $gt: "" } } }
);

const User = mongoose.model("User", UserSchema);
module.exports = User;