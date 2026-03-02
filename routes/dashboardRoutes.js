// routes/dashboard.js
const express = require('express');
const router = express.Router();
const {
  verifyToken,
  getDashboard,
  getDashboardInf,
  getBrandDashboardHome
} = require('../controllers/dashboardController');

// router.post('/brand', verifyToken, getDashboard);
router.post('/influencer', verifyToken, getDashboardInf);
router.post(
  "/brand", verifyToken, getBrandDashboardHome
);

module.exports = router;
