// routes/notificationsRoutes.js
const express = require('express');
const ctrl = require('../controllers/notificationController');

const router = express.Router();

// Influencer notifications
router.get('/influencer', ctrl.listForInfluencer);
router.post('/influencer/mark-read', ctrl.markReadForInfluencer);
router.post('/influencer/mark-all-read', ctrl.markAllReadForInfluencer);

// Brand notifications
router.get('/brand', ctrl.listForBrand);
router.post('/brand/mark-read', ctrl.markReadForBrand);
router.post('/brand/mark-all-read', ctrl.markAllReadForBrand);
router.post('/brand/delete', ctrl.deleteForBrand);

router.post('/influencer/delete', ctrl.deleteForInfluencer);

// Admin notifications
router.get('/admin', ctrl.listForAdmin);
router.post('/admin/mark-read', ctrl.markReadForAdmin);
router.post('/admin/mark-all-read', ctrl.markAllReadForAdmin);
router.post('/admin/delete', ctrl.deleteForAdmin);

module.exports = router;
