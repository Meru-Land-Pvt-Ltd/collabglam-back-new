const express = require("express");
const router = express.Router();

const {
  getBrandWallet,
  topupBrandWallet,
  freezeFundsForCampaign,
  getFrozenAmountForCampaign,
} = require("../controllers/brandWalletController");

router.get("/", getBrandWallet);
router.post("/topup", topupBrandWallet);
router.post("/freeze-for-campaign", freezeFundsForCampaign);
router.get("/freeze-amount", getFrozenAmountForCampaign);

module.exports = router;