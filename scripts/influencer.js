// scripts/seedInfluencerInterests.js

const mongoose = require('mongoose');
const Interest = require('../models/interest');
require('dotenv').config();

// A curated list of interests tailored specifically for influencers.
// Feel free to add or remove items as needed.
const INFLUENCER_INTERESTS = [
  'Fashion',
  'Beauty',
  'Lifestyle',
  'Fitness',
  'Health',
  'Wellness',
  'Travel',
  'Food',
  'Photography',
  'Music',
  'Gaming',
  'Tech',
  'Beauty & Makeup',
  'Skincare',
  'Haircare',
  'Nutrition',
  'Yoga',
  'Pilates',
  'Gym',
  'Vegan Cooking',
  'Baking',
  'Home Decor',
  'Interior Design',
  'DIY',
  'Parenting',
  'Pets',
  'Pets & Animals',
  'Outdoor Adventures',
  'Sustainability',
  'Eco-Friendly Living',
  'Minimalism',
  'Luxury Lifestyle',
  'Streetwear',
  'High Fashion',
  'Fitness Coaching',
  'Mental Health',
  'Self-Care',
  'Mindfulness',
  'Motivation',
  'Beauty Tutorials',
  'Travel Vlogging',
  'Food Blogging',
  'Street Style',
  'Celebrity News',
  'Event Coverage',
  'Influencer Marketing',
  'Collaboration & Partnerships'
];

(async () => {
  try {
    // 1) Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('MongoDB connected for seeding influencer interests.');

    // 2) Loop through each interest; insert if not already present (case-insensitive match)
    for (const name of INFLUENCER_INTERESTS) {
      const exists = await Interest.findOne({ name: new RegExp(`^${name}$`, 'i') });
      if (!exists) {
        await new Interest({ name }).save();
        console.log(`Inserted interest: ${name}`);
      } else {
        console.log(`Skipped (already exists): ${name}`);
      }
    }

    console.log('Influencer interest seeding complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error seeding influencer interests:', err);
    process.exit(1);
  }
})();
