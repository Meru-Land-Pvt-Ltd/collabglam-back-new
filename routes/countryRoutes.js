// routes/countryRoutes.js
const express = require('express');
const router  = express.Router();
const { getAllCountries } = require('../controllers/countryController');

// GET /country → returns all countries
router.get('/getAll', getAllCountries);

module.exports = router;
