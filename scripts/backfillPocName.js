// scripts/backfillPocName.js
require('dotenv').config();
const mongoose = require('mongoose');
const Brand = require('../models/brand'); // adjust the path if needed

const MONGO_URI = process.env.MONGODB_URI

async function run() {
  await mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  console.log('Connected to MongoDB');

  // Option 1: Use aggregation-style update (MongoDB 4.2+)
  try {
    const result = await Brand.updateMany(
      {
        $or: [
          { pocName: { $exists: false } },
          { pocName: null },
          { pocName: '' },
        ],
      },
      [
        {
          $set: {
            pocName: '$name',
          },
        },
      ]
    );

    console.log('Matched:', result.matchedCount || result.nMatched);
    console.log('Modified:', result.modifiedCount || result.nModified);
  } catch (err) {
    console.error('Aggregation-style update failed:', err);
    console.log('Falling back to manual cursor approach...');

    // Option 2: Fallback if your Mongo doesn’t support pipeline updates
    const cursor = Brand.find({
      $or: [
        { pocName: { $exists: false } },
        { pocName: null },
        { pocName: '' },
      ],
    }).cursor();

    let count = 0;
    for await (const brand of cursor) {
      brand.pocName = brand.name || '';
      // avoid unnecessary validation overhead
      await brand.save({ validateBeforeSave: false });
      count++;
      if (count % 100 === 0) {
        console.log(`Updated ${count} brands so far...`);
      }
    }
    console.log(`Finished. Updated ${count} brands.`);
  }

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB');
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
