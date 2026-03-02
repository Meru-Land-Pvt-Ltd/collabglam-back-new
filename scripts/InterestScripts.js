// scripts/upsert-categories.js
require('dotenv').config();
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const Category = require('../models/categories');
const SOURCE = require('../data/categories');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/yourdb';

async function upsertCategory(one) {
  const existing = await Category.findOne({ id: one.id });

  // Desired subcategory names in order
  const desiredNames = one.subcategories.map((s) => s.trim());

  if (!existing) {
    // Create new with fresh UUIDs
    const doc = await Category.create({
      id: one.id,
      name: one.name,
      subcategories: desiredNames.map((name) => ({ name, subcategoryId: uuidv4() })),
    });
    return { id: one.id, created: true, updated: false, removed: 0, added: desiredNames.length };
  }

  // Merge: keep UUIDs if name matches; generate for new names; drop missing
  const byName = new Map(
    (existing.subcategories || []).map((s) => [s.name.trim(), { name: s.name.trim(), subcategoryId: s.subcategoryId }])
  );

  const merged = desiredNames.map((name) => {
    const hit = byName.get(name);
    return hit ? hit : { name, subcategoryId: uuidv4() };
  });

  const removed = (existing.subcategories || []).filter(
    (s) => !desiredNames.includes(s.name.trim())
  ).length;

  existing.name = one.name;               // keep canonical name
  existing.subcategories = merged;        // replace in desired order
  await existing.save();

  const added = merged.filter((s) => !byName.has(s.name)).length;

  return { id: one.id, created: false, updated: true, removed, added };
}

(async function run() {
  await mongoose.connect(MONGODB_URI, { autoIndex: true });
  console.log('Connected:', MONGODB_URI);

  const results = [];
  for (const cat of SOURCE) {
    // Safety: ensure 8 subcategories each, trim whitespace
    cat.subcategories = (cat.subcategories || []).map((s) => s.trim());
    const res = await upsertCategory(cat);
    results.push(res);
  }

  // Optional: clean up categories that are no longer in the source list (by id)
  const validIds = new Set(SOURCE.map((c) => c.id));
  const obsolete = await Category.find({ id: { $nin: [...validIds] } }).select('id name');
  if (obsolete.length) {
    console.warn('Found categories not in source list. Leaving them untouched:', obsolete.map(o => o.id));
  }

  console.table(results);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
