// models/platform.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');


const platformSchema = new mongoose.Schema({
      platformId: {
    type: String,
    required: true,
    unique: true,
    default: uuidv4
  },
  name: {
    type: String,
    required: true,
    unique: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Platform', platformSchema);
