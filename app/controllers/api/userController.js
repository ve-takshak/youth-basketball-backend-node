const jwt = require("jsonwebtoken");
const validator = require("validator");
const User = require("../../models/User");
const Coach = require("../../models/Coach");

// TESTING MODE: true rehne tak har user ka OTP hamesha "0000" chalega
// (login call kiya ho ya nahi, pehle verify hua ho ya nahi, expiry bhi check nahi hogi).
// Twilio / koi SMS service lagane ke baad isko false kar dena, aur generateOtp() mein random OTP + SMS bhejna.
const USE_STATIC_OTP = true;
const STATIC_OTP = "0000";
const OTP_VALID_MINUTES = 10;

const generateOtp = () => STATIC_OTP;

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
 * Sirf ADMIN ka signup. Coach admin banata hai (createCoach), wo yahan se nahi banega.
 * body: { firstname, lastname, countryCode, mobileNumber, username?, email? }
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
            device_type = "",
            device_token = "",
        } = req.body;

        firstname = String(firstname).trim();
        lastname = String(lastname).trim();
        username = String(username).trim();
        email = String(email).trim().toLowerCase();
        mobileNumber = cleanMobile(mobileNumber);

        if (!mobileNumber || mobileNumber.length < 7) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Valid mobile number is required.",
                message_desc: "Valid mobile number is required.",
                data: {},
            });
        }

        if (email && !validator.isEmail(email)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Please enter a valid email.",
                message_desc: "Please enter a valid email.",
                data: {},
            });
        }

        const mobileExists = await User.findOne({ countryCode, mobileNumber });
        if (mobileExists) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "This mobile number is already registered.",
                message_desc: "This mobile number is already registered.",
                data: {},
            });
        }

        if (email) {
            const emailExists = await User.findOne({ email });
            if (emailExists) {
                return res.status(409).json({
                    error: true,
                    status: 409,
                    message: "This email is already registered.",
                    message_desc: "This email is already registered.",
                    data: {},
                });
            }
        }

        const user = await User.create({
            firstname,
            lastname,
            username,
            email: email || undefined, // khaali email save nahi karna
            countryCode,
            mobileNumber,
            role: "admin", // body se role nahi lete, signup sirf admin ka
            device_type,
            device_token,
            otp: generateOtp(),
            otp_generated_at: new Date(),
        });

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Signup successful. OTP sent to your mobile number.",
            message_desc: "Signup successful. OTP sent to your mobile number.",
            data: publicUser(user),
        });
    } catch (e) {
        console.error("Register error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * POST /api/user/login
 * body: { countryCode, mobileNumber }
 * Admin, coach, parent sab ke liye. OTP set karta hai. Resend OTP ke liye bhi yahi.
 */
const login = async (req, res) => {
    try {
        let { countryCode = "+972", mobileNumber = "" } = req.body;
        mobileNumber = cleanMobile(mobileNumber);

        if (!mobileNumber) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Mobile number is required.",
                message_desc: "Mobile number is required.",
                data: {},
            });
        }

        const user = await User.findOne({ countryCode, mobileNumber });
        if (!user) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Mobile number not registered with us.",
                message_desc: "Mobile number not registered with us.",
                data: {},
            });
        }

        user.otp = generateOtp();
        user.otp_generated_at = new Date();
        await user.save();

        return res.status(200).json({
            error: false,
            status: 200,
            message: "OTP sent to your mobile number.",
            message_desc: "OTP sent to your mobile number.",
            data: { countryCode, mobileNumber },
        });
    } catch (e) {
        console.error("Login error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * POST /api/user/verify-otp
 * body: { countryCode, mobileNumber, otp }
 * Signup aur login dono ke baad yahi call hoga. Sahi OTP pe token milta hai.
 */
const verifyOtp = async (req, res) => {
    try {
        let {
            countryCode = "+972",
            mobileNumber = "",
            otp = ""
        } = req.body;

        mobileNumber = cleanMobile(mobileNumber);
        otp = String(otp).trim();

        if (!mobileNumber || !otp) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Mobile number and OTP are required.",
                message_desc: "Mobile number and OTP are required.",
                data: {},
            });
        }

        const user = await User.findOne({
            countryCode,
            mobileNumber
        }).select("+otp");

        if (!user) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Mobile number not registered with us.",
                message_desc: "Mobile number not registered with us.",
                data: {},
            });
        }

        // OTP Verification
        if (USE_STATIC_OTP) {

            if (otp !== STATIC_OTP) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Invalid OTP.",
                    message_desc: "Invalid OTP.",
                    data: {},
                });
            }

        } else {

            if (!user.otp || user.otp !== otp) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Invalid OTP.",
                    message_desc: "Invalid OTP.",
                    data: {},
                });
            }

            const minutes =
                (Date.now() -
                    new Date(user.otp_generated_at).getTime()) / 60000;

            if (
                !user.otp_generated_at ||
                !Number.isFinite(minutes) ||
                minutes < 0 ||
                minutes > OTP_VALID_MINUTES
            ) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "OTP has expired. Please request a new one.",
                    message_desc: "OTP has expired. Please request a new one.",
                    data: {},
                });
            }
        }

        // Update user verification
        user.otp = "";
        user.otp_generated_at = null;
        user.otp_verify_at = new Date();
        user.is_verify = true;

        await user.save();

        // Coach data
        let coachData = {};

        if (user.role === "coach") {
            const coach = await Coach.findOne({
                userId: user._id
            }).populate("clubId", "name");

            coachData = {
                coachId: coach ? coach._id : null,
                club:
                    coach && coach.clubId
                        ? {
                            _id: coach.clubId._id,
                            name: coach.clubId.name
                        }
                        : null
            };
        }

        // Response user data
        const userData = publicUser(user);

        // Database mein admin hi rahega,
        // lekin API response mein clubAdmin jayega
        if (user.role === "admin") {
            userData.role = "clubAdmin";
        }

        return res.status(200).json({
            error: false,
            status: 200,
            message: "OTP verified successfully.",
            message_desc: "OTP verified successfully.",
            data: {
                ...userData,
                ...coachData,
                token: createToken(user)
            }
        });

    } catch (e) {
        console.error("Verify OTP error:", e);

        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};
module.exports = { register, login, verifyOtp };