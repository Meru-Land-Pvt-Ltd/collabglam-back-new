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

    proxyEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: undefined,
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

// unique only when proxyEmail exists and is not empty
InfluencerSchema.index(
  { proxyEmail: 1 },
  {
    unique: true,
    partialFilterExpression: {
      proxyEmail: { $type: "string", $ne: "" },
    },
  }
);

const InfluencerModel = models.Influencer || model("Influencer", InfluencerSchema);

module.exports = { InfluencerModel };