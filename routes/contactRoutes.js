// routes/contactRoutes.js

const express = require('express');
const router = express.Router();
const contactController = require('../controllers/contactController');

// Create a new contact message
// POST /api/contact/create
router.post('/send', contactController.sendContact);
router.post('/getList', contactController.getAllContacts);


router.post('/newsletter/create', contactController.createNewsletter);
router.post('/newsletter/list',   contactController.getNewsletterList);
// Newsletter download endpoints
router.post('/newsletter/download',   contactController.downloadNewsletter);


module.exports = router;
