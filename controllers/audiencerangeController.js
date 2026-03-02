// controllers/audienceController.js
const Audience = require('../models/audienceRange');

/**
 * GET /audience-ranges
 * Returns all audience age-ranges.
 */
exports.getAllAudienceRanges = async (req, res) => {
  try {
    // fetch only the UUID and range, sorted by range
    const ranges = await Audience
      .find({}, 'audienceId range')
      .sort('range');
    return res.status(200).json(ranges);
  } catch (err) {
    console.error('Error fetching audience ranges:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
