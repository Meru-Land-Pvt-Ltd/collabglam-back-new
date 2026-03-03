// routes/campaignRoutes.js

const express = require('express');
const router = express.Router();

const campaignController = require('../controllers/campaignsController');
const brandController = require('../controllers/brandController');
const adminController = require('../controllers/adminController');
const { verifyBrandOrAdmin } = require("../middlewares/verifyBrandOrAdmin");


// 1. Create a new campaign
router.post(
  '/create',
  verifyBrandOrAdmin,
  campaignController.createCampaign
);

// 2. Get all campaigns
router.get(
  '/getAll',

  campaignController.getAllCampaigns
);

// 3. Get one campaign by its campaignsId (UUID)
router.get(
  '/id',

  campaignController.getCampaignById
);

// 4. Update a campaign by its campaignsId (UUID)
router.post(
  '/update',

  campaignController.updateCampaign
);

// 5. Delete a campaign by its campaignsId (UUID)
router.post(
  '/delete',

  campaignController.deleteCampaign
);
router.get(
  '/active',
  // ensure the brand is authenticated
  campaignController.getActiveCampaignsByBrand
);

router.get(
  '/previous',
  // ensure the brand is authenticated
  campaignController.getPreviousCampaigns
);
router.post(
  '/byCategoryId',
  // ensure the brand is authenticated
  campaignController.getActiveCampaignsByCategories
);

router.post('/checkApplied', campaignController.checkApplied);
router.post('/byInfluencer', campaignController.getCampaignsByInfluencer);
router.post('/myCampaign', campaignController.getApprovedCampaignsByInfluencer);
router.post('/applied', campaignController.getAppliedCampaignsByInfluencer);
router.post("/history", campaignController.getCampaignHistoryByBrand);

router.post('/accepted', campaignController.getAcceptedCampaigns);

// POST /campaign/accepted-influencers → get accepted influencers for a Campaign
router.post('/accepted-inf', campaignController.getAcceptedInfluencers);

router.post('/contracted', campaignController.getContractedCampaignsByInfluencer);
router.post('/filter', campaignController.getCampaignsByFilter);

router.post('/rejectedbyinf', campaignController.getRejectedCampaignsByInfluencer);
router.get('/campaignSummary', campaignController.getCampaignSummary);

router.post('/save-draft', campaignController.saveDraftCampaign);
router.get('/draft', campaignController.getDraftCampaignByBrand);

router.post("/status", campaignController.updateCampaignStatus);

router.post("/history-list", campaignController.listApplicants);

router.post("/update-pending", campaignController.approveCampaignPendingUpdate);
router.post("/reject-pending", campaignController.rejectCampaignPendingUpdate);

router.post('/request-review', campaignController.requestBrandReview);
router.post('/confirm-readiness', campaignController.confirmCampaignReadiness);
router.post('/publish', campaignController.publishCampaign);
router.get('/created-by-admin/:brandId', campaignController.getAdminCampaigns);

module.exports = router;
