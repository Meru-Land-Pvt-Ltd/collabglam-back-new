// scripts/backfill_ac_bulk.js
require('dotenv').config();
const mongoose = require('mongoose');
const Influencer = require('../models/influencer'); // for collection + schema typing
const { edgeNgrams, charNgrams } = require('../utils/searchTokens');

const AC_FIELDS = ['name', 'categoryName', 'platformName', 'country', 'socialMedia', 'bio'];

const normalize = (s) => (typeof s === 'string' ? s.toLowerCase().trim() : '');

function buildACTokensFromPlain(doc) {
  const bag = [];

  const pushFor = (val) => {
    const norm = normalize(val);
    if (!norm) return;
    bag.push(...edgeNgrams(norm));       // word-prefixes
    bag.push(...charNgrams(norm, 2, 4)); // sliding char n-grams (so "sh" in "Devansh" works)
  };

  for (const f of AC_FIELDS) {
    const v = doc[f];
    if (!v) continue;
    if (Array.isArray(v)) v.forEach(pushFor);
    else pushFor(v);
  }

  // dedupe + cap
  return Array.from(new Set(bag.filter(Boolean))).slice(0, 2000);
}

(async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/your_db';
  await mongoose.connect(uri);

  try {
    // ensure index (won't throw if exists)
    await Influencer.collection.createIndex({ _ac: 1 });

    const cursor = Influencer.find({}, {
      _id: 1,
      name: 1,
      categoryName: 1,
      platformName: 1,
      country: 1,
      socialMedia: 1,
      bio: 1
    }).lean().cursor();

    const ops = [];
    let total = 0, batch = 0;

    for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
      const tokens = buildACTokensFromPlain(doc);
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { _ac: tokens } }
        }
      });

      if (ops.length >= 500) {
        await Influencer.bulkWrite(ops, { ordered: false });
        total += ops.length; batch++;
        console.log(`Bulk #${batch} wrote ${ops.length} ops (total ${total})`);
        ops.length = 0;
      }
    }

    if (ops.length) {
      await Influencer.bulkWrite(ops, { ordered: false });
      total += ops.length; batch++;
      console.log(`Bulk #${batch} wrote ${ops.length} ops (total ${total})`);
    }

    console.log('Backfill complete. Total updated docs:', total);
  } catch (err) {
    console.error('Backfill error:', err);
  } finally {
    await mongoose.disconnect();
  }
})();
