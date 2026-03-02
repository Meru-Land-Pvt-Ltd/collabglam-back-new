// models/faq.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const faqSchema = new mongoose.Schema({
  faqId: {
    type: String,
    default: uuidv4,
    unique: true
  },
  question: {
    type: String,
    required: true
  },
  answer: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedDate: {
    type: Date,
    default: Date.now
  }
});

const FAQ = mongoose.models.FAQ || mongoose.model('FAQ', faqSchema);
module.exports = FAQ;
