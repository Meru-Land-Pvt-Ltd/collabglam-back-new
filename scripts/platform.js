require('dotenv').config();
const mongoose = require('mongoose');
const Platform = require('../models/platform');

// Array of social media platforms to seed\const 
const platforms = 
[
  'Instagram',
  'YouTube',
  'TikTok',
  'Twitter',
  'Facebook',
  'LinkedIn',
  'Other'
];

async function seedPlatforms() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('Connected to database');

    for (const name of platforms) {
      // Upsert platform by name
      const result = await Platform.findOneAndUpdate(
        { name },
        { name },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      console.log(`Seeded: ${result.name}`);
    }

    console.log('Seeding complete');
  } catch (err) {
    console.error('Error seeding platforms:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from database');
  }
}

seedPlatforms();
