const mongoose = require("../../config/database");

const UserSchema = new mongoose.Schema(
    {
        firstname: { type: String, trim: true, default: "" },
        lastname: { type: String, trim: true, default: "" },
        username: { type: String, trim: true, default: "" },

        // Optional. sparse = jinke paas email nahi unpe unique check nahi lagega
        email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },

        // Login isi se hota hai
        countryCode: { type: String, default: "+972" },
        mobileNumber: { type: String, required: true, trim: true },

        role: { type: String, enum: ["owner", "admin", "coach", "parent"], default: "parent" },

        // OTP
        is_verify: { type: Boolean, default: false },
        otp: { type: String, default: "", select: false },
        otp_generated_at: { type: Date, default: null },
        otp_verify_at: { type: Date, default: null },

        // Mobile push notifications
        device_type: { type: String, enum: ["android", "ios", "web", ""], default: "" },
        device_token: { type: String, default: "" },
    },
    { timestamps: true }
);

// Same country code + mobile number se do account nahi banenge
UserSchema.index({ countryCode: 1, mobileNumber: 1 }, { unique: true });

const User = mongoose.model("User", UserSchema);
module.exports = User;
