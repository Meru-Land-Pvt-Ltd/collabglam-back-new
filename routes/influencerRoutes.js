// routes/influencerRoutes.js
const express = require('express');
const router = express.Router();
const {
  registerInfluencer,
  uploadProfileImage,
  signInInfluencer,
  verifyToken,
  getList,
  getById,
  getCampaignsByInfluencer,
  sendSignupOtpInfluencer,
  verifyOtpSignUpInfluencer,
  requestPasswordResetOtpInfluencer,
  verifyPasswordResetOtpInfluencer,
  resetPasswordInfluencer,
  viewPaymentByType,
  addPaymentMethod,
  deletePaymentMethod,
  updatePaymentMethod,
  suggestInfluencers,
  updateProfile,
  requestEmailUpdate,
  verifyotp,
  saveQuickOnboarding,
  getLiteById,
  requestClaimEmailOtp,
  verifyClaimEmailOtp,
  getInfluencerOnboarding,
  markInfluencerTourSeen,
} = require('../controllers/influencerController');
const { influencerAuth } = require("../auth/influencerAuth");
// Public endpoints:
router.post('/request-otp', sendSignupOtpInfluencer);
router.post('/verify-otp', verifyOtpSignUpInfluencer);
router.post('/save-influencer-onboarding', influencerAuth, saveQuickOnboarding);


router.post('/login', signInInfluencer);
router.post('/get-campaign', influencerAuth, getCampaignsByInfluencer);
router.post('/getlist', influencerAuth, getList);
router.get('/getById', influencerAuth, getById);

router.post('/sendOtp', influencerAuth, requestPasswordResetOtpInfluencer);
router.post('/verifyOtp', influencerAuth, verifyPasswordResetOtpInfluencer);
router.post('/updatePassword', influencerAuth, resetPasswordInfluencer);

router.post('/viewPaymentByType', influencerAuth, viewPaymentByType);

router.post('/addPaymentMethod', influencerAuth, addPaymentMethod);
router.post('/deletePaymentMethod', influencerAuth, deletePaymentMethod);
router.post('/updatePaymentMethod', influencerAuth, updatePaymentMethod);
router.post('/suggestInfluencers', influencerAuth, suggestInfluencers);

// POST /influencer/searchBrands → search brands by name

router.post('/updateProfile', influencerAuth, uploadProfileImage, updateProfile);
router.post('/requestEmailUpdate', influencerAuth, requestEmailUpdate);
router.post('/verifyEmailUpdateOtp', influencerAuth, verifyotp);

router.get('/lite', influencerAuth, getLiteById);

router.post(
  '/claim-email/request-otp',
  influencerAuth,
  requestClaimEmailOtp
);

router.post(
  '/claim-email/verify',
  influencerAuth,
  verifyClaimEmailOtp
);

router.get('/onboarding', influencerAuth, getInfluencerOnboarding);
router.post('/onboarding/influencer-tour/seen', influencerAuth, markInfluencerTourSeen);


module.exports = router;
