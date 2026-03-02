// routes/index.js (or wherever you mount routes)
const express = require('express');
const router = express.Router();
const ModashController = require('../controllers/modashController');

router.get('/users', ModashController.frontendUsers);

router.post('/search', ModashController.frontendSearch);

router.get('/report', ModashController.frontendReport);

// optional: older endpoints
router.post('/resolve-profile', ModashController.resolveProfile);
router.post('/search-legacy', ModashController.search);

router.get('/saved', ModashController.getSavedInfluencers);
router.get('/random', ModashController.getRandomInfluencers);
router.post('/export-csv', ModashController.exportSavedInfluencersCsv);

module.exports = router;
