// controllers/platformController.js
const Platform = require('../models/platform');

/**
 * GET /platforms
 * Returns all social-media platforms.
 */
exports.getAllPlatforms = async (req, res) => {
  try {
    // fetch only the UUID and name
    const platforms = await Platform.find({}, 'platformId name').sort('name');
    return res.status(200).json(platforms);
  } catch (err) {
    console.error('Error fetching platforms:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
