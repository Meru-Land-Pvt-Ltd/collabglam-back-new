const express = require('express');
const router = express.Router();

const {
  getAllAgeRanges,
  getAllContentFormats,
  getAllContentLanguages,
  getAllCountries,
  getAllInfluencerTiers,
  getAllPreferredHashtags,
  getAllProductServiceGoals,
} = require("../controllers/listController");


// keep "/getall" pattern for all
router.get("/age-ranges", getAllAgeRanges);
router.get("/content-formats", getAllContentFormats);
router.get("/content-languages", getAllContentLanguages);
router.get("/countries", getAllCountries);
router.get("/influencer-tiers", getAllInfluencerTiers);
router.get("/preferred-hashtags", getAllPreferredHashtags);
router.get("/product-service-goals", getAllProductServiceGoals);


module.exports = router;
