// routes/brandAuth.routes.js
const express = require("express");
const multer = require("multer");
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

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
    updateBrandProfile,
    uploadBrandProfilePic,
    verifyBrandCoupon
} = require("../controllers/brandController");

const { brandAuth } = require("../auth/brandAuth");

const router = express.Router();
router.post(
  "/upload-brand-profile-pic",
  upload.single("brandProfilePic"),brandAuth,
  uploadBrandProfilePic
);
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
router.post("/verify-coupon", brandAuth, verifyBrandCoupon);

module.exports = router;