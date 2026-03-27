'use strict';

const express = require('express');
const router = express.Router();

const controller = require('../controllers/brandOutreachController');

const { adminAuth } = require('../middlewares/adminAuth');

router.post('/create', adminAuth, controller.createBrandOutreachRow);
router.get('/list', adminAuth, controller.listBrandOutreach);
router.get('/:id', adminAuth, controller.getBrandOutreachById);

router.post('/update', adminAuth, controller.updateBrandOutreach);
router.post('/mark-outreach', adminAuth, controller.markOutreachSent);
router.post('/mark-followup', adminAuth, controller.markFollowUp);
router.post('/mark-reply', adminAuth, controller.markReplyReceived);
router.post('/move-to-network', adminAuth, controller.moveToNetwork);

module.exports = router;