// controllers/filterController.js
const Influencer = require('../models/influencer');
const { escapeRegExp } = require('../utils/searchTokens');

/**
 * POST /api/influencers/getlist
 */
exports.getFilteredInfluencers = async (req, res) => {
  try {
    const {
      categories,
      audienceRange,
      ageGroup,
      gender,
      countryId,
      platformId,
      malePercentage,
      femalePercentage,
      search,
      page = 1,
      limit = 10
    } = req.body || {};

    const filter = {};

    // categories: array of ObjectIds/ids
    if (Array.isArray(categories) && categories.length) {
      filter.categories = { $in: categories };
    }

    // simple string fields stored in doc
    if (typeof audienceRange === 'string') filter.audienceRange = audienceRange;
    if (typeof ageGroup === 'string') filter.audienceAgeRange = ageGroup;

    // gender enum [0,1,2]
    if ([0, 1, 2].includes(Number(gender))) filter.gender = Number(gender);

    // countryId: accept array or scalar
    if (Array.isArray(countryId) && countryId.length) {
      filter.countryId = { $in: countryId };
    } else if (countryId) {
      filter.countryId = countryId;
    }

    // platform
    if (platformId) filter.platformId = platformId;

    // audience bifurcation
    if (typeof malePercentage === 'number') {
      filter['audienceBifurcation.malePercentage'] = { $gte: malePercentage };
    }
    if (typeof femalePercentage === 'number') {
      filter['audienceBifurcation.femalePercentage'] = { $gte: femalePercentage };
    }

    // 🔎 Search: fast prefix on _ac + robust fallbacks
    if (typeof search === 'string' && search.trim()) {
      const raw = search.trim();
      const q = raw.toLowerCase();

      // _ac is expected to be lowercase "search tokens"
      const rxAcPrefix = new RegExp('^' + escapeRegExp(q));
      // case-insensitive prefix for human-facing fields
      const rxPrefixI = new RegExp('^' + escapeRegExp(raw), 'i');
      // word-boundary-ish prefix for categoryName etc.
      const rxWordPrefixI = new RegExp('(?:^|\\s)' + escapeRegExp(raw), 'i');

      // Use $or so lack of _ac doesn't zero out results
      filter.$or = [
        { _ac: { $regex: rxAcPrefix } },        // fast path if _ac is present/lowercased
        { name: { $regex: rxPrefixI } },
        { platformName: { $regex: rxPrefixI } },
        { country: { $regex: rxPrefixI } },
        { socialMedia: { $regex: rxPrefixI } },
        // If categoryName is an array of strings, regex on field matches any element
        { categoryName: { $regex: rxWordPrefixI } }
      ];
    }

    // pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const perPage = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const skip = (pageNum - 1) * perPage;

    // sorting: keep existing behavior when no search; otherwise sort by name for stability
    const sortSpec = (typeof search === 'string' && search.trim())
      ? { name: 1 }
      : { audienceRange: 1 };

    const [totalCount, influencers] = await Promise.all([
      Influencer.countDocuments(filter),
      Influencer.find(filter)
        .select('-_ac')              // ⬅️ hide server-side search tokens from response
        .skip(skip)
        .limit(perPage)
        .sort(sortSpec)
        .lean()
    ]);

    res.json({
      success: true,
      page: pageNum,
      perPage,
      totalPages: Math.ceil(totalCount / perPage),
      totalCount,
      count: influencers.length,
      data: influencers
    });
  } catch (err) {
    console.error('Error in getFilteredInfluencers:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};
