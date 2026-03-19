// models/groupChat.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { ROLES } = require("./master"); // <-- adjust path if needed

const attachmentSchema = new mongoose.Schema(
  {
    attachmentId: { type: String, required: true, default: uuidv4 },
    url: { type: String, required: true },
    path: { type: String, default: null },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    duration: { type: Number, default: null },
    thumbnailUrl: { type: String, default: null },
    storage: {
      type: String,
      enum: ["local", "remote", "gridfs"],
      default: "gridfs",
    },
    gridfsFilename: { type: String, default: null },
    gridfsId: { type: String, default: null },
  },
  { _id: false }
);

const replySnapshotSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true },
    senderId: { type: String, required: true },
    text: { type: String, default: "" },
    hasAttachment: { type: Boolean, default: false },
    attachment: {
      originalName: { type: String, default: null },
      mimeType: { type: String, default: null },
    },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, default: uuidv4 },
    senderId: { type: String, required: true }, // admin _id as string
    text: { type: String, default: "" },
    timestamp: { type: Date, default: Date.now },
    editedAt: { type: Date, default: null },
    replyTo: { type: String, default: null },
    reply: { type: replySnapshotSchema, default: null },
    attachments: { type: [attachmentSchema], default: [] },
    seenBy: { type: [String], default: [] }, // admin ids
  },
  { _id: false }
);

const participantSchema = new mongoose.Schema(
  {
    adminId: { type: String, required: true }, // store as string for compatibility
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: {
      type: String,
      required: true,
      enum: [ROLES.SUPER_ADMIN, ROLES.REVENUE_HEAD, ROLES.IME, ROLES.BME],
    },
    addedBy: { type: String, default: null },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const groupChatSchema = new mongoose.Schema(
  {
    groupId: { type: String, required: true, unique: true, default: uuidv4 },
    groupName: { type: String, required: true, trim: true },
    description: { type: String, default: "" },

    createdBy: { type: String, required: true }, // revenue_head admin id
    participants: { type: [participantSchema], default: [] },
    messages: { type: [messageSchema], default: [] },
revenueHeadId: { type: String, required: true },
    lastMessageAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

groupChatSchema.index({ groupId: 1 });
groupChatSchema.index({ createdBy: 1 });
groupChatSchema.index({ "participants.adminId": 1 });
groupChatSchema.index({ lastMessageAt: -1 });
groupChatSchema.index({ revenueHeadId: 1 });

module.exports = mongoose.model("GroupChat", groupChatSchema);