// controllers/countryController.js

const Country = require('../models/country');
exports.getAllCountries = async (req, res) => {
  try {
    const countries = await Country.find({}, '-__v');

    return res.status(200).json(countries);
  } catch (err) {
    console.error('Error fetching countries:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
