// models/contactUs.js

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const contactUsSchema = new mongoose.Schema({
  contactUsId: {
    type: String,
    default: uuidv4,
    unique: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  subject: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    required: true,
    trim: true
  }
}, {
  timestamps: true
});

const ContactUs = mongoose.models.ContactUs ||
                  mongoose.model('ContactUs', contactUsSchema);

module.exports = ContactUs;
