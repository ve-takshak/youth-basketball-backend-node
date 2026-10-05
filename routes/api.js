const express = require("express");
const router = express.Router();

const {
    authentication,
    superAdminAuthentication,
    superAdminOrClubAdminAuthentication,
} = require("../app/middleware/authentication");

const { register, login, verifyOtp, getProfile } = require("../app/controllers/api/userController");
const { createClub, listClubs, getClub, updateClub, deleteClub } = require("../app/controllers/api/clubController");
const {
    createClubAdmin,
    listClubAdmins,
    getClubAdmin,
    updateClubAdmin,
    deleteClubAdmin,
} = require("../app/controllers/api/clubAdminController");
const { createCoach, listCoaches, getCoach, updateCoach, deleteCoach } = require("../app/controllers/api/coachController");

router.get("/test", (req, res) => res.send("API working"));

// ---------- Auth (mobile + OTP) ----------
router.post("/user/register", register);            // sirf superAdmin signup
router.post("/user/login", login);                  // sab roles
router.post("/user/verify-otp", verifyOtp);         // sab roles, token yahin milta hai
router.get("/user/profile", authentication, getProfile);

// ---------- Club ----------
router.post("/user/createClub", superAdminAuthentication, createClub);
router.get("/user/listClubs", superAdminOrClubAdminAuthentication, listClubs);   // clubAdmin ko sirf apna club
router.get("/user/getClub/:id", superAdminOrClubAdminAuthentication, getClub);
router.put("/user/updateClub/:id", superAdminAuthentication, updateClub);
router.delete("/user/deleteClub/:id", superAdminAuthentication, deleteClub);

// ---------- Club Admin (sirf superAdmin banata hai) ----------
router.post("/user/createClubAdmin", superAdminAuthentication, createClubAdmin);
router.get("/user/listClubAdmins", superAdminAuthentication, listClubAdmins);
router.get("/user/getClubAdmin/:id", superAdminAuthentication, getClubAdmin);
router.put("/user/updateClubAdmin/:id", superAdminAuthentication, updateClubAdmin);
router.delete("/user/deleteClubAdmin/:id", superAdminAuthentication, deleteClubAdmin);

// ---------- Coach (superAdmin ya clubAdmin; clubAdmin sirf apne club mein) ----------
router.post("/user/createCoach", superAdminOrClubAdminAuthentication, createCoach);
router.get("/user/listCoaches", superAdminOrClubAdminAuthentication, listCoaches);
router.get("/user/getCoach/:id", superAdminOrClubAdminAuthentication, getCoach);
router.put("/user/updateCoach/:id", superAdminOrClubAdminAuthentication, updateCoach);
router.delete("/user/deleteCoach/:id", superAdminOrClubAdminAuthentication, deleteCoach);

module.exports = router;
