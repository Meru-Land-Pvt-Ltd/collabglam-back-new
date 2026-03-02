// models/delieverable.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const deliverableUrlSchema = new mongoose.Schema(
  {
    label: { type: String, default: "" },
    url: { type: String, required: true },
  },
  { _id: false }
);

const delieverableSchema = new mongoose.Schema({
  delieverableApprovalId: {
    type: String,
    default: uuidv4,
    unique: true,
    index: true,
  },

  brandId: { type: String, required: true, ref: "Brand" },
  influencerId: { type: String, required: true, ref: "Influencer" },
  campaignId: { type: String, required: true, ref: "Campaign" },

  // ✅ ROOT milestone document id (Milestone.milestoneId)
  milestoneId: { type: String, required: true, ref: "Milestone", index: true },

  // ✅ NESTED milestone history id (Milestone.milestoneHistory[].milestoneHistoryId)
  milestoneHistoryId: { type: String, required: true, index: true },

  title: { type: String, required: true },
  description: { type: String, default: "" },

  status: {
    type: String,
    enum: ["pending", "revision", "approved"],
    default: "pending",
    index: true,
  },

  approvedRole: {
    type: String,
    default: "",
  },

  approvalId: { type: String, default: "" },
  comments: { type: String, default: "" },

  url: { type: [deliverableUrlSchema], default: [] },

  createdAt: { type: Date, default: Date.now, index: true },
  updatedDate: { type: Date, default: Date.now },
});

// ✅ Useful compound indexes for faster listing / filtering
delieverableSchema.index({ campaignId: 1, createdAt: -1 });
delieverableSchema.index({ campaignId: 1, status: 1, createdAt: -1 });
delieverableSchema.index({ influencerId: 1, campaignId: 1 });

delieverableSchema.pre("save", function (next) {
  this.updatedDate = new Date();
  next();
});

delieverableSchema.pre("findOneAndUpdate", function (next) {
  this.set({ updatedDate: new Date() });
  next();
});

module.exports =
  mongoose.models.delieverable ||
  mongoose.model("delieverable", delieverableSchema);