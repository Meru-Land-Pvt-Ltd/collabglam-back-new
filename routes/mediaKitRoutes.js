// routes/mediakitRoutes.js
const express = require('express');
const router = express.Router();

const {
  createByInfluencer,
  updateMediaKit,
  getAllMediaKits
} = require('../controllers/mediaKitController');
const { influencerAuth } = require("../auth/influencerAuth");

// create from influencer (POST)
router.post('/influencer', influencerAuth, createByInfluencer);

// update mediakit (POST)
router.post('/update', updateMediaKit);

// list mediakits (compact view)
router.get('/getAll', getAllMediaKits);

module.exports = router;
