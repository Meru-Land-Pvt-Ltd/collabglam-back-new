const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const policySchema = new mongoose.Schema({
  policyId: {
    type: String,
    default: uuidv4,
    unique: true
  },
  policyType: {
    type: String,
    enum: [
      'Terms of Service',
      'Privacy Policy',
      'Returns Policy',
      'Shipping & Delivery',
      'Cookie Policy'
    ],
    required: true,
    unique: true
  },
  effectiveDate: {
    type: Date,
    required: true
  },
  updatedDate: {
    type: Date,
    default: Date.now
  },
  content: {
    type: String,
    required: true
  }
});

const Policy = mongoose.models.Policy || mongoose.model('Policy', policySchema);

module.exports = Policy;
