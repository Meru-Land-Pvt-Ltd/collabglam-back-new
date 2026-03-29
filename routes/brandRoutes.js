// routes/brandAuth.routes.js
const express = require("express");

const {
    sendSignupOtp,
    verifyOtpSignUp,
    saveBrandOnboarding,
    signInBrand,
    sendOtpForgotBrand,
    verifyOtpForgotBrand,
    updatePasswordBrand,
    getBrandById,
    getBrandLiteById,
    getBrandProfile,
    updateBrandProfile
} = require("../controllers/brandController");

const { brandAuth } = require("../auth/brandAuth");

const router = express.Router();

router.post("/send-otp-signup", sendSignupOtp);
router.post("/verify-otp-signup", verifyOtpSignUp);
router.post("/save-brand-onboarding", brandAuth, saveBrandOnboarding);
router.post("/signin", signInBrand);
router.post("/send-otp-forgot", sendOtpForgotBrand);
router.post("/verify-otp-forgot", verifyOtpForgotBrand);
router.post("/update-password", updatePasswordBrand);
router.get("/:id", getBrandById);
router.get("/lite",brandAuth, getBrandLiteById);
router.post("/profile", brandAuth, getBrandProfile);
router.post("/profile/update", brandAuth, updateBrandProfile);

module.exports = router;