// routes/platforms.js
const express = require('express');
const router  = express.Router();
const { getAllPlatforms } = require('../controllers/platformController');

// GET /platforms
router.get('/getAll', getAllPlatforms);

module.exports = router;
