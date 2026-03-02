// routes/contractRoutes.js
const express = require('express');
const router = express.Router();

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

  // Basic read
  getContract,
  reject,
  // lists
  listTimezones,
  getTimezone,
  listCurrencies,
  getCurrency,
  resend,
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

// lists
router.get('/timezones', listTimezones);
router.get('/timezone', getTimezone);
router.get('/currencies', listCurrencies);
router.get('/currency', getCurrency);
router.post('/resend', resend);
module.exports = router;
