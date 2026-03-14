const mongoose = require("mongoose");
const { Schema, model, Types } = mongoose;

const AttachmentSchema = new Schema(
  {
    url: { type: String, required: true },
    originalName: { type: String, default: null },
    mimeType: { type: String, default: null },
    size: { type: Number, default: null },
  },
  { _id: false }
);

const MessageSchema = new Schema(
  {
    messageId: {
      type: String,
      default: () => `MSG-${new Types.ObjectId().toString().slice(-8).toUpperCase()}`,
    },
    authorRole: {
      type: String,
      enum: ["Admin", "Brand", "Influencer"],
      required: true,
    },
    authorId: { type: String, required: true },
    text: { type: String, default: "" },
    attachments: { type: [AttachmentSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const SupportTicketSchema = new Schema(
  {
    ticketId: {
      type: String,
      unique: true,
      index: true,
    },

    requesterRole: {
      type: String,
      enum: ["Brand", "Influencer"],
      required: true,
      index: true,
    },
    requesterId: { type: String, required: true, index: true },
    requesterName: { type: String, default: null },
    requesterEmail: { type: String, default: null },

    category: { type: String, required: true, trim: true },

    relatedCampaignId: { type: String, default: null },
    relatedCampaignName: { type: String, default: null },

    description: { type: String, required: true, trim: true },
    attachments: { type: [AttachmentSchema], default: [] },

    status: {
      type: String,
      enum: ["open", "in_progress", "waiting_on_user", "resolved", "closed"],
      default: "open",
      index: true,
    },

    assignedTo: {
      adminId: { type: String, default: null },
      name: { type: String, default: null },
    },

    messages: { type: [MessageSchema], default: [] },

    lastMessageAt: { type: Date, default: Date.now },
    lastMessageByRole: {
      type: String,
      enum: ["Admin", "Brand", "Influencer", null],
      default: null,
    },
  },
  { timestamps: true }
);

SupportTicketSchema.pre("validate", function (next) {
  if (!this.ticketId) {
    const suffix = new Types.ObjectId().toString().slice(-6).toUpperCase();
    this.ticketId = `SUP-${suffix}`;
  }
  next();
});

module.exports =
  mongoose.models.SupportTicket || model("SupportTicket", SupportTicketSchema);