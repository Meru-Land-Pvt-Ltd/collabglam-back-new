const express = require("express");
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
  getPayoutDetailsByInfluencer
} = require("../controllers/milestoneController");

// Brand: create milestone and freeze amount in BrandWallet
router.post("/create", createMilestone);

// Get milestones by campaign
router.post("/byCampaign", getMilestonesByCampaign);

// Brand: get wallet balance from BrandWallet
router.post("/balance", getWalletBalance);

// Get milestones by influencer + campaign
router.post("/getMilestome", getMilestonesByInfluencerAndCampaign);

// Get milestones by influencer
router.post("/byInfluencer", getMilestonesByInfluencer);

// Brand: get milestones by brand + wallet details from BrandWallet
router.post("/byBrand", getMilestonesByBrand);

// Brand: release milestone, unfreeze and deduct wallet amount
router.post("/release", releaseMilestone);

// Get influencer total paid
router.post("/influencer-payout", getInfluencerPaidTotal);

// Admin payout list
router.post("/adminListPayouts", adminListPayouts);

// Admin mark payout as paid
router.post("/adminMarkMilestonePaid", adminMarkMilestonePaid);

router.post("/getPayoutDetailsByInfluencer",getPayoutDetailsByInfluencer);

module.exports = router;