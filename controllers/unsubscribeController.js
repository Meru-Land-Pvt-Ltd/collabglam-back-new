const Brand = require('../models/brand');
const Influencer = require('../models/influencer');

const escapeRegExp = (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.unsubscribe = async (req, res) => {
  const { email } = req.query; // Assuming email is passed as a query parameter

  if (!email) {
    return res.status(400).send('Email is required.');
  }

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const emailQuery = { email: new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i') };

    // Try to find and unsubscribe a brand
    let user = await Brand.findOneAndUpdate(
      emailQuery,
      { $set: { isUnsubscribed: true } },
      { new: true }
    );

    if (!user) {
      // If not a brand, try to find and unsubscribe an influencer
      user = await Influencer.findOneAndUpdate(
        emailQuery,
        { $set: { isUnsubscribed: true } },
        { new: true }
      );
    }

    if (user) {
      return res.status(200).send('You have been successfully unsubscribed.');
    } else {
      return res.status(404).send('User not found.');
    }
  } catch (error) {
    console.error('Error unsubscribing:', error);
    return res.status(500).send('An error occurred during unsubscription.');
  }
};
