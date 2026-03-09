// src/scripts/categorySeed.js

require("dotenv").config();
const mongoose = require("mongoose");
const { CategoryModel } = require("../model/category");
const { DATA } = require("../data/categorySeedData"); // or same file if DATA is here

const clean = (v) => (v ?? "").trim();
const normalizeTag = (t) => clean(t).replace(/^#/, "").toLowerCase();
const nameKey = (s) => clean(s).toLowerCase();

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const key = normalizeTag(v);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

async function upsertOneCategory(input) {
  const categoryName = clean(input?.categoryName);
  if (!categoryName) throw new Error("Category name missing");

  const incomingGlobal = uniqStrings(input?.globalTags ?? []);
  const incomingSubs = (input?.subcategories ?? [])
    .map((s) => ({
      name: clean(s?.name),
      tags: uniqStrings(s?.tags ?? []),
    }))
    .filter((s) => s.name);

  const existing = await CategoryModel.findOne({ name: categoryName }).collation({
    locale: "en",
    strength: 2,
  });

  if (!existing) {
    await CategoryModel.create({
      name: categoryName,
      globalTags: incomingGlobal,
      subcategories: incomingSubs,
    });

    console.log(
      `✅ Created "${categoryName}" | globalTags=${incomingGlobal.length} | subcategories=${incomingSubs.length}`
    );
    return;
  }

  // ---- merge global tags ----
  const mergedGlobal = uniqStrings([...(existing.globalTags ?? []), ...incomingGlobal]);

  // ---- merge subcategories ----
  const subMap = new Map();

  for (const s of existing.subcategories ?? []) {
    const k = nameKey(s.name);
    subMap.set(k, {
      name: clean(s.name),
      tags: uniqStrings(s.tags ?? []),
    });
  }

  for (const s of incomingSubs) {
    const k = nameKey(s.name);
    const prev = subMap.get(k);
    if (!prev) {
      subMap.set(k, { name: s.name, tags: s.tags });
    } else {
      prev.tags = uniqStrings([...(prev.tags ?? []), ...(s.tags ?? [])]);
    }
  }

  existing.name = categoryName;
  existing.globalTags = mergedGlobal;
  existing.subcategories = Array.from(subMap.values());

  await existing.save();

  console.log(
    `✅ Updated "${categoryName}" | globalTags=${existing.globalTags.length} | subcategories=${existing.subcategories.length}`
  );
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "";
  if (!uri) throw new Error("MONGODB_URI (or MONGO_URI) missing in env");

  await mongoose.connect(uri);
  console.log("✅ Connected");

  for (const cat of DATA || []) {
    await upsertOneCategory(cat);
  }

  await mongoose.disconnect();
  console.log("🔌 Disconnected");
}

main().catch(async (e) => {
  console.error("❌ Seed failed:", e);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});