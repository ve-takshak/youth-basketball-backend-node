const express = require("express");
const router = express.Router();

const {
    authentication,
    superAdminAuthentication,
    superAdminOrClubAdminAuthentication,
} = require("../app/middleware/authentication");

const { register, login, verifyOtp, getProfile, resendOtp, registerParent, updateParentProfile } = require("../app/controllers/api/userController");
const { createClub, listClubs, getClub, updateClub, deleteClub, clubOptions } = require("../app/controllers/api/clubController");
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
const { createPlayer, listPlayers, getPlayer, updatePlayer, deletePlayer, listShirtSizes, listShirtNumbers, listOtherTeamPlayers, assignPlayerToTeam, removePlayerFromTeam, listUnassignedPlayers } = require("../app/controllers/api/Playercontroller");
const { removeProfileImage, updateProfileImage } = require("../app/controllers/api/Profileimagecontroller");
const { selectParentClub, listAgeGroups, createYouthPlayer, listMyYouthPlayers, deleteMyYouthPlayer, updateMyYouthPlayer, getMyYouthPlayer } = require("../app/controllers/api/parentController");
const { listParents, updateParent, deleteParent, linkParentToPlayer, unlinkParentFromPlayer } = require("../app/controllers/api/admin/Adminparentcontroller");

router.get("/test", (req, res) => res.send("API working"));

// ---------- Auth (mobile + OTP) ----------
router.post("/user/register", register);            // sirf superAdmin signup
router.post("/user/login", login);                  // sab roles
router.post("/user/verify-otp", verifyOtp);         // sab roles, token yahin milta hai
router.post("/user/resend-otp", resendOtp);
router.get("/user/profile", authentication, getProfile);

router.put("/user/:userId/profile-image", authentication, updateProfileImage);
router.delete("/user/:userId/profile-image", authentication, removeProfileImage);

// ---------- Club ----------
router.post("/user/createClub", superAdminAuthentication, createClub);
router.get("/user/listClubs", superAdminOrClubAdminAuthentication, listClubs);   // clubAdmin ko sirf apna club
router.get("/user/getClub/:id", superAdminOrClubAdminAuthentication, getClub);
router.put("/user/updateClub/:id", superAdminAuthentication, updateClub);
router.delete("/user/deleteClub/:id", superAdminAuthentication, deleteClub);
router.get("/user/clubOptions", authentication, clubOptions);

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

// Team categories: banana/badalna sirf superAdmin, dekhna koi bhi logged-in user (team form ke dropdown ke liye)
router.post("/user/teams/categories/create", superAdminAuthentication, createTeamCategory);
router.get("/user/teams/categories", authentication, listTeamCategories);
router.get("/user/teams/categories/:id", authentication, getTeamCategory);
router.put("/user/teams/categories/:id/update", superAdminAuthentication, updateTeamCategory);
router.delete("/user/teams/categories/:id/delete", superAdminAuthentication, deleteTeamCategory);

// Teams
router.post("/user/teams/create", superAdminOrClubAdminAuthentication, createTeam);
router.get("/user/teams", authentication, listTeams);
router.get("/user/teams/:id", authentication, getTeam);
router.put("/user/teams/:id/update", superAdminOrClubAdminAuthentication, updateTeam);
router.delete("/user/teams/:id/delete", superAdminOrClubAdminAuthentication, deleteTeam);

// Player
router.post("/user/players/create", superAdminOrClubAdminAuthentication, createPlayer);
router.get("/user/players/shirt-sizes", listShirtSizes);
router.get("/user/players", superAdminOrClubAdminAuthentication, listPlayers);
router.get("/user/players/unassigned", superAdminOrClubAdminAuthentication, listUnassignedPlayers);
router.get("/user/players/:id", superAdminOrClubAdminAuthentication, getPlayer);
router.put("/user/players/:id/update", superAdminOrClubAdminAuthentication, updatePlayer);
router.delete("/user/players/:id/delete", superAdminOrClubAdminAuthentication, deletePlayer);
router.get("/user/teams/:id/shirt-numbers", superAdminOrClubAdminAuthentication, listShirtNumbers);
router.get("/user/teams/:id/other-players", superAdminOrClubAdminAuthentication, listOtherTeamPlayers);

// 2. Routes (baaki team/player routes ke saath):
router.post("/user/players/assign", superAdminOrClubAdminAuthentication, assignPlayerToTeam);
router.put("/user/teams/:id/players/:playerId/remove", superAdminOrClubAdminAuthentication, removePlayerFromTeam);

//Parent
router.post("/user/parent/register", registerParent);
router.put("/user/parent/profile", authentication, updateParentProfile);
router.post("/user/parent/selectClub", authentication, selectParentClub);
router.get("/user/parent/age-groups", authentication, listAgeGroups);
router.post("/user/parent/players/create", authentication, createYouthPlayer);
router.get("/user/parent/listMyYouthPlayers", authentication, listMyYouthPlayers);
router.get("/user/parent/players/:id", authentication, getMyYouthPlayer);
router.put("/user/parent/players/:id/update", authentication, updateMyYouthPlayer);
router.delete("/user/parent/players/:id/delete", authentication, deleteMyYouthPlayer)

//admin parents
router.get("/user/parents", authentication, listParents);
router.put("/user/parents/:id/update", authentication, updateParent);
router.delete("/user/parents/:id/delete", authentication, deleteParent);
router.post("/user/players/:id/parents/link", authentication, linkParentToPlayer);
router.delete("/user/players/:id/parents/:parentId/unlink", authentication, unlinkParentFromPlayer);

module.exports = router;
