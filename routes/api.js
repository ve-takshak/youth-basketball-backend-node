const express = require('express');
const router = express.Router();

const { signupWithEmail, verify_otp, resendOtp, loginWithEmail, forgotPassword, resetPassword } = require('../app/controllers/api/userController');

router.get('/test',(req, res)=>{
    res.send("Hello 28-09-2026")
} );

router.post("/user/register", signupWithEmail)
router.post('/user/verify_otp', verify_otp)
router.post('/user/resend-otp', resendOtp)
router.post('/user/login', loginWithEmail)
router.post('/user/forgotPassword', forgotPassword)
router.post('/user/resetPassword', resetPassword)

module.exports = router