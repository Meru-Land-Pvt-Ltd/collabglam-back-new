const express = require('express');
const router  = express.Router();
const {
  applyToCampaign,
  getListByCampaign,
  approveInfluencer
} = require('../controllers/applyCampaignsController');
const { verifyToken } = require('../controllers/brandController');

// influencer applies to a campaign (requires valid token)
router.post('/campaign', verifyToken, applyToCampaign);

// list all influencers for a campaign (requires valid token)
router.post('/list',  getListByCampaign);
router.post('/approve', verifyToken, approveInfluencer);

module.exports = router;
