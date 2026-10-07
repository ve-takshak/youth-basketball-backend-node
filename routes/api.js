const express = require("express");
const router = express.Router();

const {
    authentication,
    superAdminAuthentication,
    superAdminOrClubAdminAuthentication,
} = require("../app/middleware/authentication");

const { register, login, verifyOtp, getProfile, resendOtp } = require("../app/controllers/api/userController");
const { createClub, listClubs, getClub, updateClub, deleteClub } = require("../app/controllers/api/clubController");
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

router.get("/test", (req, res) => res.send("API working"));

// ---------- Auth (mobile + OTP) ----------
router.post("/user/register", register);            // sirf superAdmin signup
router.post("/user/login", login);                  // sab roles
router.post("/user/verify-otp", verifyOtp);         // sab roles, token yahin milta hai
router.post("/user/resend-otp", resendOtp);
router.get("/user/profile", authentication, getProfile);


const { uploadClubLogo } = require("../app/middleware/upload");

// ---------- Club ----------
router.post("/user/createClub", superAdminAuthentication, uploadClubLogo.single("logo"), createClub);
router.get("/user/listClubs", superAdminOrClubAdminAuthentication, listClubs);   // clubAdmin ko sirf apna club
router.get("/user/getClub/:id", superAdminOrClubAdminAuthentication, getClub);
router.put("/user/updateClub/:id", superAdminAuthentication, uploadClubLogo.single("logo"), updateClub);
router.delete("/user/deleteClub/:id", superAdminAuthentication, deleteClub);

// ---------- Club Admin (sirf superAdmin banata hai) ----------
router.post("/user/createClubAdmin", superAdminAuthentication, createClubAdmin);
router.get("/user/listClubAdmins", superAdminAuthentication, listClubAdmins);
router.get("/user/getClubAdmin/:id", superAdminAuthentication, getClubAdmin);
router.put("/user/updateClubAdmin/:id", superAdminAuthentication, updateClubAdmin);
router.delete("/user/deleteClubAdmin/:id", superAdminAuthentication, deleteClubAdmin);

// Coaches
router.post("/user/coaches/create", superAdminOrClubAdminAuthentication, createCoach);
router.get("/user/coaches", superAdminOrClubAdminAuthentication, listCoaches);
router.get("/user/coaches/:id", superAdminOrClubAdminAuthentication, getCoach);
router.put("/user/coaches/:id/update", superAdminOrClubAdminAuthentication, updateCoach);
router.delete("/user/coaches/:id/delete", superAdminOrClubAdminAuthentication, deleteCoach);

// Teams categories
router.post("/user/teams/categories/create", superAdminOrClubAdminAuthentication, createTeamCategory);
router.get("/user/teams/categories", authentication, listTeamCategories);
router.get("/user/teams/categories/:id", authentication, getTeamCategory);
router.put("/user/teams/categories/:id/update", superAdminOrClubAdminAuthentication, updateTeamCategory);
router.delete("/user/teams/categories/:id/delete", superAdminOrClubAdminAuthentication, deleteTeamCategory);

// Teams
router.post("/user/teams/create", superAdminOrClubAdminAuthentication, createTeam);
router.get("/user/teams", authentication, listTeams);
router.get("/user/teams/:id", authentication, getTeam);
router.put("/user/teams/:id/update", superAdminOrClubAdminAuthentication, updateTeam);
router.delete("/user/teams/:id/delete", superAdminOrClubAdminAuthentication, deleteTeam);

module.exports = router;
