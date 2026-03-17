const express = require('express');
const router = express.Router();
const {
  applyToCampaign,
  getListByCampaign,
  approveInfluencer,
  setApplicantDecisionStatus
} = require('../controllers/applyCampaignsController');

// influencer applies to a campaign (requires valid token)
router.post('/campaign', applyToCampaign);

// list all influencers for a campaign (requires valid token)
router.post('/list', getListByCampaign);
router.post('/approve', approveInfluencer);
router.post(
  '/update-status',
 setApplicantDecisionStatus
);

module.exports = router;
