const express = require("express");
const router = express.Router();

const {
    authentication,
    superAdminAuthentication,
    superAdminOrClubAdminAuthentication,
    requireTermsAccepted,
} = require("../app/middleware/authentication");

const { register, login, verifyOtp, getProfile, resendOtp, registerParent, updateParentProfile, updateProfile } = require("../app/controllers/api/userController");
const { createClub, listClubs, getClub, getDashboardSummary, updateClub, deleteClub, restoreClub, clubOptions } = require("../app/controllers/api/clubController");
const {
    createClubAdmin,
    listClubAdmins,
    getClubAdmin,
    updateClubAdmin,
    deleteClubAdmin,
} = require("../app/controllers/api/clubAdminController");
const { createCoach, listCoaches, getCoach, updateCoach, deleteCoach } = require("../app/controllers/api/coachController");
const {
    createTeamCategory,
    listTeamCategories,
    getTeamCategory,
    updateTeamCategory,
    deleteTeamCategory,
} = require("../app/controllers/api/teamCategoryController");
const {
    createTeam,
    listTeams,
    getTeam,
    updateTeam,
    deleteTeam,
} = require("../app/controllers/api/teamController");
const {
    createPlayer,
    createCoachPlayer,
    listCoachPlayers,
    getCoachPlayer,
    updateCoachPlayer,
    deleteCoachPlayer,
    listPlayers,
    getPlayer,
    updatePlayer,
    deletePlayer,
    listShirtSizes,
    listShirtNumbers,
    listOtherTeamPlayers,
    assignPlayerToTeam,
    removePlayerFromTeam,
    listUnassignedPlayers,
    getSizeSummary,
} = require("../app/controllers/api/Playercontroller");
const { removeProfileImage, updateProfileImage } = require("../app/controllers/api/Profileimagecontroller");
const {
    selectParentClub,
    createYouthPlayer,
    listMyYouthPlayers,
    getMyYouthPlayer,
    updateMyYouthPlayer,
    deleteMyYouthPlayer,
} = require("../app/controllers/api/parentController");
const {
    listParents,
    getParent,
    updateParent,
    deleteParent,
    linkParentToPlayer,
    unlinkParentFromPlayer,
} = require("../app/controllers/api/admin/Adminparentcontroller");
const { createFacility, listFacilities, getFacility, deleteFacility, updateFacility } = require("../app/controllers/api/facilitysController");
const { listClubTerms, getClubTermsVersion, createClubTerms, getCurrentTerms, acceptTerms } = require("../app/controllers/api/termsController");
const { getCoachDashboard } = require("../app/controllers/api/dashbaordController");
const {
    createSchedule,
    listSchedules,
    listSentSchedules,
    getSchedule,
    updateSchedule,
    deleteSchedule,
    sendSchedule,
    listCoachSchedules,
    getCoachSchedule,
    listPlayerSchedules,
    getPlayerSchedule,
    listParentSchedules,
    getParentSchedule,
} = require("../app/controllers/api/scheduleController");
const { createNote, updateNote, deleteNote, listCoachNotes, listPlayerNotes, getNote } = require("../app/controllers/api/Notecontroller");

const {
    listPaymentProviders,
    getPaymentGateway,
    savePaymentGateway,
    testPaymentGateway,
    updatePaymentSettings,
} = require("../app/controllers/api/paymentGatewayController");
const {
    issueCharges,
    listCharges,
    getPaymentsSummary,
    getCharge,
    updateCharge,
    markChargePaid,
    cancelCharge,
    refundCharge,
    getChargeReceipt,
    getTeamPaymentStatus,
} = require("../app/controllers/api/chargeController");
const { listFeePlans, createFeePlan, getFeePlan, updateFeePlan, deleteFeePlan } = require("../app/controllers/api/feePlanController");
const { listMyPayments, checkoutCharge, getMyReceipt } = require("../app/controllers/api/parentPaymentController");
const { paymentWebhook, paymentReturn } = require("../app/controllers/api/paymentWebhookController");

router.get("/test", (req, res) => res.send("API working"));

// ---------- Auth (mobile + OTP) ----------
router.post("/user/register", register);            // sirf superAdmin signup
router.post("/user/login", login);                  // sab roles
router.post("/user/verify-otp", verifyOtp);         // sab roles, token yahin milta hai
router.post("/user/resend-otp", resendOtp);
router.get("/user/profile", authentication, getProfile);
router.put("/user/profile", superAdminOrClubAdminAuthentication, updateProfile); // web panel: apni profile edit

router.put("/user/:userId/profile-image", authentication, updateProfileImage);
router.delete("/user/:userId/profile-image", authentication, removeProfileImage);

// ---------- Club ----------
router.post("/user/createClub", superAdminAuthentication, createClub);
router.get("/user/listClubs", superAdminOrClubAdminAuthentication, listClubs);   // clubAdmin ko sirf apna club
router.get("/user/getClub/:id", superAdminOrClubAdminAuthentication, getClub);
router.put("/user/updateClub/:id", superAdminAuthentication, updateClub);
router.delete("/user/deleteClub/:id", superAdminAuthentication, deleteClub);
router.put("/user/restoreClub/:id", superAdminAuthentication, restoreClub);
router.get("/user/dashboard/summary", superAdminOrClubAdminAuthentication, getDashboardSummary);

// ---------- Club Terms & Conditions ----------
router.get("/user/clubs/:id/terms", superAdminOrClubAdminAuthentication, listClubTerms);            // versions + current, clubAdmin apne club ka
router.get("/user/clubs/:id/terms/:version", superAdminOrClubAdminAuthentication, getClubTermsVersion);
router.post("/user/clubs/:id/terms", superAdminOrClubAdminAuthentication, createClubTerms);         // naya version
router.get("/user/terms/current", authentication, getCurrentTerms);                                  // parent: apne club ke terms
router.post("/user/terms/accept", authentication, acceptTerms);                                      // parent: accept
router.get("/user/clubOptions", clubOptions);                                    // bina token (parent registration)

// ---------- Club Admin (sirf superAdmin banata hai) ----------
router.post("/user/createClubAdmin", superAdminAuthentication, createClubAdmin);
router.get("/user/listClubAdmins", superAdminAuthentication, listClubAdmins);
router.get("/user/getClubAdmin/:id", superAdminAuthentication, getClubAdmin);
router.put("/user/updateClubAdmin/:id", superAdminAuthentication, updateClubAdmin);
router.delete("/user/deleteClubAdmin/:id", superAdminAuthentication, deleteClubAdmin);

// ---------- Coaches ----------
router.post("/user/coaches/create", superAdminOrClubAdminAuthentication, createCoach);
router.get("/user/coaches", authentication, listCoaches);
router.get("/user/coaches/:id", authentication, getCoach);
router.put("/user/coaches/:id/update", authentication, updateCoach);
router.delete("/user/coaches/:id/delete", superAdminOrClubAdminAuthentication, deleteCoach);

// ---------- Team categories ----------
// Banana/badalna sirf superAdmin, dekhna koi bhi logged-in user (team form ke dropdown ke liye)
router.post("/user/teams/categories/create", superAdminAuthentication, createTeamCategory);
router.get("/user/teams/categories", authentication, listTeamCategories);
router.get("/user/teams/categories/:id", authentication, getTeamCategory);
router.put("/user/teams/categories/:id/update", superAdminAuthentication, updateTeamCategory);
router.delete("/user/teams/categories/:id/delete", superAdminAuthentication, deleteTeamCategory);

// ---------- Teams ----------
router.post("/user/teams/create", superAdminOrClubAdminAuthentication, createTeam);
router.get("/user/teams", authentication, listTeams);
router.get("/user/teams/:id", authentication, getTeam);
router.put("/user/teams/:id/update", superAdminOrClubAdminAuthentication, updateTeam);
router.delete("/user/teams/:id/delete", superAdminOrClubAdminAuthentication, deleteTeam);
router.get("/user/teams/:id/shirt-numbers", superAdminOrClubAdminAuthentication, listShirtNumbers);
router.get("/user/teams/:id/other-players", superAdminOrClubAdminAuthentication, listOtherTeamPlayers);
router.put("/user/teams/:id/players/:playerId/remove", superAdminOrClubAdminAuthentication, removePlayerFromTeam);

// ---------- Players (admin) ----------
// Fixed paths (shirt-sizes, unassigned, assign) ":id" se PEHLE
router.get("/user/players/shirt-sizes", listShirtSizes);
router.get("/user/players/unassigned", superAdminOrClubAdminAuthentication, listUnassignedPlayers);
router.get("/user/players/sizes", superAdminOrClubAdminAuthentication, getSizeSummary);
router.post("/user/players/assign", superAdminOrClubAdminAuthentication, assignPlayerToTeam);
router.post("/user/players/create", superAdminOrClubAdminAuthentication, createPlayer);
router.get("/user/players", authentication, listPlayers); // coach bhi, sirf apni teams ke players
router.get("/user/players/:id", authentication, getPlayer); // coach bhi, sirf apni team ka player
router.put("/user/players/:id/update", superAdminOrClubAdminAuthentication, updatePlayer);
router.delete("/user/players/:id/delete", superAdminOrClubAdminAuthentication, deletePlayer);

// ---------- Coach (mobile app): apni team ke players ka CRUD ----------
router.post("/user/coach/players/create", authentication, createCoachPlayer);
router.get("/user/coach/players", authentication, listCoachPlayers);
router.get("/user/coach/players/:id", authentication, getCoachPlayer);
router.put("/user/coach/players/:id/update", authentication, updateCoachPlayer);
router.delete("/user/coach/players/:id/delete", authentication, deleteCoachPlayer);

// Player ke parents (admin: link / unlink)
router.post("/user/players/:id/parents/link", superAdminOrClubAdminAuthentication, linkParentToPlayer);
router.delete("/user/players/:id/parents/:parentId/unlink", superAdminOrClubAdminAuthentication, unlinkParentFromPlayer);

// ---------- Parents (admin panel) ----------
router.get("/user/parents", superAdminOrClubAdminAuthentication, listParents);
router.get("/user/parents/:id", superAdminOrClubAdminAuthentication, getParent);
router.put("/user/parents/:id/update", superAdminOrClubAdminAuthentication, updateParent);
router.delete("/user/parents/:id/delete", superAdminOrClubAdminAuthentication, deleteParent);

// ---------- Parent (mobile app) ----------
router.post("/user/parent/register", registerParent);
router.put("/user/parent/profile", authentication, updateParentProfile);
router.post("/user/parent/selectClub", authentication, selectParentClub);
router.post("/user/parent/players/create", authentication, requireTermsAccepted, createYouthPlayer);
router.get("/user/parent/listMyYouthPlayers", authentication, requireTermsAccepted, listMyYouthPlayers);
router.get("/user/parent/players/:id", authentication, requireTermsAccepted, getMyYouthPlayer);
router.put("/user/parent/players/:id/update", authentication, requireTermsAccepted, updateMyYouthPlayer);
router.delete("/user/parent/players/:id/delete", authentication, requireTermsAccepted, deleteMyYouthPlayer);


// ---------- Facilities ----------
router.post("/user/facilities/create", superAdminOrClubAdminAuthentication, createFacility);
router.get("/user/facilities", superAdminOrClubAdminAuthentication, listFacilities);
router.get("/user/facilities/:id", superAdminOrClubAdminAuthentication, getFacility);
router.put("/user/facilities/:id/update", superAdminOrClubAdminAuthentication, updateFacility);
router.delete("/user/facilities/:id/delete", superAdminOrClubAdminAuthentication, deleteFacility);

// ---------- Schedule ----------
// Admin panel. "send" / "sent" ":id" se PEHLE.
router.post("/user/schedules/send", superAdminOrClubAdminAuthentication, sendSchedule);
router.get("/user/schedules/sent", superAdminOrClubAdminAuthentication, listSentSchedules);
router.post("/user/schedules/create", superAdminOrClubAdminAuthentication, createSchedule);
router.get("/user/schedules", superAdminOrClubAdminAuthentication, listSchedules);
router.get("/user/schedules/:id", superAdminOrClubAdminAuthentication, getSchedule);
router.put("/user/schedules/:id/update", superAdminOrClubAdminAuthentication, updateSchedule);
router.delete("/user/schedules/:id/delete", superAdminOrClubAdminAuthentication, deleteSchedule);

// Mobile app: har role ki apni API, sirf bheje gaye (published) schedules
router.get("/user/coach/schedules", authentication, listCoachSchedules);
router.get("/user/coach/schedules/:id", authentication, getCoachSchedule);
router.get("/user/player/schedules", authentication, listPlayerSchedules);
router.get("/user/player/schedules/:id", authentication, getPlayerSchedule);
router.get("/user/parent/schedules", authentication, requireTermsAccepted, listParentSchedules);
router.get("/user/parent/schedules/:id", authentication, requireTermsAccepted, getParentSchedule);

router.get("/user/coach/dashboard", authentication, getCoachDashboard);

// ---------- Notes (coach + player) ----------
router.post("/user/notes/create", authentication, createNote);
router.get("/user/notes/coach", authentication, listCoachNotes);
router.get("/user/notes/player", authentication, listPlayerNotes);
router.get("/user/notes/:id", authentication, getNote);
router.put("/user/notes/:id/update", authentication, updateNote);
router.delete("/user/notes/:id/delete", authentication, deleteNote);

// ---------- Payment gateway (club admin / super admin) ----------
router.get("/user/payments/providers", superAdminOrClubAdminAuthentication, listPaymentProviders);
router.get("/user/clubs/:id/payment-gateway", superAdminOrClubAdminAuthentication, getPaymentGateway);
router.put("/user/clubs/:id/payment-gateway", superAdminOrClubAdminAuthentication, savePaymentGateway);
router.post("/user/clubs/:id/payment-gateway/test", superAdminOrClubAdminAuthentication, testPaymentGateway); // test console, koi charge nahi
router.put("/user/clubs/:id/payment-settings", superAdminOrClubAdminAuthentication, updatePaymentSettings);

// ---------- Fee plans / price list (club admin / super admin) ----------
router.get("/user/payments/fee-plans", superAdminOrClubAdminAuthentication, listFeePlans);
router.post("/user/payments/fee-plans", superAdminOrClubAdminAuthentication, createFeePlan); // club admin price set karta hai
router.get("/user/payments/fee-plans/:id", superAdminOrClubAdminAuthentication, getFeePlan); // + Standing Order preview
router.put("/user/payments/fee-plans/:id", superAdminOrClubAdminAuthentication, updateFeePlan); // purane bills nahi badalte
router.delete("/user/payments/fee-plans/:id", superAdminOrClubAdminAuthentication, deleteFeePlan); // bills bane hon toh sirf band

// ---------- Payments (club admin / super admin) ----------
// Fixed paths (issue, summary) ":id" se PEHLE
router.post("/user/payments/charges/issue", superAdminOrClubAdminAuthentication, issueCharges);
router.get("/user/payments/summary", superAdminOrClubAdminAuthentication, getPaymentsSummary);
router.get("/user/payments/charges", superAdminOrClubAdminAuthentication, listCharges);
router.get("/user/payments/charges/:id", superAdminOrClubAdminAuthentication, getCharge);
router.put("/user/payments/charges/:id", superAdminOrClubAdminAuthentication, updateCharge); // ek player ki alag fee (pay se pehle)
router.put("/user/payments/charges/:id/mark-paid", superAdminOrClubAdminAuthentication, markChargePaid);
router.put("/user/payments/charges/:id/cancel", superAdminOrClubAdminAuthentication, cancelCharge);
router.post("/user/payments/charges/:id/refund", superAdminOrClubAdminAuthentication, refundCharge);
router.get("/user/payments/charges/:id/receipt", superAdminOrClubAdminAuthentication, getChargeReceipt);
router.get("/user/teams/:id/payment-status", authentication, getTeamPaymentStatus); // roster badges, coach bhi

// ---------- Payments (parent mobile app) ----------
router.get("/user/parent/payments", authentication, listMyPayments);
router.post("/user/parent/payments/:id/checkout", authentication, checkoutCharge); // Tranzila page ka URL deta hai
router.get("/user/parent/payments/:id/receipt", authentication, getMyReceipt);

// ---------- Payment gateway callbacks (bina token) ----------
router.post("/payments/webhook/:gatewayId/:key", paymentWebhook); // Tranzila notify
router.get("/payments/return", paymentReturn);

module.exports = router;