const jwt = require("jsonwebtoken");
const validator = require("validator");
const User = require("../../models/User");

// Abhi testing ke liye OTP hamesha 0000. Baad mein SMS lagane pe sirf generateOtp() badalna hoga.
const STATIC_OTP = "0000";
const OTP_VALID_MINUTES = 10;
const ROLES = ["admin", "coach", "parent"];

const generateOtp = () => STATIC_OTP;

// Response ka ek hi format sab API mein
const send = (res, status, error, message, data = {}) =>
    res.status(status).json({ error, status, message, message_desc: message, data });

// Mobile number clean: sirf digits
const cleanMobile = (mobile = "") => String(mobile).replace(/\D/g, "");

const createToken = (user) =>
    jwt.sign({ id: user._id, role: user.role }, process.env.JWTKEY, {
        algorithm: "HS256",
        expiresIn: "180d",
    });

// Response mein jaane wala user data
const publicUser = (user) => ({
    _id: user._id,
    firstname: user.firstname,
    lastname: user.lastname,
    username: user.username || "",
    email: user.email || "",
    countryCode: user.countryCode,
    mobileNumber: user.mobileNumber,
    role: user.role,
    is_verify: user.is_verify,
});

/**
 * POST /api/user/register
 * body: { mobileNumber, countryCode?, firstname?, lastname?, username?, email?, role? }
 */
const register = async (req, res) => {
    try {
        let {
            firstname = "",
            lastname = "",
            username = "",
            email = "",
            countryCode = "+972",
            mobileNumber = "",
            role = "parent",
            device_type = "",
            device_token = "",
        } = req.body;

        firstname = String(firstname).trim();
        lastname = String(lastname).trim();
        username = String(username).trim();
        email = String(email).trim().toLowerCase();
        mobileNumber = cleanMobile(mobileNumber);

        if (!mobileNumber || mobileNumber.length < 7) return send(res, 400, true, "Valid mobile number is required.");
        if (email && !validator.isEmail(email)) return send(res, 400, true, "Please enter a valid email.");
        if (!ROLES.includes(role)) return send(res, 400, true, "Invalid role.");

        const mobileExists = await User.findOne({ countryCode, mobileNumber });
        if (mobileExists) return send(res, 409, true, "This mobile number is already registered.");

        if (email) {
            const emailExists = await User.findOne({ email });
            if (emailExists) return send(res, 409, true, "This email is already registered.");
        }

        const user = await User.create({
            firstname,
            lastname,
            username,
            email: email || undefined, // khaali email save nahi karna
            countryCode,
            mobileNumber,
            role,
            device_type,
            device_token,
            otp: generateOtp(),
            otp_generated_at: new Date(),
        });

        return send(res, 201, false, "Signup successful. OTP sent to your mobile number.", publicUser(user));
    } catch (e) {
        console.error("Register error:", e);
        return send(res, 500, true, "Something went wrong.");
    }
};

/**
 * POST /api/user/login
 * body: { countryCode, mobileNumber }
 * Ye OTP bhejta hai. Isi API ko "resend OTP" ke liye bhi call kar sakte ho.
 */
const login = async (req, res) => {
    try {
        let { countryCode = "+972", mobileNumber = "" } = req.body;
        mobileNumber = cleanMobile(mobileNumber);

        if (!mobileNumber) return send(res, 400, true, "Mobile number is required.");

        const user = await User.findOne({ countryCode, mobileNumber });
        if (!user) return send(res, 404, true, "Mobile number not registered with us.");

        user.otp = generateOtp();
        user.otp_generated_at = new Date();
        await user.save();

        return send(res, 200, false, "OTP sent to your mobile number.", { countryCode, mobileNumber });
    } catch (e) {
        console.error("Login error:", e);
        return send(res, 500, true, "Something went wrong.");
    }
};

/**
 * POST /api/user/verify-otp
 * body: { countryCode, mobileNumber, otp }
 * Signup aur login dono ke baad yahi call hoga. Sahi OTP pe token milega.
 */
const verifyOtp = async (req, res) => {
    try {
        let { countryCode = "+972", mobileNumber = "", otp = "" } = req.body;
        mobileNumber = cleanMobile(mobileNumber);
        otp = String(otp).trim();

        if (!mobileNumber) return send(res, 400, true, "Mobile number is required.");
        if (!otp) return send(res, 400, true, "OTP is required.");

        const user = await User.findOne({ countryCode, mobileNumber }).select("+otp");
        if (!user) return send(res, 404, true, "Mobile number not registered with us.");

        if (!user.otp || user.otp !== otp) return send(res, 400, true, "Invalid OTP.");

        const minutes = (Date.now() - new Date(user.otp_generated_at).getTime()) / 60000;
        if (minutes > OTP_VALID_MINUTES) return send(res, 400, true, "OTP has expired. Please request a new one.");

        user.otp = "";
        user.otp_generated_at = null;
        user.otp_verify_at = new Date();
        user.is_verify = true;
        await user.save();

        return send(res, 200, false, "OTP verified successfully.", {
            ...publicUser(user),
            token: createToken(user),
        });
    } catch (e) {
        console.error("Verify OTP error:", e);
        return send(res, 500, true, "Something went wrong.");
    }
};

module.exports = { register, login, verifyOtp };