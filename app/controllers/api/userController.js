const jwt = require("jsonwebtoken");
const validator = require("validator");
const User = require("../../models/User");
const { ROLES, USE_STATIC_OTP, STATIC_OTP, OTP_VALID_MINUTES } = require("../../helpers/constants");
const { cleanMobile } = require("../../helpers/common");
const { publicUser, getRoleData } = require("../../helpers/userHelper");
const Parent = require("../../models/Parent");
const Club = require("../../models/Club");
const ClubAdmin = require("../../models/ClubAdmin");
const Coach = require("../../models/Coach");
const Player = require("../../models/Player");


// Abhi OTP hamesha 0000. SMS lagane pe yahan random OTP banake SMS bhejna.
const generateOtp = () => STATIC_OTP;

const createToken = (user) =>
    jwt.sign({ id: user._id, role: user.role }, process.env.JWTKEY, {
        algorithm: "HS256",
        expiresIn: "180d",
    });

// Club ka ek hi format, har API mein same: { _id, clubCode, name, theme }
const formatClub = (club) =>
    club && club._id
        ? {
              _id: club._id,
              clubCode: club.clubCode || "",
              name: club.name || "",
              theme: club.theme || {},
          }
        : null;

const CLUB_FIELDS = "_id clubCode name theme";

const getParentClub = async (userId) => {
    const parent = await Parent.findOne({ userId }).populate("clubId", CLUB_FIELDS);
    return formatClub(parent?.clubId);
};

/**
 * User kis club ka hai (role ke hisaab se sahi model se). superAdmin ya club na mile toh null.
 *   parent              -> Parent
 *   clubAdmin           -> ClubAdmin
 *   coach               -> Coach
 *   seniorPlayer / youthPlayer -> Player
 */
const getUserClub = async (user) => {
    let record = null;
    switch (user.role) {
        case ROLES.PARENT:
            return getParentClub(user._id);
        case ROLES.CLUB_ADMIN:
            record = await ClubAdmin.findOne({ userId: user._id }).populate("clubId", CLUB_FIELDS);
            break;
        case ROLES.COACH:
            record = await Coach.findOne({ userId: user._id }).populate("clubId", CLUB_FIELDS);
            break;
        case ROLES.SENIOR_PLAYER:
        case ROLES.YOUTH_PLAYER:
            record = await Player.findOne({ userId: user._id }).populate("clubId", CLUB_FIELDS);
            break;
        default:
            return null; // superAdmin ka koi ek club nahi
    }
    return formatClub(record?.clubId);
};

// Login response ke liye: getRoleData ka baaki data + club hamesha same format mein
const buildRoleData = async (user) => {
    const roleData = user.role === ROLES.PARENT ? {} : (await getRoleData(user)) || {};
    roleData.club = await getUserClub(user);
    return roleData;
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
 * Parent registration: naam + mobile + club code (+ email optional). Mobile par OTP jaata hai.
 * Club isi step mein jud jaata hai, alag se selectClub ki zaroorat nahi.
 * body: { firstname, lastname, countryCode, mobileNumber, clubCode, email?, device_type?, device_token? }
 */
const registerParent = async (req, res) => {
    let createdUserId = null;
    try {
        let {
            firstname = "",
            lastname = "",
            email = "",
            countryCode = "+972",
            mobileNumber = "",
            clubCode = "",
            device_type = "",
            device_token = "",
        } = req.body || {};

        firstname = String(firstname).trim();
        lastname = String(lastname).trim();
        email = String(email).trim().toLowerCase();
        countryCode = String(countryCode).trim();
        mobileNumber = cleanMobile(mobileNumber);
        clubCode = String(clubCode).trim().toUpperCase();

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

        if (!clubCode) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Club code is required.",
                message_desc: "Club code is required.",
                data: {},
            });
        }

        // ---- 2. Club code sahi hai? (User banane se pehle) ----
        const club = await Club.findOne({ clubCode }).select(CLUB_FIELDS);
        if (!club) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Invalid club code.",
                message_desc: "Invalid club code.",
                data: {},
            });
        }

        // ---- 3. Mobile pehle se registered? ----
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
            // Unverified parent ne dobara try kiya → wahi record, naye naam/email/club + naya OTP
        }

        // ---- 4. Email kisi aur ka toh nahi (apne unverified record ko chhod ke) ----
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

        // ---- 5. User save (naya ya purana unverified) ----
        if (!user) {
            user = new User({
                countryCode,
                mobileNumber,
                role: ROLES.PARENT, // body se role nahi lete
            });
            createdUserId = user._id;
        }

        user.firstname = firstname;
        user.lastname = lastname;
        user.email = email || undefined; // khaali email save nahi karna
        user.device_type = device_type;
        user.device_token = device_token;
        user.otp = generateOtp();
        user.otp_generated_at = new Date();
        await user.save();

        // ---- 6. Parent ko club se jodo ----
        // Unverified parent ne dobara register kiya aur club badla → naya club (abhi verify nahi hua, safe)
        const parent = await Parent.findOne({ userId: user._id });
        if (parent) {
            if (String(parent.clubId) !== String(club._id)) {
                parent.clubId = club._id;
                await parent.save();
            }
        } else {
            await Parent.create({ userId: user._id, clubId: club._id, createdBy: user._id }); // self-join
        }

        return res.status(201).json({
            error: false,
            status: 201,
            message: "OTP sent to your mobile number.",
            message_desc: "OTP sent to your mobile number.",
            data: {
                firstname,
                lastname,
                email,
                countryCode,
                mobileNumber,
                club: formatClub(club),
            },
        });
    } catch (e) {
        // Naya User bana tha aur aage fail hua toh hata do (adhoora account na bache)
        if (createdUserId) {
            await Parent.deleteOne({ userId: createdUserId }).catch(() => {});
            await User.findByIdAndDelete(createdUserId).catch(() => {});
        }
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
 * Profile edit: firstname, lastname, email (optional).
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

        let { firstname = "", lastname = "", email = "" } = req.body || {};
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
 * Sahi OTP pe token milta hai, saath mein club { _id, clubCode, name, theme } (har role ke liye, superAdmin ko null).
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

        // Club details (id, code, name, theme) har role ke liye same format mein
        const roleData = await buildRoleData(user);

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
 * App/panel refresh pe user ki latest details + club { _id, clubCode, name, theme }.
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

        const roleData = await buildRoleData(user);

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