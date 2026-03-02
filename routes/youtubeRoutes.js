'use strict';

const router = require('express').Router();
const {
  syncYouTubeProfile,
  getAllInfluencers,
  updateInfluencerManualFields,
  exportInfluencersCsv,
} = require('../controllers/youtubeController');

router.post('/handel-data', syncYouTubeProfile);
router.post('/getall', getAllInfluencers);
router.post('/update-manual', updateInfluencerManualFields);
router.post('/export-csv', exportInfluencersCsv);
module.exports = router;