// models/chat.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const attachmentSchema = new mongoose.Schema({
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
  storage: { type: String, enum: ['local', 'remote', 'gridfs'], default: 'local' },
  gridfsFilename: { type: String, default: null },
  gridfsId: { type: String, default: null }
}, { _id: false });

const replySnapshotSchema = new mongoose.Schema({
  messageId: { type: String, required: true },
  senderId: { type: String, required: true },
  text: { type: String, default: '' },
  hasAttachment: { type: Boolean, default: false },
  attachment: {
    originalName: { type: String, default: null },
    mimeType: { type: String, default: null }
  }
}, { _id: false });

const messageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true, default: uuidv4 },
  senderId: { type: String, required: true },
  text: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
  editedAt: { type: Date, default: null },
  replyTo: { type: String, default: null },
  reply: { type: replySnapshotSchema, default: null },
  attachments: { type: [attachmentSchema], default: [] },
  seenBy: { type: [String], default: [] },

  // ✅ NEW: track who we’ve already emailed for this specific message
  emailNotified: { type: [String], default: [] },              // array of userIds
  emailNotifiedAt: { type: Map, of: Date, default: {} }        // userId -> Date
}, { _id: false });

const participantSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['brand', 'influencer', 'other'], default: 'other' }
}, { _id: false });

const chatRoomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true, default: uuidv4 },
  participants: { type: [participantSchema], required: true },
  messages: { type: [messageSchema], default: [] },

  // kept for backwards compatibility (no longer required for throttling)
  lastNotificationSent: { type: Map, of: Date, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('ChatRoom', chatRoomSchema);
