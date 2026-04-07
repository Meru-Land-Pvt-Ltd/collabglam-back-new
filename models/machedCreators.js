const mongoose = require('mongoose');

const matchedCreatorSchema = new mongoose.Schema(
  {
    productType: {
      type: String,
      required: true,
      trim: true,
    },
    budget: {
      type: String,
      required: true,
      trim: true,
    },
    market: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('MatchedCreator', matchedCreatorSchema);