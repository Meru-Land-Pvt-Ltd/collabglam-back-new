// models/emailAlias.js
const mongoose = require('mongoose');

const emailAliasSchema = new mongoose.Schema({
  ownerModel: {
    type: String,
    enum: ['Brand', 'Influencer'],
    required: true,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'ownerModel',
    required: true,
  },

  // Proxy email actually used on the wire, e.g. alexroy@collabglam.com
  proxyEmail: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    index: true,
  },

  // Real login / external email, if known
  externalEmail: {
    type: String,
    lowercase: true,
    index: true,
  },

  status: {
    type: String,
    enum: ['active', 'pending_claim', 'revoked'],
    default: 'active',
    index: true,
  },

  verifiedAt: Date,

  // For future flexibility: per-alias metadata
  meta: {
    type: mongoose.Schema.Types.Mixed,
  },
}, { timestamps: true });

emailAliasSchema.index({ ownerModel: 1, owner: 1, externalEmail: 1 });

module.exports = mongoose.model('EmailAlias', emailAliasSchema);
