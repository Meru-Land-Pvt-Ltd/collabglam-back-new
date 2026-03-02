// routes/mediakitRoutes.js
const express = require('express');
const router = express.Router();

const {
  createByInfluencer,
  updateMediaKit,
  getAllMediaKits
} = require('../controllers/mediaKitController');

// create from influencer (POST)
router.post('/influencer', createByInfluencer);

// update mediakit (POST)
router.post('/update', updateMediaKit);

// list mediakits (compact view)
router.get('/getAll', getAllMediaKits);

module.exports = router;
