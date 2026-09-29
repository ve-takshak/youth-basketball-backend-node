const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const validator = require("validator");
const { sendOtpEmail } = require("../../../utils/mailer");
const MOMENT = require('moment');

const User = require("../../models/User");

const OTP_MIN = 1000;
const OTP_MAX = 9999;
const generateOtp = () => Math.floor(OTP_MIN + Math.random() * (OTP_MAX - OTP_MIN + 1));

// Minimum wait between two OTP sends to the same address (signup, resend, forgot-password all
// share this so someone can't hammer the mail server from any one of the three screens).
const RESEND_COOLDOWN_MS = 60 * 1000;
// How long an OTP stays valid, checked against otp_generated_at in verify_otp.
const OTP_VALID_MINUTES = 10;

const PUBLIC_FIELDS = "-password -otp -otp_generated_at -resend_blocked_at -otp_resend -otp_verify_at -reset_key";

const signupWithEmail = async (req, res) => {
    try {
        let {
            firstname = "",
            lastname = "",
            password = "",
            username = "",
            email = "",
            countryCode = "+1",
            mobileNumber = "",
            device_udid = "",
            device_type = ""
        } = req.body;


        firstname = firstname.trim();
        lastname = lastname.trim();
        email = email.trim().toLowerCase();

        if (firstname === '') {

            return res.send({ "error": true, 'status': 201, "message": "Firstname name is required.", "message_desc": "Full name is required." })

        }

        else if (lastname === '') {

            return res.send({ "error": true, 'status': 201, "message": "Lastname is required.", "message_desc": "Username is required" })

        }

        if (email === '') {

            return res.send({ "error": true, 'status': 201, "message": "Email is required.", "message_desc": "Email is required" })

        }

        if (!validator.isEmail(email)) {
            return res.status(400).json({
                error: true,
                message: "Please enter a valid email.",
                message_desc: "Please enter a valid email.",
                data: {}
            });
        }

        if (!password) {
            return res.status(400).json({
                error: true,
                message: "Password is required.",
                message_desc: "Password is required.",
                data: {}
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                error: true,
                message: "Password must be at least 8 characters.",
                message_desc: "Password must be at least 8 characters.",
                data: {}
            });
        }
        // Check if email already exists
        const existingUser = await User.findOne({ email });

        if (existingUser) {
            return res.status(409).json({
                error: true,
                message: "This email is already registered.",
                message_desc: "This email is already registered.",
                data: {}
            });
        }

        const otp = generateOtp();

        const passwordHash = await bcrypt.hash(password, 12);

        const resetKey = crypto.randomBytes(20).toString("hex");

        // =========================
        // 6. Create user
        // =========================

        const user = new User({
            firstname,
            lastname,
            username,
            email,
            password: passwordHash,

            reset_key: resetKey,

            otp,
            otp_generated_at: new Date(),
            resend_blocked_at: new Date(Date.now() + RESEND_COOLDOWN_MS),

            countryCode,
            mobileNumber,
            device_udid,
            device_type,

            signup_type: "Normal",
            is_verify: "0",
            role: "user"
        });

        const savedUser = await user.save();

        // =========================
        // 7. Send verification email (shared OTP template — see utils/mailer.js)
        // =========================

        await sendOtpEmail({
            to: email,
            name: firstname,
            otp,
            subject: "Verify your Courtside account",
            intro: "Thank you for creating an account with Courtside. Please use the code below to verify your email address.",
        });

        const login_data = await User.findById(savedUser._id).select(PUBLIC_FIELDS);

        return res.status(201).json({
            error: false,
            message: "Signup successful! An OTP has been sent to your email for verification.",
            message_desc: "Signup successful! An OTP has been sent to your email for verification.",
            data: login_data
        });

    } catch (error) {

        console.error("Signup error:", error);

        return res.status(500).json({
            error: true,
            message: "Something went wrong.",
            message_desc: error.message,
            data: {}
        });
    }
};


const verify_otp = async (req, res) => {


    try {

        const { email = '', otp = '' } = req.body

        if (email.trim() === '' || !validator.isEmail(email.trim())) {
            return res.send({
                error: true,
                status: 201,
                message: "Email field is required and must be valid email.",
                message_desc: "Email field is required and must be valid email."
            });
        }

        if (otp == '' || otp == 0) {

            return res.send({ "error": true, 'status': 201, "message": "Otp is required.", "message_desc": "Enter your otp which you have recieved in your mobile number." })

        }

        const normalizedEmail = email.trim().toLowerCase();
        const data = await User.findOne({ email: normalizedEmail }, { resend_blocked_at: 0 })


        if (data == null) {

            return res.send({ "error": true, 'status': 201, "message": "Email id not registered with us.", "message_desc": "The Email you provided is not registered with us." })
        }

        if (data.otp === 0) {

            return res.send({ "error": true, 'status': 201, "message": "No OTP found.", "message_desc": "No OTP found." })
        }

        if (data.otp != otp) {

            return res.send({ "error": true, 'status': 201, "message": "Invalid otp.", "message_desc": "OTP verifcation failled due to wrong otp provided." })
        }


        startTime = MOMENT(data.otp_generated_at, 'YYYY-MM-DD HH:mm:ss');
        endTime = MOMENT(new Date(Date.now()), 'YYYY-MM-DD HH:mm:ss');
        var reset_keys = crypto.randomBytes(20).toString('hex');
        let timeDiff = endTime.diff(startTime, "minute");

        if (timeDiff > OTP_VALID_MINUTES) {

            return res.send({ "error": true, 'status': 201, "message": "OTP has been expired.", "message_desc": `Please request a new OTP — codes are valid for ${OTP_VALID_MINUTES} minutes.` })

        }

        login_data = data

        const token = jwt.sign({ login_data }, process.env.JWTKEY, {
            algorithm: "HS256",
            expiresIn: '180d',
        })



        const isupdated = await User.updateMany({ email: normalizedEmail }, { $set: { otp: 0, reset_key: reset_keys, otp_generated_at: "", "otp_verify_at": Date.now(), "email_verified_at": Date.now(), "is_verify": 1, "otp_resend": 0 } });
        const keys = await User.findOne({ email: normalizedEmail }, { email_verified_at: 1, email: 1, username: 1, firstname: 1, lastname: 1, reset_key: 1 });

        keys._doc.is_emailVerified = keys.is_verify ? 1 : 0;
        keys._doc.token = token

        return res.send({ "error": false, 'status': 200, "message": "Otp verification successfull.", "message_desc": "OTP verification successfull.", "data": keys, reset_key: reset_keys })

    } catch (e) {

        return res.send({ "error": true, 'status': 201, "message": "Something went wrong.", "message_desc": "Unhandeled exception found" + e, "data": {} })
    }

}

// POST /api/user/resend-otp  { email }
// Generates a fresh OTP and sends it with the same sendOtpEmail() helper as signup/login/forgot
// password, so it looks identical to whichever OTP it's replacing. Used by both the sign-in
// screen's "not verified yet" step and the forgot-password OTP step.
const resendOtp = async (req, res) => {
    try {
        const { email = '' } = req.body;

        if (email.trim() === '' || !validator.isEmail(email.trim())) {
            return res.send({
                error: true,
                status: 201,
                message: "Email field is required and must be valid email.",
                message_desc: "Email field is required and must be valid email."
            });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            return res.send({ "error": true, 'status': 201, "message": "Email id not registered with us.", "message_desc": "The Email you provided is not registered with us." });
        }

        if (user.resend_blocked_at && new Date(user.resend_blocked_at).getTime() > Date.now()) {
            const waitSeconds = Math.ceil((new Date(user.resend_blocked_at).getTime() - Date.now()) / 1000);
            return res.send({
                error: true,
                status: 201,
                message: `Please wait ${waitSeconds}s before requesting another OTP.`,
                message_desc: `Please wait ${waitSeconds}s before requesting another OTP.`
            });
        }

        const otp = generateOtp();

        user.otp = otp;
        user.otp_generated_at = new Date();
        user.otp_resend = (user.otp_resend || 0) + 1;
        user.resend_blocked_at = new Date(Date.now() + RESEND_COOLDOWN_MS);
        await user.save();

        await sendOtpEmail({
            to: user.email,
            name: user.firstname,
            otp,
            subject: "Your Courtside verification code",
            intro: "Here is your new one-time verification code.",
        });

        return res.send({
            error: false,
            status: 200,
            message: "A new OTP has been sent to your email.",
            message_desc: "A new OTP has been sent to your email."
        });
    } catch (e) {
        return res.send({ "error": true, 'status': 201, "message": "Something went wrong.", "message_desc": "Unhandeled exception found" + e });
    }
};


const loginWithEmail = async (req, res) => {
    try {
        let { email = '', password = '' } = req.body;

        if (email.trim() === '' || !validator.isEmail(email.trim())) {
            return res.send({
                error: true,
                status: 201,
                message: "Email field is required and must be valid email.",
                message_desc: "Email field is required and must be valid email."
            });
        }

        if (password === '' || password.length < 4) {
            return res.send({
                error: true,
                status: 201,
                message: "Password is required and must be four character.",
                message_desc: "Password is required and must be four character."
            });
        }

        email = email.toLowerCase();
        const isExist = await User.findOne({ email });

        if (!isExist) {
            return res.send({
                error: true,
                status: 201,
                message: "Email not registered with us.",
                message_desc: "Email not registered with us."
            });
        }

        // Email verification
        if (isExist.is_verify == 0) {

            const newOtp = generateOtp();

            // Update OTP in DB
            await User.updateOne({ email }, {
                $set: {
                    otp: newOtp,
                    otp_generated_at: new Date(),
                    resend_blocked_at: new Date(Date.now() + RESEND_COOLDOWN_MS),
                }
            });

            await sendOtpEmail({
                to: email,
                name: isExist.firstname,
                otp: newOtp,
                subject: "Verify your Courtside account",
                intro: "Your account isn't verified yet. Use the code below to verify it and finish signing in.",
            });

            return res.send({
                error: true,
                status: 200,
                message: "Please verify your account (an OTP has been sent to your email).",
                message_desc: "Please verify your account (an OTP has been sent to your email).",
                data: {
                    _id: isExist._id,
                    firstname: isExist.firstname,
                    lastname: isExist.lastname,
                    username: isExist.username,
                    email: isExist.email,
                    token: isExist.token || "",
                    is_emailVerified: 0
                }
            });
        }

        const isPasswordMatched = bcrypt.compareSync(password, isExist.password);
        if (!isPasswordMatched) {
            return res.send({
                error: true,
                status: 201,
                message: "Check email or password.",
                message_desc: "Check email or password."
            });
        }



        const login_data = await User.findOne({ email }, {
            password: 0,
            otp: 0,
            login_location: 0
        });

        // Generate token
        const token = jwt.sign({ login_data }, process.env.JWTKEY, {
            algorithm: "HS256",
            expiresIn: '180d',
        });

        login_data._doc.is_emailVerified = login_data.email_verified_at ? 1 : 0;
        login_data._doc.token = token;


        return res.send({
            error: false,
            status: 200,
            message: "Login Successfull.",
            message_desc: "Login Successfull.",
            data: login_data
        });

    } catch (e) {
        return res.send({
            error: true,
            status: 201,
            message: "Something went wrong.",
            message_desc: "Unhandled exception found: " + e
        });
    }
};


// POST /api/user/forgotPassword  { email }
// Sends an OTP the same way signup/login/resend do. The frontend then calls verify_otp with that
// OTP to get a reset_key, and finally resetPassword with that reset_key + the new password.
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !validator.isEmail(email.trim())) {
            return res.status(400).json({ error: true, message: "Enter a valid email address." });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(404).json({ error: true, message: "Email not found" });
        }

        const otp = generateOtp();

        user.otp = otp;
        // Shares the same field verify_otp checks (was otp_expiry before, which isn't in the
        // schema and was never actually saved — verify_otp's expiry check needs otp_generated_at).
        user.otp_generated_at = new Date();
        user.resend_blocked_at = new Date(Date.now() + RESEND_COOLDOWN_MS);
        await user.save();

        await sendOtpEmail({
            to: user.email,
            name: user.firstname,
            otp,
            subject: "Your password reset code",
            intro: `Use the code below to verify it's you, then you'll be able to choose a new password. This code is valid for ${OTP_VALID_MINUTES} minutes.`,
        });

        return res.json({ error: false, message: "OTP sent to email" });
    } catch (err) {
        return res.status(500).json({ error: true, message: err.message });
    }
};


const resetPassword = async (req, res) => {
    try {
        const { reset_key, password } = req.body;

        if (!reset_key || !password) {
            return res.status(400).json({
                error: true,
                message: "Reset key & password required"
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                error: true,
                message: "Password must be at least 8 characters."
            });
        }

        // Find user
        const user = await User.findOne({ reset_key });

        if (!user) {
            return res.status(400).json({
                error: true,
                message: "Invalid reset key"
            });
        }

        // Hash new password
        const hashed = await bcrypt.hash(password, 12);

        user.password = hashed;

        // Reset key ko invalidate kar do
        user.reset_key = null;

        await user.save();

        // =========================
        // Get login data
        // =========================

        const login_data = await User.findById(user._id).select(PUBLIC_FIELDS);

        // =========================
        // Generate JWT
        // =========================

        const token = jwt.sign(
            {
                login_data
            },
            process.env.JWTKEY,
            {
                algorithm: "HS256",
                expiresIn: "180d"
            }
        );

        // Same as login response
        login_data._doc.is_emailVerified = login_data.email_verified_at ? 1 : 0;
        login_data._doc.token = token;

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Password reset successful.",
            message_desc: "Password reset successful.",
            data: login_data
        });

    } catch (err) {

        console.error("Reset password error:", err);

        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: err.message,
            data: {}
        });
    }
};

module.exports = {
    signupWithEmail, verify_otp, resendOtp, loginWithEmail, forgotPassword, resetPassword
};
