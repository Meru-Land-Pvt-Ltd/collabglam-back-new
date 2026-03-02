require('dotenv').config();
const mongoose = require('mongoose');
const AudienceRange = require('../models/audience');
const { audienceRangeLabels } = require('../audience');

(async () => {
  try {
    // 1) Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected for seeding audience ranges.');

    // 2) Loop through each label; insert if not already present
    for (const label of audienceRangeLabels) {
      const exists = await AudienceRange.findOne({ range: label });
      if (!exists) {
        await new AudienceRange({ range: label }).save();
        console.log(`Inserted range: ${label}`);
      } else {
        console.log(`Skipped (already exists): ${label}`);
      }
    }

    console.log('Audience range seeding complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error seeding audience ranges:', err);
    process.exit(1);
  }
})();
