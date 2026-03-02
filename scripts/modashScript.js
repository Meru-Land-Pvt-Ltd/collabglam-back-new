// scripts/modashScript.js
/* eslint-disable no-console */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const ModashCountry = require('../models/modash');

// Load the data file (supports both array or { locations: [...] } shape)
function loadCountryData() {
  // Accept .js or .json; adjust path if needed
  const dataPath = path.join(__dirname, '..', 'data', 'modashCountry.js');
  // If your data is JSON, use 'modashCountry.json'
  // const dataPath = path.join(__dirname, '..', 'data', 'modashCountry.json');
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const raw = require(dataPath);

  // Many APIs return { locations: [...], total, error }, support both
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.locations) ? raw.locations : [];

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('No country records found in data/modashCountry.js');
  }
  return list;
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!uri) {
    throw new Error('Missing MONGODB_URI (or MONGO_URL) in environment.');
  }

  console.log('Connecting to MongoDB…');
  await mongoose.connect(uri, {
    // recommended modern options (Mongoose 7+ keeps it simple)
  });
  console.log('Connected.');

  const list = loadCountryData();

  // Build bulk upserts
  const ops = list
    .map((c) => {
      // Accept multiple input shapes
      const countryId = Number(c.countryId ?? c.id);
      const name = String(c.name ?? '').trim();
      const title = String(c.title ?? c.name ?? '').trim();

      if (!Number.isFinite(countryId) || !name || !title) {
        console.warn('Skipping invalid record:', c);
        return null;
      }

      return {
        updateOne: {
          filter: { countryId },
          update: {
            $set: { countryId, name, title },
          },
          upsert: true,
        },
      };
    })
    .filter(Boolean);

  if (!ops.length) {
    throw new Error('No valid records to upsert.');
  }

  console.log(`Upserting ${ops.length} countries…`);
  const result = await ModashCountry.bulkWrite(ops, { ordered: false });

  console.log('Bulk upsert complete.');
  console.log({
    matched: result.matchedCount,
    modified: result.modifiedCount,
    upserted: result.upsertedCount,
  });

  await mongoose.disconnect();
  console.log('Disconnected. ✅ Done.');
}

main().catch(async (err) => {
  console.error('❌ Seed failed:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
