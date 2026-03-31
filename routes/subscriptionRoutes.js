// routes/subscriptionPlanRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/subscriptionController');

// Plan CRUD
router.post('/create', ctrl.createPlan);
router.post('/list', ctrl.getPlans);
router.get('/getById', ctrl.getPlanById);
router.post('/update', ctrl.updatePlan);
router.post('/delete', ctrl.deletePlan);

// Subscription actions
router.post('/assign', ctrl.assignPlan);
router.post('/renew', ctrl.renewPlan);
router.post('/me', ctrl.getMyPlan);
router.post("/check-brand", ctrl.checkBrandPlanChange);
router.get("/brand/current", ctrl.getCurrentBrandPlanLite );
router.post("/send-expiring-soon-emails", ctrl.sendExpiringSoonEmails);
router.post("/send-expired-emails", ctrl.sendExpiredSubscriptionEmails);

module.exports = router;
