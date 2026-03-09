const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const ProductServiceGoalSchema = new Schema(
  {
    goal: { type: String, required: true, trim: true, unique: true },
    sortOrder: { type: Number, required: true, index: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const ProductServiceGoalModel =
  models.ProductServiceGoal ||
  model("ProductServiceGoal", ProductServiceGoalSchema);

module.exports = { ProductServiceGoalModel };