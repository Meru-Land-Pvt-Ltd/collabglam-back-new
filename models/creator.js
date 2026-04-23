const mongoose = require("mongoose");

const { Schema } = mongoose;

const creatorSchema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },

    username: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    handle: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    fullname: {
      type: String,
      default: "",
      trim: true,
    },

    followers: {
      type: Number,
      default: 0,
    },

    engagementRate: {
      type: Number,
      default: 0,
    },

    engagements: {
      type: Number,
      default: 0,
    },

    averageViews: {
      type: Number,
      default: 0,
    },

    picture: {
      type: String,
      default: "",
      trim: true,
    },

    url: {
      type: String,
      default: "",
      trim: true,
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    isPrivate: {
      type: Boolean,
      default: false,
    },

    platform: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    bio: {
      type: String,
      default: "",
      trim: true,
    },

    country: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    location: {
      type: String,
      default: "",
      trim: true,
    },

    categories: {
      type: [String],
      default: [],
    },

    searchType: {
      type: String,
      default: "standard",
      trim: true,
      lowercase: true,
    },

    source: {
      type: String,
      default: "standard",
      trim: true,
      lowercase: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "creators",
    toJSON: {
      transform(_doc, ret) {
        ret.creatorId = String(ret._id);
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        ret.creatorId = String(ret._id);
        return ret;
      },
    },
  }
);

creatorSchema.index({ userId: 1, platform: 1 }, { unique: true });
creatorSchema.index({ username: 1, platform: 1 });
creatorSchema.index({ handle: 1, platform: 1 });
creatorSchema.index({ followers: -1 });

module.exports = mongoose.models.Creators || mongoose.model("Creators", creatorSchema);