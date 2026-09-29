
const mongoose = require("../../config/database")

var UserSchema = new mongoose.Schema({

    firstname: { type: String },
    lastname: { type: String },
    username: { type: String },
    password: { type: String },
    email: { type: String, default: "", index: { unique: true } },

    reset_key: {
        type: String,
        default: ""
    },
    countryCode: {
        type: String,
        default: "+1"
    },
    mobileNumber: {
        type: String,
        default: ""
    },
    device_type: {
        type: String,   // android, ios
        default: ""
    },
    email_verified_at: { type: Date, default: "" },
    is_verify: { type: String, default: '0' },
    signup_type: { type: String, enum: ['Normal', 'Google', 'Apple'], default: 'Normal' },

    otp: { type: Number, default: 0 },
    otp_generated_at: { type: Date, default: 0 },
    resend_blocked_at: { type: Date, default: 0 },
    otp_resend: { type: Number, default: 0 },
    otp_verify_at: { type: Date, default: "" },
    device_token: { type: String, default: "" },

    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },

}, { timestamps: true })

const User = mongoose.model('users', UserSchema);
module.exports = User
