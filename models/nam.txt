// models/categories.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const subcategorySchema = new mongoose.Schema(
  {
    subcategoryId: {
      type: String,
      required: true,
      unique: true,          // unique across the whole collection
      default: uuidv4,       // auto-generate v4 UUID
      immutable: true,
      match: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const categoriesSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    subcategories: {
      type: [subcategorySchema],
      default: [],
    },
  },
  {
    timestamps: true,
    id: false,
    versionKey: false,
  }
);

// Ensure UUID uniqueness across all subdocuments
categoriesSchema.index({ 'subcategories.subcategoryId': 1 }, { unique: true, sparse: true });

// Guardrail: no duplicate subcategory names within the same category
categoriesSchema.path('subcategories').validate(function (subs) {
  const names = subs.map((s) => s.name.trim().toLowerCase());
  return names.length === new Set(names).size;
}, 'Subcategory names must be unique within a category.');

// Backfill UUIDs if any subcategory is missing one
categoriesSchema.pre('validate', function (next) {
  this.subcategories = (this.subcategories || []).map((s) => ({
    name: s.name,
    subcategoryId: s.subcategoryId || uuidv4(),
  }));
  next();
});

module.exports = mongoose.model('Category', categoriesSchema);
