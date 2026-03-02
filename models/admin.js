// models/admin.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs'); 

const adminSchema = new mongoose.Schema({
  adminId: {
    type: String,
    required: true,
    unique: true,
    default: uuidv4
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,                 // re-validates any upper-case
    match: [
      // RFC-5322–friendly pattern (case-insensitive by default)
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      'Please provide a valid e-mail'
    ]
  },
  password: {
    type: String,
    required: true,
    minlength: 8                     // tweak as you like
  }
}, { timestamps: true });

/* Hash before save */
adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

/* Instance helper for login */
adminSchema.methods.correctPassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
