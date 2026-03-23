'use strict';

const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/influencerPipeline');
const { adminAuth } = require('../middlewares/adminAuth');

router.use(adminAuth);

// create / bulk actions
router.post('/bulk-add', ctrl.bulkAddToOutreach);
router.post('/outreach/update', ctrl.updateOutreach);
router.post('/outreach/sent', ctrl.markOutreachSent);
router.post('/follow-up', ctrl.markFollowUp);
router.post('/reply', ctrl.saveReplyAndMoveToRoster);
router.post('/roster/update', ctrl.updateRoster);
router.post('/move-to-pitch', ctrl.moveToPitch);
router.post('/pitch/update', ctrl.updatePitch);
router.post('/campaign/:campaignId/portal', ctrl.generatePortalLink);
router.post('/milestones/add', ctrl.addMilestone);
router.post('/move-to-roster', ctrl.moveToRoster);

// fetch
router.get('/list', ctrl.listPipeline);
router.get('/detail/:id', ctrl.getPipelineById);

module.exports = router;