// routes/filterRoutes.js
const express = require('express');
const router  = express.Router();
const { getFilteredInfluencers } = require('../controllers/filterController');

// Route: POST /api/influencers/getlist
router.post('/getlist', getFilteredInfluencers);

module.exports = router;
