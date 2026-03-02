// scripts/seedBusinessTypes.js
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const BusinessType = require('../models/businessType');

dotenv.config();

// Expanded list; names only
const BUSINESS_TYPES = [
  'Direct-to-Consumer',
  'Agency',
  'Marketplace',
  'SaaS',
  'E-commerce',
  'Retail',
  'B2B',
  'B2C',
  'Distributor / Wholesaler',
  'Manufacturer / OEM',
  'Franchise',
  'Nonprofit',
  'Media / Publisher',
  'Affiliate Network',
  'Consulting / Services',
  'Dropshipping',
  'Other',
];

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    let created = 0;
    for (const name of BUSINESS_TYPES) {
      const res = await BusinessType.updateOne(
        { name },
        { $setOnInsert: { name } },
        { upsert: true }
      );
      // res.upsertedCount isn’t always present; check upsertedId or matchedCount
      if (res.upsertedId || res.upsertedCount === 1) created += 1;
    }

    const total = await BusinessType.countDocuments({});
    console.log(`✅ Seed finished. Created: ${created}. Total in collection: ${total}.`);
    console.log('ℹ️  Non-destructive: existing types kept, new ones added.');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error seeding business types:', err);
    process.exit(1);
  }
})();
