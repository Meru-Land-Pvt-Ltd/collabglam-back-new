// models/notification.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const NotificationSchema = new mongoose.Schema(
  {
    notificationId: { type: String, required: true, default: uuidv4 },

    // Exactly one of these must be present:
    brandId: { type: String, default: null, index: true },
    influencerId: { type: String, default: null, index: true },
    adminId: { type: String, default: null, index: true },
    type: { type: String, required: true },          // e.g. "campaign.match", "contract.accepted", "apply.submitted"
    title: { type: String, required: true },
    message: { type: String, default: '' },

    entityType: { type: String, default: null },     // e.g. "campaign" | "contract" | "apply"
    entityId: { type: String, default: null },       // e.g. campaignsId or contractId

    actionPath: { type: String, default: null },

    isRead: { type: Boolean, default: false }
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

// XOR validation: must target brand OR influencer (not both, not none)
NotificationSchema.pre("validate", function (next) {
  const recipients = [this.brandId, this.influencerId, this.adminId].filter(
    (v) => v !== null && v !== undefined && String(v).trim() !== ""
  );

  if (recipients.length !== 1) {
    return next(
      new Error(
        "Notification must target exactly one recipient: brandId, influencerId, or adminId."
      )
    );
  }

  next();
});

// Useful dedupe index if you want one-per-entity per recipient per type
NotificationSchema.index(
  { brandId: 1, influencerId: 1, entityType: 1, entityId: 1, type: 1 },
  { unique: false }
);

module.exports = mongoose.model('Notification', NotificationSchema);
