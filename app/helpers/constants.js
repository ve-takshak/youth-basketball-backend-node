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

// .env SMS_OTP_ENABLED=true = random OTP, SMS4Free se SMS. Warna sabka OTP "000000" (testing, koi SMS nahi jaata).
const USE_STATIC_OTP = process.env.SMS_OTP_ENABLED !== "true";
const STATIC_OTP = "000000";
// SMS mode mein bhi "000000" chalne do (ek hi server pe testing). .env ALLOW_TEST_OTP=true. LIVE SE PEHLE HATANA: koi bhi kisi ka account khol sakta hai.
const ALLOW_TEST_OTP = process.env.ALLOW_TEST_OTP === "true";
const OTP_VALID_MINUTES = 10;

// OTP ka misuse rokna (SMS bomb / brute force), per user
const OTP_MAX_REQUESTS = 10; // itne OTP request ek window mein
const OTP_REQUEST_WINDOW_MINUTES = 10;
const OTP_MAX_FAILED_ATTEMPTS = 3; // har OTP pe itne galat try, phir OTP band + lock
const OTP_LOCK_MINUTES = 15;

// Dono player roles. Player sirf tab login kar sakta hai jab uske User pe mobile number ho.
const PLAYER_ROLES = [ROLES.SENIOR_PLAYER, ROLES.YOUTH_PLAYER];
const isPlayerRole = (role) => PLAYER_ROLES.includes(role);
const NO_MOBILE_PLAYER_MESSAGE = "This player has no mobile number and cannot log in. Please contact your club.";

module.exports = {
    ROLES,
    PLAYER_ROLES,
    isPlayerRole,
    NO_MOBILE_PLAYER_MESSAGE,
    USE_STATIC_OTP,
    STATIC_OTP,
    ALLOW_TEST_OTP,
    OTP_VALID_MINUTES,
    OTP_MAX_REQUESTS,
    OTP_REQUEST_WINDOW_MINUTES,
    OTP_MAX_FAILED_ATTEMPTS,
    OTP_LOCK_MINUTES,
};