// Saare roles ek jagah. Kahin bhi role ka naam likhna ho toh yahin se lo.
// Key code mein use hoti hai (ROLES.SUPER_ADMIN), value DB mein save hoti hai ("superAdmin").
const ROLES = {
    SUPER_ADMIN: "superAdmin",     // Poore department ka head: clubs banata hai, saare clubs dekhta hai
    CLUB_ADMIN: "clubAdmin",       // Ek club ka manager: apne club ke coaches/teams/players
    COACH: "coach",                // Mobile app: apni team
    STAFF: "staff",                // Club staff (permissions abhi decide hone hain)
    SENIOR_PLAYER: "seniorPlayer", // Senior player: khud mobile + OTP se login, koi parent nahi
    YOUTH_PLAYER: "youthPlayer",   // Youth player: parent ke under, mobile optional
    PARENT: "parent",              // Youth player ka maa/baap: mobile app pe apne bachche
};

// Abhi testing ke liye: true rehne tak har user ka OTP "0000" chalega.
// Twilio / SMS service lagane ke baad false kar dena.
const USE_STATIC_OTP = true;
const STATIC_OTP = "0000";
const OTP_VALID_MINUTES = 10;

// OTP ka misuse rokna (SMS bomb / brute force), per user
const OTP_MAX_REQUESTS = 10; // itne OTP request ek window mein
const OTP_REQUEST_WINDOW_MINUTES = 10;
const OTP_MAX_FAILED_ATTEMPTS = 5; // itni galat OTP ke baad lock
const OTP_LOCK_MINUTES = 15;

module.exports = {
    ROLES,
    USE_STATIC_OTP,
    STATIC_OTP,
    OTP_VALID_MINUTES,
    OTP_MAX_REQUESTS,
    OTP_REQUEST_WINDOW_MINUTES,
    OTP_MAX_FAILED_ATTEMPTS,
    OTP_LOCK_MINUTES,
};