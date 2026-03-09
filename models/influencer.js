// src/model/influencer.js
const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const NamedRefSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: false },
    name: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const InfluencerSchema = new Schema(
  {

    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, trim: true },

    // ✅ country
    countryId: { type: Schema.Types.ObjectId, ref: "Country", required: false },
    countryName: { type: String, required: true, trim: true },

    // ✅ multi-select language
    languages: { type: [NamedRefSchema], default: [] },

    // ✅ multi-select categories
    categories: { type: [NamedRefSchema], default: [] },

    password: { type: String },

    // ✅ onboarding pages
    page1: { type: [Schema.Types.Mixed], required: true, default: [] },
    page2: { type: [Schema.Types.Mixed], default: [] },
    page3: { type: [Schema.Types.Mixed], default: [] },

    // ✅ skip flags
    ispage2Skip: { type: Boolean, default: false },
    ispage3Skip: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const InfluencerModel = model("Influencer", InfluencerSchema);

module.exports = { InfluencerModel };