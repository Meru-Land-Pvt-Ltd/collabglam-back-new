const mongoose = require('mongoose');

/**
 * Mongoose schema and model for audience size ranges.
 * Stores only a string 'range', e.g. "1k - 10k".
 */
const audienceRangeSchema = new mongoose.Schema({
  range: { type: String, required: true, unique: true }
}, { timestamps: true });

module.exports = mongoose.model('AudienceRange', audienceRangeSchema);