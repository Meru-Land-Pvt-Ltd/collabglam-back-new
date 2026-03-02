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
  brandController.verifyToken,
  campaignController.getAllCampaigns
);

// 3. Get one campaign by its campaignsId (UUID)
router.get(
  '/id',
  brandController.verifyToken,
  campaignController.getCampaignById
);

// 4. Update a campaign by its campaignsId (UUID)
router.post(
  '/update',
  brandController.verifyToken,
  campaignController.updateCampaign
);

// 5. Delete a campaign by its campaignsId (UUID)
router.post(
  '/delete',
  brandController.verifyToken,
  campaignController.deleteCampaign
);
router.get(
  '/active',
  brandController.verifyToken,            // ensure the brand is authenticated
  campaignController.getActiveCampaignsByBrand
);

router.get(
  '/previous',
  brandController.verifyToken,            // ensure the brand is authenticated
  campaignController.getPreviousCampaigns
);
router.post(
  '/byCategoryId',
  brandController.verifyToken,            // ensure the brand is authenticated
  campaignController.getActiveCampaignsByCategories
);

router.post('/checkApplied', brandController.verifyToken, campaignController.checkApplied);
router.post('/byInfluencer', brandController.verifyToken, campaignController.getCampaignsByInfluencer);
router.post('/myCampaign', brandController.verifyToken, campaignController.getApprovedCampaignsByInfluencer);
router.post('/applied', brandController.verifyToken, campaignController.getAppliedCampaignsByInfluencer);
router.post("/history", brandController.verifyToken, campaignController.getCampaignHistoryByBrand);

router.post('/accepted', brandController.verifyToken, campaignController.getAcceptedCampaigns);

// POST /campaign/accepted-influencers → get accepted influencers for a Campaign
router.post('/accepted-inf', brandController.verifyToken, campaignController.getAcceptedInfluencers);

router.post('/contracted', brandController.verifyToken, campaignController.getContractedCampaignsByInfluencer);
router.post('/filter', brandController.verifyToken, campaignController.getCampaignsByFilter);

router.post('/rejectedbyinf', brandController.verifyToken, campaignController.getRejectedCampaignsByInfluencer);
router.get('/campaignSummary', brandController.verifyToken, campaignController.getCampaignSummary);

router.post('/save-draft', brandController.verifyToken, campaignController.saveDraftCampaign);
router.get('/draft', brandController.verifyToken, campaignController.getDraftCampaignByBrand);

router.post("/status", campaignController.updateCampaignStatus);

router.post("/history-list", campaignController.listApplicants);

router.post("/update-pending", campaignController.approveCampaignPendingUpdate);
router.post("/reject-pending", campaignController.rejectCampaignPendingUpdate);

router.post('/request-review', campaignController.requestBrandReview);
router.post('/confirm-readiness', campaignController.confirmCampaignReadiness);
router.post('/publish', campaignController.publishCampaign);
router.get('/created-by-admin/:brandId', campaignController.getAdminCampaigns);

module.exports = router;
