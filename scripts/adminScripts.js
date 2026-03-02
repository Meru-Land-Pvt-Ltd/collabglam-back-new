// scripts/initAdmin.js
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/admin');

(async () => {
  try {
    const { MONGODB_URI, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

    if (!MONGODB_URI) throw new Error('Set MONGODB_URI in .env');
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      throw new Error('Set ADMIN_EMAIL & ADMIN_PASSWORD in .env');
    }

    await mongoose.connect(MONGODB_URI);

    const email = ADMIN_EMAIL.toLowerCase();

    // Delete any existing admin(s) with the same email
    const delRes = await Admin.deleteMany({ email: new RegExp(`^${email}$`, 'i') });

    // If you want to delete ALL admins every time, use:
    // const delRes = await Admin.deleteMany({});

    console.log(`🗑️  Removed ${delRes.deletedCount} existing admin(s).`);

    // Create fresh admin (ensure your Admin model hashes password on save)
    await Admin.create({ email, password: ADMIN_PASSWORD });

    console.log('🎉 Admin user seeded successfully:', email);
    process.exit(0);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
})();
