const { Router } = require("express");
const { getTimezonesByCountries } = require("../controllers/timezoneController");

const router = Router();

router.post("/by-countries", getTimezonesByCountries);

module.exports = router;