const mongoose = require('mongoose');


const LanguageSchema = new mongoose.Schema(
{
code: { type: String, required: true, trim: true, unique: true, index: true },
name: { type: String, required: true, trim: true }
},
{ timestamps: true }
);


LanguageSchema.index({ name: 1 });


module.exports = mongoose.model('Language', LanguageSchema);