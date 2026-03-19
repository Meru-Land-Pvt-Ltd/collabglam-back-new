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
      required: true,
    },

    bdmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      required: true,
    },
    idmId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Master",
      required: true,
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