const express = require('express');
const router = express.Router();
const { login, getAllBrands, getList, getAllCampaigns, getBrandById,
  getByInfluencerId, getCampaignById, getCampaignsByBrandId, adminGetInfluencerById,
  adminGetInfluencerList, adminAddYouTubeEmail, listMissingEmail, updateMissingEmail, checkMissingEmailByHandle,
  getAllPayments, adminAssignBrandPlan, adminAssignInfluencerPlan, getAllCampaignsLite
} = require('../controllers/adminController');
const { adminAuth } = require("../middlewares/adminAuth");

const {
  adminListPayouts,
  adminMarkMilestonePaid
} = require('../controllers/milestoneController');

// POST /admin/create
router.post('/login', login);
router.post('/brand/getlist', adminAuth, getAllBrands);
router.post('/influencer/getlist', getList);
router.post('/campaign/getlist', adminAuth, getAllCampaigns);
router.post('/campaign/lite', adminAuth, getAllCampaignsLite);


// GET /admin/brand/getById
router.get('/brand/getById', adminAuth, getBrandById);
router.get('/influencer/getById', getByInfluencerId);
router.get('/campaign/getById', getCampaignById);
router.post('/campaign/getByBrandId', adminAuth, getCampaignsByBrandId);

router.get('/influencer/byId', adminGetInfluencerById);
router.post('/influencer/list', adminGetInfluencerList);

router.post('/milestone/payout', adminListPayouts);
router.post('/milestone/update', adminMarkMilestonePaid);

router.post('/addYouTubeEmail', adminAddYouTubeEmail);

router.post('/listMissingEmail', listMissingEmail);
router.post('/updateMissingEmail', updateMissingEmail);
router.post('/checkstatus', checkMissingEmailByHandle);

router.post('/getpayments', getAllPayments);

router.post('/assignBrandPlan', adminAssignBrandPlan);
router.post('/assignInfluencerPlan', adminAssignInfluencerPlan);

module.exports = router;