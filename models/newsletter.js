// models/newsletter.js

const mongoose = require('mongoose');

const newsLetterSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  }
}, {
  timestamps: true
});

const NewsLetter = mongoose.models.NewsLetter ||
                  mongoose.model('NewsLetter', newsLetterSchema);

module.exports = NewsLetter;
