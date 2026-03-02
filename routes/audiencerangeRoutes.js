// routes/audienceRanges.js
const express = require('express');
const router  = express.Router();
const { getAllAudienceRanges } = require('../controllers/audiencerangeController');

// GET /audience-ranges
router.get('/getAll', getAllAudienceRanges);

module.exports = router;
