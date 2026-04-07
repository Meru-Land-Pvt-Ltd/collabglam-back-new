const express = require('express');
const router = express.Router();

const {
  createMatchedCreator,
} = require('../controllers/matchedCreatorController');

router.post('/create', createMatchedCreator);

module.exports = router;