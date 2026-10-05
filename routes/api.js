const express = require("express");
const router = express.Router();

const { adminAuthentication } = require("../app/middleware/authentication");
const { register, login, verifyOtp } = require("../app/controllers/api/userController");
const { createClub, listClubs, updateClub, deleteClub } = require("../app/controllers/api/clubController");
const { createCoach, listCoaches, updateCoach, deleteCoach } = require("../app/controllers/api/coachController");

router.get("/test", (req, res) => res.send("API working"));

// Auth (mobile + OTP). Register sirf admin ka, login/verify sab ka.
router.post("/user/register", register);
router.post("/user/login", login);
router.post("/user/verify-otp", verifyOtp);

// Club (sirf admin)
router.post("/user/createClub", adminAuthentication, createClub);
router.get("/user/listClubs", listClubs);
router.put("/user/updateClub/:id", adminAuthentication, updateClub);
router.delete("/user/deleteClub/:id", adminAuthentication, deleteClub);

// Coach (sirf admin)
router.post("/user/createCoach", adminAuthentication, createCoach);
router.get("/user/listCoaches", adminAuthentication, listCoaches);
router.put("/user/updateCoach/:id", adminAuthentication, updateCoach);
router.delete("/user/deleteCoach/:id", adminAuthentication, deleteCoach);

module.exports = router;
