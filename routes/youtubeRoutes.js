'use strict';

const router = require('express').Router();
const {
  getAllInfluencers,
  updateInfluencerManualFields,
  exportInfluencersCsv,
  searchYouTube,
  previewYouTubeProfile,
  syncYouTubeProfile
  
} = require('../controllers/youtubeController');

router.post('/getall', getAllInfluencers);
router.post('/update-manual', updateInfluencerManualFields);
router.post('/export-csv', exportInfluencersCsv);
router.post('/search', searchYouTube);
router.post('/profile/preview', previewYouTubeProfile);
router.post('/profile/sync', syncYouTubeProfile);
module.exports = router;