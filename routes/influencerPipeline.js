'use strict';

const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/influencerPipeline');
const { adminAuth, optionalAdminAuth } = require('../middlewares/adminAuth');

// create / bulk actions
router.post('/bulk-add', adminAuth, ctrl.bulkAddToOutreach);
router.post('/outreach/update', adminAuth, ctrl.updateOutreach);
router.post('/outreach/sent', adminAuth, ctrl.markOutreachSent);
router.post('/follow-up', adminAuth, ctrl.markFollowUp);
router.post('/reply', adminAuth, ctrl.saveReplyAndMoveToRoster);
router.post('/roster/update', adminAuth, ctrl.updateRoster);
router.post('/move-to-pitch', adminAuth, ctrl.moveToPitch);
router.post('/pitch/update', adminAuth, ctrl.updatePitch);
router.post('/campaign/:campaignId/portal', adminAuth, ctrl.generatePortalLink);
router.post('/milestones/add', adminAuth, ctrl.addMilestone);
router.post('/move-to-roster', adminAuth, ctrl.moveToRoster);
router.post('/create', adminAuth, ctrl.createPipelineRow);
router.get('/brand-sheet', optionalAdminAuth, ctrl.getBrandPitchSheetByCampaign);
router.post('/brand-sheet/:id/good-fit', ctrl.updateBrandPitchGoodFit);
router.post('/pitch/send-invitation', adminAuth, ctrl.sendCampaignInvitationFromPitch);
// fetch
router.get('/list', adminAuth, ctrl.listPipeline);
router.get('/detail/:id', adminAuth, ctrl.getPipelineById);

module.exports = router;