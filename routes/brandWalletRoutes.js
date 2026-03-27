const express = require("express");
const router = express.Router();

const {
  getBrandWallet,
  topupBrandWallet,
  getFrozenAmountForCampaign,
} = require("../controllers/brandWalletController");

router.get("/", getBrandWallet);
router.post("/topup", topupBrandWallet);
router.get("/freeze-amount", getFrozenAmountForCampaign);

module.exports = router;