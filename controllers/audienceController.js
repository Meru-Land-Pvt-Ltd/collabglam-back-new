// controllers/audienceController.js
const AudienceRange = require('../models/audience');

/**
 * GET /api/audience
 * Returns a list of all audience ranges
 */
exports.getList = async (req, res) => {
  try {
    const audienceRanges = await AudienceRange.find();
    return res.status(200).json(audienceRanges);
  } catch (error) {
    console.error('Error fetching audience ranges:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
