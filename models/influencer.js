const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NamedRefSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: false },
    name: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const InfluencerSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [emailRegex, "Invalid email"],
    },

    name: { type: String, trim: true, default: "" },

    countryId: { type: Schema.Types.ObjectId, ref: "Country", required: false },
    countryName: { type: String, required: true, trim: true },

    languages: { type: [NamedRefSchema], default: [] },
    categories: { type: [NamedRefSchema], default: [] },

    password: { type: String },

    page1: { type: [Schema.Types.Mixed], required: true, default: [] },
    page2: { type: [Schema.Types.Mixed], default: [] },
    page3: { type: [Schema.Types.Mixed], default: [] },

    ispage2Skip: { type: Boolean, default: false },
    ispage3Skip: { type: Boolean, default: false },

    // optional: influencer-level default alias
    proxyEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      validate: {
        validator(value) {
          return !value || emailRegex.test(value);
        },
        message: "Invalid proxy email",
      },
    },
  },
  { timestamps: true }
);

const InfluencerModel = models.Influencer || model("Influencer", InfluencerSchema);

module.exports = { InfluencerModel };