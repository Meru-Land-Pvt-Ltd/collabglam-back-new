// routes/contractRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
  // Core color-owner flow
  initiate,
  viewed,
  influencerConfirm,
  brandConfirm,
  adminUpdate,
  finalize,
  preview,
  sign,
  viewContractPdf,

  // Scoped edits
  brandUpdateFields,
  influencerUpdateFields,
  initiateBulk,
  // Basic read
  getContract,
  reject,
  // lists
  listTimezones,
  getTimezone,
  listCurrencies,
  getCurrency,
  resend,
    uploadBrandSignature,
  getBrandSignature,
  uploadInfluencerSignature,
  getInfluencerSignature,
   getDeliverablesByInfluencerAndCampaign,
  getMilestonesByInfluencerAndCampaign,
  getScheduleADataByInfluencerAndCampaign,
} = require('../controllers/contractController');

// Initiation & viewing
router.post('/initiate', initiate);                      // Brand fills Yellow; System expands Grey
router.post('/viewed', viewed);                          // Mark viewed

// Confirmations
router.post('/influencer/confirm', influencerConfirm);   // Influencer quick confirm (Purple)
router.post('/brand/confirm', brandConfirm);             // Brand confirm (optional gate)

// Scoped edits (post-confirm)
router.post('/brand/update', brandUpdateFields);         // Brand-only (Yellow)
router.post('/influencer/update', influencerUpdateFields); // Influencer-only (Purple)

// Admin
router.post('/admin/update', adminUpdate);               // Admin-only Green edits + legal versioning
router.post('/finalize', finalize);                      // Freeze for signatures (optional gate)

// Preview & signing
router.get('/preview', preview);                         // PDF preview of current state
router.post('/sign', sign);                              // Signatures; locks when ALL parties have signed
router.post('/viewPdf', viewContractPdf);                // View final/locked PDF (or pre-lock live render)

// Basic read
router.post('/getContract', getContract);                // Latest contracts for Brand & Influencer

router.post('/reject', reject);
router.post("/initiate-bulk", initiateBulk);

// lists
router.get('/timezones', listTimezones);
router.get('/timezone', getTimezone);
router.get('/currencies', listCurrencies);
router.get('/currency', getCurrency);
router.post('/resend', resend);

router.get(
  "/:influencerId/:campaignId/deliverables",
  getDeliverablesByInfluencerAndCampaign
);

router.get(
  "/:influencerId/:campaignId/milestones",
  getMilestonesByInfluencerAndCampaign
);

router.get(
  "/:influencerId/:campaignId/scheduleA",
  getScheduleADataByInfluencerAndCampaign
);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

router.post('/upload', upload.single('signature'), uploadBrandSignature);
router.get('/signature/:brandId', getBrandSignature);
router.post('/upload-influencer', upload.single('signature'), uploadInfluencerSignature);
router.get('/signature-influencer/:influencerId', getInfluencerSignature);
module.exports = router;
