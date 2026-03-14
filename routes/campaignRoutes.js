const express = require("express");
const router = express.Router();

const campaignController = require("../controllers/campaignsController");
const { verifyBrandOrAdmin } = require("../middlewares/verifyBrandOrAdmin");
const { brandAuth } = require("../auth/brandAuth");
const { influencerAuth } = require("../auth/influencerAuth");
const  brandOrInfluencerAuth  = require("../auth/brandOrInfluencerAuth");

// 1. Create a new campaign
router.post("/create", verifyBrandOrAdmin, campaignController.createCampaign);

// 2. Edit manual campaign
router.put("/update-manual", brandAuth, campaignController.updateManualCampaign);

// optional alias if frontend/client cannot send PUT
router.post("/update-manual", brandAuth, campaignController.updateManualCampaign);

// 3. Get all campaigns
router.get("/getAll", brandAuth, campaignController.getAllCampaigns);

// 4. Get one campaign by its campaignsId
router.get("/id", campaignController.getCampaignById);

// 5. Delete a campaign by its campaignsId
router.post("/delete", brandAuth, campaignController.deleteCampaignByCampaignId);

router.get("/active", brandAuth, campaignController.getActiveCampaignsByBrand);
router.get("/previous", brandAuth, campaignController.getPreviousCampaigns);
router.post("/byCategoryId", brandAuth, campaignController.getActiveCampaignsByCategories);

router.post("/checkApplied", brandAuth, campaignController.checkApplied);
router.post("/byInfluencer", influencerAuth, campaignController.getCampaignsByInfluencer);
router.post("/myCampaign", influencerAuth, campaignController.getApprovedCampaignsByInfluencer);
router.post("/applied", brandOrInfluencerAuth, campaignController.getAppliedCampaignsByInfluencer);
router.post("/history", brandAuth, campaignController.getCampaignHistoryByBrand);

router.post("/accepted", campaignController.getAcceptedCampaigns);
router.post("/accepted-inf", brandAuth, campaignController.getAcceptedInfluencers);

router.post("/contracted", influencerAuth, campaignController.getContractedCampaignsByInfluencer);
router.post("/filter", brandAuth, campaignController.getCampaignsByFilter);
router.post("/rejectedbyinf", brandAuth, campaignController.getRejectedCampaignsByInfluencer);

router.get("/campaignSummary", brandAuth, campaignController.getCampaignSummary);
router.get("/draft", brandAuth, campaignController.getDraftCampaignByBrand);

router.post("/history-list", campaignController.listApplicants);
router.post("/update-pending", campaignController.approveCampaignPendingUpdate);
router.post("/reject-pending", campaignController.rejectCampaignPendingUpdate);

router.get("/created-by-admin/:brandId", campaignController.getAdminCampaigns);

router.get("/category",campaignController.getCategories);
router.get("/subcategory", brandAuth, campaignController.getSubcategories);

// existing endpoint
router.post("/view-campaign-brand", brandAuth, campaignController.viewCampaignByIdForBrand);

router.post("/recommended-influencers", brandAuth, campaignController.getRecommendedInfluencersByCampaignId);
router.post("/update-status",brandAuth, campaignController.updateStatus);
router.post(
  "/view-campaign-by-influencer",
  influencerAuth,
  campaignController.viewCampaignByIdForInfluencer
);


router.post(
  "/influencer/get-all-active",
  influencerAuth, 
  campaignController.getAllActiveCampaignsForInfluencer
);


module.exports = router;  