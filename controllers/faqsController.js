// controllers/faqController.js
const FAQ = require('../models/faqs');

// Create a new FAQ entry
exports.createFAQ = async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ message: 'Question and answer are required.' });
    }
    const faq = new FAQ({ question, answer });
    const saved = await faq.save();
    res.status(201).json(saved);
  } catch (error) {
    console.error('Error creating FAQ:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
};

// Get all FAQs
exports.getAllFAQs = async (req, res) => {
  try {
    const list = await FAQ.find().sort({ createdAt: 1 });
    res.json(list);
  } catch (error) {
    console.error('Error fetching FAQs:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
};

// Get single FAQ by ID
exports.getFAQById = async (req, res) => {
  try {
    const { faqId } = req.body;
    if (!faqId) return res.status(400).json({ message: 'faqId is required.' });
    const record = await FAQ.findOne({ faqId });
    if (!record) return res.status(404).json({ message: 'FAQ not found.' });
    res.json(record);
  } catch (error) {
    console.error('Error fetching FAQ:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
};

// Update FAQ by ID
exports.updateFAQ = async (req, res) => {
  try {
    const { faqId, question, answer } = req.body;
    if (!faqId) return res.status(400).json({ message: 'faqId is required.' });
    const updateFields = { updatedDate: new Date() };
    if (question) updateFields.question = question;
    if (answer) updateFields.answer = answer;

    const updated = await FAQ.findOneAndUpdate(
      { faqId },
      { $set: updateFields },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: 'FAQ not found.' });
    res.json(updated);
  } catch (error) {
    console.error('Error updating FAQ:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
};

// Delete FAQ by ID
exports.deleteFAQ = async (req, res) => {
  try {
    const { faqId } = req.body;
    if (!faqId) return res.status(400).json({ message: 'faqId is required.' });
    const deleted = await FAQ.findOneAndDelete({ faqId });
    if (!deleted) return res.status(404).json({ message: 'FAQ not found.' });
    res.json({ message: 'FAQ deleted.' });
  } catch (error) {
    console.error('Error deleting FAQ:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
};
