// models/Country.js
const mongoose = require('mongoose');

const countrySchema = new mongoose.Schema({
    countryName: { type: String, required: true },
    callingCode: { type: String, required: true },
    countryCode: { type: String, required: true },
    flag : { type: String, required: true },
});

module.exports = mongoose.model('Country', countrySchema);
