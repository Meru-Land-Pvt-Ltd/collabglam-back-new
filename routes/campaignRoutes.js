// routes/campaignRoutes.js

const express = require('express');
const router = express.Router();

const campaignController = require('../controllers/campaignsController');
const { verifyBrandOrAdmin } = require("../middlewares/verifyBrandOrAdmin");

const { brandAuth } = require("../auth/brandAuth");

// 1. Create a new campaign
router.post(
  '/create',
  verifyBrandOrAdmin,
  campaignController.createCampaign
);

// 2. Get all campaigns
router.get(
  '/getAll',
  brandAuth,            // ensure the brand is authenticated
  campaignController.getAllCampaigns
);

// 3. Get one campaign by its campaignsId (UUID)
router.get(
  '/id',
  brandAuth,
  campaignController.getCampaignById
);

// // 4. Update a campaign by its campaignsId (UUID)
// router.post(
//   '/update',
//   brandAuth,
//   campaignController.updateCampaign
// );

// 5. Delete a campaign by its campaignsId (UUID)
router.post(
  '/delete',
  brandAuth,
  campaignController.deleteCampaign
);
router.get(
  '/active',
  brandAuth,            // ensure the brand is authenticated
  campaignController.getActiveCampaignsByBrand
);

router.get(
  '/previous',
  brandAuth,            // ensure the brand is authenticated
  campaignController.getPreviousCampaigns
);
router.post(
  '/byCategoryId',
  brandAuth,            // ensure the brand is authenticated
  campaignController.getActiveCampaignsByCategories
);

router.post('/checkApplied', brandAuth, campaignController.checkApplied);
router.post('/byInfluencer', brandAuth, campaignController.getCampaignsByInfluencer);
router.post('/myCampaign', brandAuth, campaignController.getApprovedCampaignsByInfluencer);
router.post('/applied', brandAuth, campaignController.getAppliedCampaignsByInfluencer);
router.post("/history", brandAuth, campaignController.getCampaignHistoryByBrand);

router.post('/accepted', brandAuth, campaignController.getAcceptedCampaigns);

// POST /campaign/accepted-influencers → get accepted influencers for a Campaign
router.post('/accepted-inf', brandAuth, campaignController.getAcceptedInfluencers);

router.post('/contracted', brandAuth, campaignController.getContractedCampaignsByInfluencer);
router.post('/filter', brandAuth, campaignController.getCampaignsByFilter);

router.post('/rejectedbyinf', brandAuth, campaignController.getRejectedCampaignsByInfluencer);
router.get('/campaignSummary', brandAuth, campaignController.getCampaignSummary);

// router.post('/save-draft', brandAuth, campaignController.saveDraftCampaign);
router.get('/draft', brandAuth, campaignController.getDraftCampaignByBrand);

// router.post("/status", campaignController.updateCampaignStatus);

router.post("/history-list", campaignController.listApplicants);

router.post("/update-pending", campaignController.approveCampaignPendingUpdate);
router.post("/reject-pending", campaignController.rejectCampaignPendingUpdate);

// router.post('/request-review', campaignController.requestBrandReview);
// router.post('/confirm-readiness', campaignController.confirmCampaignReadiness);
// router.post('/publish', campaignController.publishCampaign);
router.get('/created-by-admin/:brandId', campaignController.getAdminCampaigns);

router.get('/category', brandAuth, campaignController.getCategories);
router.get('/subcategory', brandAuth, campaignController.getSubcategories);

router.post("/view-campaign-brand", brandAuth, campaignController.viewCampaignByIdForBrand);

router.post("/recommended-influencers", brandAuth, campaignController.getRecommendedInfluencersByCampaignId);

module.exports = router;
