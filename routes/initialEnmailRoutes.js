const express = require('express');
const router = express.Router();
const { sendInvitation } = require('../emails/signupInvitationController');
const { sendWelcomeEmail } = require('../emails/wellcomeEmailController');
const {sendDisputeCreated,sendDisputeResolved,} = require('../emails/disputeEmailController');

router.post('/send-welcome', sendWelcomeEmail);
router.post('/invitation', sendInvitation);
router.post('/send-dispute-created', sendDisputeCreated);
router.post('/send-dispute-resolved', sendDisputeResolved);
module.exports = router;