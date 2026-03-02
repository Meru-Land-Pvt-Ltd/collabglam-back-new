// scripts/populateCountriesFromData.js
require('dotenv').config();
const mongoose      = require('mongoose');
const Country = require('../models/country');
const countriesData = require('../data/countryData'); // the JS version

async function populateCountries() {
  try {
    // 1. CONNECT TO MONGODB
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('Missing MONGO_URI (or MONGODB_URI) in .env');
    await mongoose.connect(uri);
    console.log('✔️ Connected to MongoDB');

    // 2. OPTIONAL: Clear existing Country documents if you want a fresh slate
    // await Country.deleteMany({});
    // console.log('🗑️ Cleared existing Country documents');

    // 3. MAP CountryData → Country model fields
    const docs = countriesData.map((entry) => ({
      countryName: entry.countryNameEn,
      callingCode: '+' + entry.countryCallingCode, // prepend “+”
      countryCode: entry.countryCode,
      flag:        entry.flag
    }));

    // 4. BULK INSERT
    const result = await Country.insertMany(docs, { ordered: false });
    console.log(`✅ Inserted ${result.length} countries into the “Country” collection.`);
  } catch (err) {
    console.error('❌ Error populating countries:', err);
  } finally {
    await mongoose.disconnect();
    console.log('🔒 MongoDB connection closed');
  }
}

populateCountries();
