const express = require("express");
const router = express.Router();

const {
  login,
  getAllBrands,
  getList,
  getAllCampaigns,
  getAllCampaignsLite,
  getBrandById,
  getByInfluencerId,
  getCampaignById,
  getCampaignsByBrandId,
  getCampaignsByInfluencerId,
  adminGetInfluencerById,
  adminGetInfluencerList,
  adminAddYouTubeEmail,
  listMissingEmail,
  updateMissingEmail,
  checkMissingEmailByHandle,
  getAllPayments,
  adminAssignBrandPlan,
  adminAssignInfluencerPlan,
  enableCampaignShare,
  disableCampaignShare,
  getPublicCampaignByToken,
  adminAddCampaignFunds,
} = require("../controllers/adminController");

const { adminAuth } = require("../middlewares/adminAuth");

const {
  adminListPayouts,
  adminMarkMilestonePaid,
} = require("../controllers/milestoneController");

router.post("/login", login);

router.post("/brand/getlist", adminAuth, getAllBrands);
router.post("/influencer/getlist", adminAuth, getList);

// full campaign payload, but now scoped
router.post("/campaign/getlist", adminAuth, getAllCampaigns);

// fast summary payload for listing page
router.post("/campaign/lite", adminAuth, getAllCampaignsLite);

router.get("/brand/getById", adminAuth, getBrandById);
router.get("/influencer/getById", adminAuth, getByInfluencerId);
router.get("/campaign/getById", adminAuth, getCampaignById);
router.post("/campaign/getByBrandId", adminAuth, getCampaignsByBrandId);

router.get("/influencer/byId", adminAuth, adminGetInfluencerById);
router.post("/influencer/list", adminAuth, adminGetInfluencerList);

router.post("/milestone/payout", adminAuth, adminListPayouts);
router.post("/milestone/update", adminAuth, adminMarkMilestonePaid);

router.post("/addYouTubeEmail", adminAuth, adminAddYouTubeEmail);
router.post("/listMissingEmail", adminAuth, listMissingEmail);
router.post("/updateMissingEmail", adminAuth, updateMissingEmail);
router.post("/checkstatus", adminAuth, checkMissingEmailByHandle);
router.post("/campaign/getByInfluencerId", adminAuth, getCampaignsByInfluencerId);
router.post("/getpayments", adminAuth, getAllPayments);

router.post("/assignBrandPlan", adminAuth, adminAssignBrandPlan);
router.post("/assignInfluencerPlan", adminAuth, adminAssignInfluencerPlan);

router.post("/campaign/share/enable", adminAuth, enableCampaignShare);
router.post("/campaign/share/disable", adminAuth, disableCampaignShare);
router.get("/campaign/share/:token", getPublicCampaignByToken);

router.post("/campaign/add-funds", adminAuth, adminAddCampaignFunds);

module.exports = router;