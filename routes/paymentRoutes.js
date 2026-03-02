const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// Create order
router.post('/order', paymentController.createOrder);
// Verify payment
router.post('/verify', paymentController.verifyPayment);

router.post('/milestone-order', paymentController.createMilestoneOrder);
router.post('/milestone-verify', paymentController.verifyMilestonePayment);

router.post('/payment-history', paymentController.getInvoicesByUserId);
router.post('/generate-invoice', paymentController.previewInvoiceByInvoiceNumber);

module.exports = router;