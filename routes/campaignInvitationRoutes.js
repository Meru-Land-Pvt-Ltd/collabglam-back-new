// routes/campaignInvitationRoutes.js
const express = require("express");
const router = express.Router();

const campaignInvitationController = require("../controllers/campaignInvitationController");
const { brandAuth } = require("../auth/brandAuth");
const { influencerAuth } = require("../auth/influencerAuth");

// create invitation for one influencer on multiple campaigns
router.post("/create", brandAuth, campaignInvitationController.createInvitation);

// general list with filters
router.get("/list",  campaignInvitationController.getInvitationsList);

router.get("/influencer/:influencerId", influencerAuth,campaignInvitationController.getInvitationsByInfluencerId);
router.get("/influencer/:influencerId/all", influencerAuth,campaignInvitationController.getAllInvitationsByInfluencerId);

// get invitations by brandId
router.get("/brand/:brandId", brandAuth, campaignInvitationController.getInvitationsByBrandId);

router.post("/update-status", influencerAuth,campaignInvitationController.updateInvitationStatus);

router.post(
  "/get-invitations",brandAuth,
  campaignInvitationController.getInvitationsByBrandIdAndCampaignId
);

router.post("/get-by-campaign", campaignInvitationController.getInvitationsByCampaignIdPost);

module.exports = router;       