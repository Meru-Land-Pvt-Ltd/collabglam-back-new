// routes/business.js
const express = require('express');
const router = express.Router();
const businessController = require('../controllers/businessController');

router.get('/getAll', businessController.getList);

module.exports = router;
