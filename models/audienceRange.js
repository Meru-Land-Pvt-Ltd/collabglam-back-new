// models/audienceRange.js


const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const audienceSchema = new mongoose.Schema({
  audienceId: {
    type: String,
    required: true,
    unique: true,
    default: uuidv4
  },
  range: {
    type: String,
    required: true,
    unique: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Audience', audienceSchema);
