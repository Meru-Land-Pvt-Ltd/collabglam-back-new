// routes/delieverable.routes.js
const express = require("express");
const router = express.Router();

const {
  createDeliverableApproval,
  updateDeliverableApprovalStatus,
  listDeliverablesByCampaign,
  listInfluencerDeliverablesByCampaign,
  listInfluencerDeliverablesByCampaign2,
  getAllDeliverables,
} = require("../controllers/delieverableController");
const { influencerAuth } = require("../auth/influencerAuth");
const {brandAuth} = require("../auth/brandAuth");
const brandOrInfluencerAuth = require("../auth/brandOrInfluencerAuth");

// 1) POST - create (always pending)
router.post("/create", influencerAuth, createDeliverableApproval);

router.post(
  "/:deliverableId/approval-status",
  updateDeliverableApprovalStatus
);

// 3) GET - list campaign-wise
router.get("/campaign/:campaignId", listDeliverablesByCampaign);
router.get("/influencer/:influencerId", listInfluencerDeliverablesByCampaign);
router.get("/influencer/campaign/:campaignId", listInfluencerDeliverablesByCampaign2);
router.get("/getall", getAllDeliverables);

module.exports = router;