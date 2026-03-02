// routes/invitationRoutes.js
const express = require('express');
const router = express.Router();
const {
  createInvitation,
  updateInvitationStatus,
  listInvitations,
  getInvitationList,
  getInvitationSendEligibility,
} = require('../controllers/NewInvitationsController');

router.post('/create', createInvitation);
router.post('/update', updateInvitationStatus);
router.post('/list', listInvitations);
router.post('/getList', getInvitationList);
router.post('/eligibility', getInvitationSendEligibility);

module.exports = router;
