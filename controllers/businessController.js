// controllers/businessController.js
const BusinessType = require('../models/businessType');
const { escapeRegExp } = require('../utils/searchTokens'); // same helper used elsewhere


exports.getList = async (req, res) => {
  try {
    const {
      q,
      page = 1,
      limit = 100,
      order = 'asc',
    } = req.query || {};

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
    const sortDir = String(order).toLowerCase() === 'desc' ? -1 : 1;

    const filter = q
      ? { name: new RegExp(escapeRegExp(String(q).trim()), 'i') }
      : {};

    const [total, items] = await Promise.all([
      BusinessType.countDocuments(filter),
      BusinessType.find(filter)
        .select('name') // keep it minimal; include _id by default
        .sort({ name: sortDir })
        .skip((pageNum - 1) * pageSize)
        .limit(pageSize)
        .lean(),
    ]);

    return res.status(200).json({
      items,
      total,
      page: pageNum,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error('Error in BusinessType.getList:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
