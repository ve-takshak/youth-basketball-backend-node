// Saare roles ek jagah. Kahin bhi role ka naam likhna ho toh yahin se lo.
// Key code mein use hoti hai (ROLES.SUPER_ADMIN), value DB mein save hoti hai ("superAdmin").
const ROLES = {
    SUPER_ADMIN: "superAdmin",     // Poore department ka head: clubs banata hai, saare clubs dekhta hai
    CLUB_ADMIN: "clubAdmin",       // Ek club ka manager: apne club ke coaches/teams/players
    COACH: "coach",                // Mobile app: apni team
    STAFF: "staff",                // Club staff (permissions abhi decide hone hain)
    SENIOR_PLAYER: "seniorPlayer", // Adult player, khud login (aage)
    YOUTH_PLAYER: "youthPlayer",   // Youth player, parent ke under (aage)
    PARENT: "parent",              // Mobile app: apne bachche
};

// Abhi testing ke liye: true rehne tak har user ka OTP "0000" chalega.
// Twilio / SMS service lagane ke baad false kar dena.
const USE_STATIC_OTP = true;
const STATIC_OTP = "0000";
const OTP_VALID_MINUTES = 10;

module.exports = { ROLES, USE_STATIC_OTP, STATIC_OTP, OTP_VALID_MINUTES };
