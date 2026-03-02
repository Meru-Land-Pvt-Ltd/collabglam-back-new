const express = require('express');
const router = express.Router();
const { getList } = require('../controllers/audienceController');

router.get('/getlist', getList);

module.exports = router;
