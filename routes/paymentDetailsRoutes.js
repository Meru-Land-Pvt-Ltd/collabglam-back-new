const express = require("express");
const router = express.Router();

const {
  addPaymentDetails,
  editPaymentDetails,
  deletePaymentDetails,
  getPaymentDetails,
} = require("../controllers/payementDetailsController");

router.post("/add-payment-details", addPaymentDetails);
router.post("/get-payment-details", getPaymentDetails);
router.post("/edit-payment-details", editPaymentDetails);
router.post("/delete-payment-details", deletePaymentDetails);

module.exports = router;