const express = require('express');
const router = express.Router();

const { adminAuthentication, authentication } = require('../app/middleware/authentication');
const { register, login, verifyOtp } = require('../app/controllers/api/userController');
const { createClub, listClubs, updateClub, deleteClub } = require('../app/controllers/api/clubController');

router.get('/test',(req, res)=>{
    res.send("Hello 28-09-2026")
} );

router.post("/user/register", register);
router.post("/user/login", login);
router.post("/user/verify-otp", verifyOtp);


// Club (sirf admin)
router.post("/user/createClub", authentication, createClub);
router.get("/user/listClubs", listClubs);
router.put("/user/updateClub/:id", authentication, updateClub);
router.delete("/user/deleteClub/:id", authentication, deleteClub);

module.exports = router