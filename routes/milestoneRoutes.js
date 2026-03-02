// routes/milestone.js

const express = require('express');
const router = express.Router();

const {
  createMilestone,
  getMilestonesByCampaign,
  getWalletBalance,
  getMilestonesByInfluencerAndCampaign,
  getMilestonesByInfluencer,
  getMilestonesByBrand,
  releaseMilestone,
  getInfluencerPaidTotal,
  adminListPayouts,
  adminMarkMilestonePaid,
} = require('../controllers/milestoneController');

// create a new milestone
router.post('/create', createMilestone);

// list all milestones for a campaign
router.post('/byCampaign', getMilestonesByCampaign);

// get total wallet‐balance for a brand
router.post('/balance', getWalletBalance);

// milestones for influencer + campaign (typo kept if your frontend uses it)
router.post('/getMilestome', getMilestonesByInfluencerAndCampaign);

// milestones for influencer across campaigns
router.post('/byInfluencer', getMilestonesByInfluencer);

// milestones for brand
router.post('/byBrand', getMilestonesByBrand);

// release milestone (brand → initiated)
router.post('/release', releaseMilestone);

// get total amount paid to an influencer
router.post('/influencer', getInfluencerPaidTotal);

// admin payout list
router.post('/adminListPayouts', adminListPayouts);

// admin mark milestone paid
router.post('/adminMarkMilestonePaid', adminMarkMilestonePaid);

module.exports = router;
