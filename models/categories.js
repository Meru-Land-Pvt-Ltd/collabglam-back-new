const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const SubcategorySchema = new Schema({
  name: { type: String, required: true, trim: true },
  tags: { type: [String], default: [] },
});

const CategorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    globalTags: { type: [String], default: [] },
    subcategories: { type: [SubcategorySchema], default: [] },
  },
  { timestamps: true }
);

CategorySchema.index(
  { name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

CategorySchema.index(
  {
    name: "text",
    globalTags: "text",
    "subcategories.name": "text",
    "subcategories.tags": "text",
  },
  { name: "category_fulltext_search", default_language: "none" }
);

CategorySchema.pre("validate", function () {
  const doc = this;

  const norm = (s) => (s ?? "").trim();
  const normTag = (s) => norm(s).replace(/^#/, "").toLowerCase();

  doc.name = norm(doc.name);
  if (!doc.name) throw new Error("Category name cannot be empty");

  {
    const seen = new Set();
    doc.globalTags = (doc.globalTags ?? [])
      .map(normTag)
      .filter(Boolean)
      .filter((t) => {
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      });
  }

  {
    const seenSubs = new Set();
    doc.subcategories = (doc.subcategories ?? []).map((s) => {
      const name = norm(s.name);
      const key = name.toLowerCase();

      if (!name) throw new Error("Subcategory name cannot be empty");
      if (seenSubs.has(key)) throw new Error(`Duplicate subcategory: "${name}"`);
      seenSubs.add(key);

      const seenTags = new Set();
      const tags = (s.tags ?? [])
        .map(normTag)
        .filter(Boolean)
        .filter((t) => {
          if (seenTags.has(t)) return false;
          seenTags.add(t);
          return true;
        });

      return { ...(s.toObject?.() ?? s), name, tags };
    });
  }
});

const Category = model("Category", CategorySchema);

module.exports = { Category };