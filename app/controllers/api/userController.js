const jwt = require("jsonwebtoken");
const validator = require("validator");
const User = require("../../models/User");
const { ROLES, USE_STATIC_OTP, STATIC_OTP, OTP_VALID_MINUTES } = require("../../helpers/constants");
const { cleanMobile } = require("../../helpers/common");
const { publicUser, getRoleData } = require("../../helpers/userHelper");
const Parent = require("../../models/Parent");

// Abhi OTP hamesha 0000. SMS lagane pe yahan random OTP banake SMS bhejna.
const generateOtp = () => STATIC_OTP;

const createToken = (user) =>
    jwt.sign({ id: user._id, role: user.role }, process.env.JWTKEY, {
        algorithm: "HS256",
        expiresIn: "180d",
    });

const getParentClub = async (userId) => {
    const parent = await Parent.findOne({ userId }).populate("clubId", "_id clubCode name theme");
    return parent?.clubId
        ? {
              _id: parent.clubId._id,
              clubCode: parent.clubId.clubCode || "",
              name: parent.clubId.name,
              theme: parent.clubId.theme,
          }
        : null;
};

/**
 * POST /api/user/register
 * Sirf SUPER ADMIN ka signup. ClubAdmin aur Coach yahan se nahi bante, unhe superAdmin/clubAdmin banata hai.
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
            role: ROLES.SUPER_ADMIN, // body se role nahi lete
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
 * POST /api/user/parent/register
 * Parent registration: naam + mobile (+ email optional). Mobile par OTP jaata hai.
 * body: { firstname, lastname, countryCode, mobileNumber, email?, device_type?, device_token? }
 */
const registerParent = async (req, res) => {
    try {
        let {
            firstname = "",
            lastname = "",
            email = "",
            countryCode = "+972",
            mobileNumber = "",
            device_type = "",
            device_token = "",
        } = req.body || {};

        firstname = String(firstname).trim();
        lastname = String(lastname).trim();
        email = String(email).trim().toLowerCase();
        countryCode = String(countryCode).trim();
        mobileNumber = cleanMobile(mobileNumber);

        // ---- 1. Fields check ----
        if (!firstname || !lastname) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "First name and last name are required.",
                message_desc: "First name and last name are required.",
                data: {},
            });
        }

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

        // ---- 2. Mobile pehle se registered? ----
        let user = await User.findOne({ countryCode, mobileNumber });

        if (user) {
            // Verified user ya koi aur role (coach, clubAdmin...) → login karega, register nahi
            if (user.role !== ROLES.PARENT || user.is_verify) {
                return res.status(409).json({
                    error: true,
                    status: 409,
                    message: "This mobile number is already registered. Please login.",
                    message_desc: "This mobile number is already registered. Please login.",
                    data: {},
                });
            }
            // Unverified parent ne dobara try kiya → wahi record, naye naam/email + naya OTP
        }

        // ---- 3. Email kisi aur ka toh nahi (apne unverified record ko chhod ke) ----
        if (email) {
            const emailExists = await User.findOne({
                email,
                ...(user ? { _id: { $ne: user._id } } : {}),
            });
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

        // ---- 4. Naya parent ya purana unverified record update ----
        if (!user) {
            user = new User({
                countryCode,
                mobileNumber,
                role: ROLES.PARENT, // body se role nahi lete
            });
        }

        user.firstname = firstname;
        user.lastname = lastname;
        user.email = email || undefined; // khaali email save nahi karna
        user.device_type = device_type;
        user.device_token = device_token;
        user.otp = generateOtp();
        user.otp_generated_at = new Date();
        await user.save();

        return res.status(201).json({
            error: false,
            status: 201,
            message: "OTP sent to your mobile number.",
            message_desc: "OTP sent to your mobile number.",
            data: { firstname, lastname, email, countryCode, mobileNumber },
        });
    } catch (e) {
        // Do request ek saath (double tap) ya same email / mobile
        if (e.code === 11000) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "This mobile number or email is already registered.",
                message_desc: "This mobile number or email is already registered.",
                data: {},
            });
        }
        console.error("Register parent error:", e);
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
 * PUT /api/user/parent/profile   (logged-in parent, token zaroori)
 * Registration form: firstname, lastname, email (optional).
 * body: { firstname, lastname, email? }
 */
const updateParentProfile = async (req, res) => {
    try {
        // req.user mongoose document hona chahiye taaki save() chale
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "User not found.",
                message_desc: "User not found.",
                data: {},
            });
        }

        if (user.role !== ROLES.PARENT) {
            return res.status(403).json({
                error: true,
                status: 403,
                message: "Only parents can use this.",
                message_desc: "Only parents can use this.",
                data: {},
            });
        }

        let { firstname = "", lastname = "", email = "" } = req.body;
        firstname = String(firstname).trim();
        lastname = String(lastname).trim();
        email = String(email).trim().toLowerCase();

        if (!firstname || !lastname) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "First name and last name are required.",
                message_desc: "First name and last name are required.",
                data: {},
            });
        }

        if (email) {
            if (!validator.isEmail(email)) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Please enter a valid email.",
                    message_desc: "Please enter a valid email.",
                    data: {},
                });
            }

            // Apna khud ka email dobara bhejne pe error na aaye, isliye $ne
            const emailExists = await User.findOne({ email, _id: { $ne: user._id } });
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

        user.firstname = firstname;
        user.lastname = lastname;
        user.email = email || undefined; // khaali email save nahi karna
        await user.save();

         const club = await getParentClub(user._id);

         return res.status(200).json({
            error: false,
            status: 200,
            message: "Profile saved successfully.",
            message_desc: "Profile saved successfully.",
            data: { ...publicUser(user), isProfileComplete: true, club },
        });
    } catch (e) {
        console.error("Update parent profile error:", e);
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
 * Sab roles ke liye. OTP set karta hai. Resend OTP ke liye bhi yahi.
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
 * body: { countryCode, mobileNumber, otp, device_type?, device_token? }
 * Sahi OTP pe token milta hai, saath mein club (coach/clubAdmin/parent).
 */
const verifyOtp = async (req, res) => {
    try {
        let { countryCode = "+972", mobileNumber = "", otp = "", device_type, device_token } = req.body;
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

        if (device_type !== undefined && !["android", "ios", "web", ""].includes(device_type)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid device type.",
                message_desc: "Invalid device type.",
                data: {},
            });
        }

        const user = await User.findOne({ countryCode, mobileNumber }).select("+otp");
        if (!user) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Mobile number not registered with us.",
                message_desc: "Mobile number not registered with us.",
                data: {},
            });
        }

        if (USE_STATIC_OTP) {
            // Testing: sirf "0000" check
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
            // Asli SMS wala flow: DB wala OTP match + expiry
            if (!user.otp || user.otp !== otp) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Invalid OTP.",
                    message_desc: "Invalid OTP.",
                    data: {},
                });
            }

            const minutes = (Date.now() - new Date(user.otp_generated_at).getTime()) / 60000;
            if (minutes > OTP_VALID_MINUTES) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "OTP has expired. Please request a new one.",
                    message_desc: "OTP has expired. Please request a new one.",
                    data: {},
                });
            }
        }

        user.otp = "";
        user.otp_generated_at = null;
        user.otp_verify_at = new Date();
        user.is_verify = true;
        if (device_type !== undefined) user.device_type = device_type;
        if (device_token !== undefined) user.device_token = device_token;
        await user.save();

        let roleData = {};

        if (user.role === ROLES.PARENT) {
            // Parent ka club Parent model se
            const parent = await Parent.findOne({ userId: user._id })
                .populate("clubId", "_id clubCode name theme");

            roleData.club = parent?.clubId
                ? {
                    _id: parent.clubId._id,
                    clubCode: parent.clubId.clubCode || "",
                    name: parent.clubId.name,
                    theme: parent.clubId.theme,
                }
                : null;
        } else {
            // Coach / clubAdmin ka club pehle jaisa getRoleData se
            roleData = await getRoleData(user);
        }

        return res.status(200).json({
            error: false,
            status: 200,
            message: "OTP verified successfully.",
            message_desc: "OTP verified successfully.",
            data: {
                ...publicUser(user),
                ...roleData,
                token: createToken(user),
            },
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

const resendOtp = async (req, res) => {
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
            message: "OTP resent to your mobile number.",
            message_desc: "OTP resent to your mobile number.",
            data: { countryCode, mobileNumber },
        });
    } catch (e) {
        console.error("Resend OTP error:", e);
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
 * GET /api/user/profile   (koi bhi logged-in user)
 * App/panel refresh pe user ki latest details + club (coach/clubAdmin/parent).
 */
const getProfile = async (req, res) => {
    try {
        // DB se fresh user, taaki abhi abhi hua update (naam, club) bhi dikhe
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(401).json({
                error: true,
                status: 401,
                message: "Account not found. Please login again.",
                message_desc: "Account not found. Please login again.",
                data: {},
            });
        }

        let roleData = {};

        if (user.role === ROLES.PARENT) {
            // Parent ka club Parent model se
            const parent = await Parent.findOne({ userId: user._id })
                .populate("clubId", "_id clubCode name theme");

            roleData.club = parent?.clubId
                ? {
                    _id: parent.clubId._id,
                    clubCode: parent.clubId.clubCode || "",
                    name: parent.clubId.name,
                    theme: parent.clubId.theme,
                }
                : null;
        } else {
            // Coach / clubAdmin ka club pehle jaisa getRoleData se
            roleData = await getRoleData(user);
        }

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Profile fetched successfully.",
            message_desc: "Profile fetched successfully.",
            data: {
                ...publicUser(user),
                ...roleData,
            },
        });
    } catch (e) {
        console.error("Get profile error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};
module.exports = { register, login, verifyOtp, getProfile, resendOtp, registerParent, updateParentProfile };
