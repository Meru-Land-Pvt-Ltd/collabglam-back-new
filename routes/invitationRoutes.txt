const express = require('express');
const router = express.Router();
const invitationController = require('../controllers/invitationController');


router.post('/create', invitationController.createInvitation);


router.post('/getAll', invitationController.getInvitations);


router.post('/accept', invitationController.acceptInvitation);
router.post('/active',    invitationController.getActiveCampaigns);

module.exports = router;
