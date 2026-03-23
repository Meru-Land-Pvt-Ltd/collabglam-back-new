// models/BrandAssigned.js
const mongoose = require("mongoose");

const brandAssignedSchema = new mongoose.Schema(
  {
    brandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
    },

    RHId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master", 
      default: null,
    },

    bdmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      default: null,
    },
    idmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      default: null,
    },

    status: {
      type: String,
      enum: ["active", "inactive", "pending"],
      default: "active",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("BrandAssigned", brandAssignedSchema);