const mongoose = require('mongoose');

const influencerSignatureSchema = new mongoose.Schema(
  {
    influencerId: {
      type: String,
      required: true,
      index: true
    },
    signature: {
      type: String,
      default: '' // base64 data url
    },
    mimeType: {
      type: String,
      default: ''
    },
    originalName: {
      type: String,
      default: ''   
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('InfluencerSignature', influencerSignatureSchema);