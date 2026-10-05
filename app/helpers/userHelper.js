const validator = require("validator");
const User = require("../models/User");
const Coach = require("../models/Coach");
const ClubAdmin = require("../models/ClubAdmin");
const { ROLES } = require("./constants");
const { cleanMobile } = require("./common");

/**
 * Coach / ClubAdmin banate waqt body check karna.
 * Galat ho toh { status, message }, sahi ho toh { values }.
 */
const validatePersonInput = (body = {}) => {
    const firstname = String(body.firstname || "").trim();
    const lastname = String(body.lastname || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const countryCode = String(body.countryCode || "+972").trim();
    const mobileNumber = cleanMobile(body.mobileNumber);

    if (!firstname || !lastname) return { status: 400, message: "First name and last name are required." };
    if (!mobileNumber || mobileNumber.length < 7) return { status: 400, message: "Valid mobile number is required." };
    if (email && !validator.isEmail(email)) return { status: 400, message: "Please enter a valid email." };

    return { values: { firstname, lastname, email, countryCode, mobileNumber } };
};

/**
 * Mobile / email kisi aur user ke paas toh nahi. excludeUserId = update ke time khud ko chhodna.
 * Duplicate ho toh { status, message }, warna null.
 */
const findDuplicateUser = async ({ countryCode, mobileNumber, email, excludeUserId = null }) => {
    const notMe = excludeUserId ? { _id: { $ne: excludeUserId } } : {};

    if (mobileNumber) {
        const mobileExists = await User.findOne({ countryCode, mobileNumber, ...notMe });
        if (mobileExists) return { status: 409, message: "This mobile number is already registered." };
    }

    if (email) {
        const emailExists = await User.findOne({ email, ...notMe });
        if (emailExists) return { status: 409, message: "This email is already registered." };
    }

    return null;
};

/**
 * Update ke time User ki basic fields badalna (sirf jo body mein aayi hain).
 * Galat ho toh { status, message }, sab theek ho toh null. user.save() caller karega.
 */
const applyPersonUpdates = async (user, body = {}) => {
    const { firstname, lastname, email, countryCode, mobileNumber } = body;

    if (firstname !== undefined) {
        if (!String(firstname).trim()) return { status: 400, message: "First name cannot be empty." };
        user.firstname = String(firstname).trim();
    }

    if (lastname !== undefined) {
        if (!String(lastname).trim()) return { status: 400, message: "Last name cannot be empty." };
        user.lastname = String(lastname).trim();
    }

    if (email !== undefined) {
        const newEmail = String(email).trim().toLowerCase();
        if (newEmail && !validator.isEmail(newEmail)) return { status: 400, message: "Please enter a valid email." };
        if (newEmail) {
            const duplicate = await findDuplicateUser({ email: newEmail, excludeUserId: user._id });
            if (duplicate) return duplicate;
        }
        user.email = newEmail || undefined;
    }

    if (mobileNumber !== undefined || countryCode !== undefined) {
        const newCode = countryCode !== undefined ? String(countryCode).trim() : user.countryCode;
        const newMobile = mobileNumber !== undefined ? cleanMobile(mobileNumber) : user.mobileNumber;

        if (!newMobile || newMobile.length < 7) return { status: 400, message: "Valid mobile number is required." };

        const duplicate = await findDuplicateUser({ countryCode: newCode, mobileNumber: newMobile, excludeUserId: user._id });
        if (duplicate) return duplicate;

        user.countryCode = newCode;
        user.mobileNumber = newMobile;
    }

    return null;
};

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
 * Role ke hisaab se extra data (verify-otp aur profile mein):
 * coach     -> coachId + club
 * clubAdmin -> clubAdminId + club
 */
const getRoleData = async (user) => {
    if (user.role === ROLES.COACH) {
        const coach = await Coach.findOne({ userId: user._id }).populate("clubId", "name logo theme");
        return {
            coachId: coach ? coach._id : null,
            club: coach && coach.clubId ? coach.clubId : null,
        };
    }

    if (user.role === ROLES.CLUB_ADMIN) {
        const clubAdmin = await ClubAdmin.findOne({ userId: user._id }).populate("clubId", "name logo theme");
        return {
            clubAdminId: clubAdmin ? clubAdmin._id : null,
            club: clubAdmin && clubAdmin.clubId ? clubAdmin.clubId : null,
        };
    }

    return {};
};

module.exports = { validatePersonInput, findDuplicateUser, applyPersonUpdates, publicUser, getRoleData };
