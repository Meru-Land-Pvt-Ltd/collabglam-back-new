// controllers/adminController.js
const jwt = require('jsonwebtoken');
const Admin = require('../models/admin');
const Brand = require('../models/brand'); // Assuming you have a Brand model
const Influencer = require('../models/influencer'); // Assuming you have an Influencer model
const Campaign = require('../models/campaign');
const Milestone = require('../models/milestone'); // Assuming you have a Milestone model
const Modash = require('../models/modash');
const Payment = require('../models/payment');
const escapeRegex = (s = '') => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * POST /admin/login
 * body: { email, password }
 */

const MissingEmail = require('../models/MissingEmail');
const Invitation = require('../models/NewInvitations');
const { _sendCampaignInvitationInternal } = require('../controllers/emailController');

const SubscriptionPlan = require("../models/subscription");
const PortalSettings = require("../models/portalSettings");
const subscriptionHelper = require("../utils/subscriptionHelper");

// same logic as subscriptionController (keep consistent)
function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

function buildSubscriptionFromPlan(plan, options = {}) {
  const now = new Date();

  const expire = subscriptionHelper.computeExpiry(plan, {
    billingCycle: options.billingCycle || "monthly",
    durationDays: options.durationDays,
    durationMinutes: options.durationMinutes,
    durationMins: options.durationMins,
    expiresAt: options.expiresAt, // if passed, it wins
  });

  const featureSnapshot = (plan.features || []).map((f) => ({
    key: f.key,
    limit: featureValueToLimit(f.value),
    used: 0,
  }));

  return {
    planId: plan.planId,
    planName: plan.name,
    startedAt: now,
    expiresAt: expire,
    features: featureSnapshot,
    billingCycle: options.billingCycle || "monthly", // optional (safe)
  };
}

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

async function findCampaignByAnyId(campaignId) {
  const id = String(campaignId || "").trim();
  if (!id) return null;

  // your codebase uses BOTH: _id (mongo) and campaignsId (string)
  if (isObjectId(id)) {
    const byMongo = await Campaign.findById(id).lean();
    if (byMongo) return byMongo;
  }
  return Campaign.findOne({ campaignsId: id }).lean();
}

async function findModashByUserId(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;

  // If UI passes Modash _id
  if (isObjectId(id)) {
    const byId = await Modash.findById(id).lean();
    if (byId) return byId;
  }

  // Otherwise try common fields (adjust to your schema if needed)
  return Modash.findOne({
    $or: [
      { userId: id },
      { modashUserId: id },
      { profileId: id },
      { providerUserId: id },
      { platformUserId: id },
      { "user.userId": id },
      { "profile.userId": id },
    ],
  }).lean();
}

function extractHandleFromModash(modashDoc) {
  const cand = [
    modashDoc?.handle,
    modashDoc?.username,
    modashDoc?.userName,
    modashDoc?.providerUsername,
    modashDoc?.user?.username,
    modashDoc?.profile?.username,
    modashDoc?.profile?.handle,
  ].filter(Boolean);

  if (!cand.length) return null;
  return normalizeHandle(cand[0]);
}

// ---------------- Subscription Subschemas ----------------
exports.adminAssignBrandPlan = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || "").trim();
    const planId = String(req.body?.planId || "").trim();
    const billingCycle = String(req.body?.billingCycle || "monthly").trim(); // monthly|annual

    // NEW: admin can decide duration
    const durationDays = req.body?.durationDays;
    const durationMinutes = req.body?.durationMinutes;
    const durationMins = req.body?.durationMins;
    const expiresAt = req.body?.expiresAt;

    if (!brandId || !planId) {
      return res.status(400).json({ message: "brandId and planId required" });
    }

    const plan = await SubscriptionPlan.findOne({
      planId,
      role: "Brand",
      status: "active",
    }).lean();

    if (!plan) return res.status(404).json({ message: "Brand plan not found/archived" });

    // ✅ replace undefined buildBrandSubscriptionFromPlan
    const subscription = buildSubscriptionFromPlan(plan, {
      billingCycle,
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt,
    });

    const updated = await Brand.findOneAndUpdate(
      { brandId },
      { $set: { subscription, subscriptionExpired: false } },
      { new: true }
    )
      .select("brandId name email subscription subscriptionExpired")
      .lean();

    if (!updated) return res.status(404).json({ message: "Brand not found" });

    return res.json({ status: "success", brand: updated });
  } catch (e) {
    console.error("adminAssignBrandPlan error:", e);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.adminAssignInfluencerPlan = async (req, res) => {
  try {
    const influencerId = String(req.body?.influencerId || "").trim();
    const planId = String(req.body?.planId || "").trim();

    // NEW: admin can decide duration
    const durationDays = req.body?.durationDays;
    const durationMinutes = req.body?.durationMinutes;
    const durationMins = req.body?.durationMins;
    const expiresAt = req.body?.expiresAt;

    if (!influencerId || !planId) {
      return res.status(400).json({ message: "influencerId and planId required" });
    }

    const plan = await SubscriptionPlan.findOne({
      planId,
      role: "Influencer",
      status: "active",
    }).lean();

    if (!plan) return res.status(404).json({ message: "Influencer plan not found/archived" });

    // ✅ replace undefined buildInfluencerSubscriptionFromPlan
    const subscription = buildSubscriptionFromPlan(plan, {
      billingCycle: "monthly", // optional; or allow req.body.billingCycle if you want
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt,
    });

    const updated = await Influencer.findOneAndUpdate(
      { influencerId },
      { $set: { subscription, subscriptionExpired: false } },
      { new: true }
    )
      .select("influencerId name email subscription subscriptionExpired")
      .lean();

    if (!updated) return res.status(404).json({ message: "Influencer not found" });

    return res.json({ status: "success", influencer: updated });
  } catch (e) {
    console.error("adminAssignInfluencerPlan error:", e);
    return res.status(500).json({ message: "Internal server error" });
  }
};
// shared regex for validation
const EMAIL_RX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

function normalizeHandle(h) {
  if (!h) return null;
  const t = String(h).trim();
  const withAt = t.startsWith('@') ? t : `@${t}`;
  return withAt.toLowerCase();
}

exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: 'Email & password are required' });

  const admin = await Admin.findOne({ email: email.toLowerCase() });
  if (!admin || !(await admin.correctPassword(password))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { adminId: admin.adminId, email: admin.email },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    message: 'Login successful',
    token,
    admin: { adminId: admin.adminId, email: admin.email }
  });
};


exports.getAllBrands = async (req, res) => {
  try {
    // 1) Pull pagination, search & sort params from the body
    const page = Math.max(parseInt(req.body.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 10, 1), 100);
    const search = (req.body.search || '').trim();
    const sortBy = req.body.sortBy || 'name';
    const sortOrder = (req.body.sortOrder || 'asc').toLowerCase();

    // 2) Build filter
    const filter = {};
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ name: re }, { email: re }];
    }

    // 3) Count total for meta
    const total = await Brand.countDocuments(filter);

    // 4) Validate sort inputs & build sort object
    const ALLOWED_SORT_FIELDS = ['name', 'email', 'createdAt'];
    const sortField = ALLOWED_SORT_FIELDS.includes(sortBy) ? sortBy : 'name';
    const direction = sortOrder === 'desc' ? -1 : 1;
    const sortObj = { [sortField]: direction };

    // 5) Fetch the page with dynamic sort
    const brands = await Brand.find(filter)
      .select('-password -_id -__v')
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // 6) Return structured response
    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      brands
    });
  } catch (error) {
    console.error('Error in getAllBrands:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


// controllers/influencerController.js
exports.getList = async (req, res) => {
  try {
    // 1) Pull pagination, search & sort params from the body
    const page = Math.max(parseInt(req.body.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 10, 1), 100);
    const search = (req.body.search || '').trim();
    const sortBy = req.body.sortBy || 'name';
    const sortOrder = (req.body.sortOrder || 'asc').toLowerCase();

    // 2) Build filter (searching name or email)
    const filter = {};
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ name: re }, { email: re }];
    }

    // 3) Get total count for pagination meta
    const total = await Influencer.countDocuments(filter);

    // 4) Validate sort inputs & build sort object
    const ALLOWED_SORT = ['name', 'email', 'createdAt'];
    const field = ALLOWED_SORT.includes(sortBy) ? sortBy : 'name';
    const dir = sortOrder === 'desc' ? -1 : 1;
    const sortObj = { [field]: dir };

    // 5) Fetch the page
    const influencers = await Influencer.find(filter)
      .select('-password -__v')
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // 6) Return structured response
    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      influencers
    });
  } catch (error) {
    console.error('Error fetching influencers:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(403).json({ message: "Token required" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(403).json({ message: "Token required" });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: "Invalid or expired token" });

    // your login token payload: { adminId, email }
    req.admin = decoded;
    next();
  });
};

exports.getAllCampaigns = async (req, res) => {
  try {
    // 1) Parse pagination, search, sort & status from body
    const page = Math.max(parseInt(req.body.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 10, 1), 100);
    const search = (req.body.search || '').trim();
    const sortBy = req.body.sortBy || 'createdAt';
    const sortOrder = (req.body.sortOrder || 'desc').toLowerCase();
    const statusFlag = parseInt(req.body.type, 10) || 0;  // 0 = all, 1 = active, 2 = inactive

    // 2) Build filter
    const filter = {};

    // 2a) text search on brandName, productOrServiceName or description
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [
        { brandName: re },
        { productOrServiceName: re },
        { description: re }
      ];
    }

    // 2b) status filtering on isActive
    if (statusFlag === 1) {
      filter.isActive = 1;
    } else if (statusFlag === 2) {
      filter.isActive = 0;
    }
    // (statusFlag === 0 → no filter)

    // 3) Count for pagination meta
    const total = await Campaign.countDocuments(filter);

    // 4) Validate sort field & direction
    const ALLOWED_SORT = ['brandName', 'productOrServiceName', 'createdAt', 'timeline.startDate', 'timeline.endDate'];
    const field = ALLOWED_SORT.includes(sortBy) ? sortBy : 'createdAt';
    const dir = sortOrder === 'asc' ? 1 : -1;

    // 5) Fetch paged results
    const campaigns = await Campaign.find(filter)
      .select('-__v')
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // 6) Return structured response
    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      status: statusFlag,
      campaigns
    });
  } catch (err) {
    console.error('Error in getAllCampaigns:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.getBrandById = async (req, res) => {
  try {
    const brandId = req.query.id;
    if (!brandId) return res.status(400).json({ message: 'Query parameter id is required.' });

    // exclude password, internal fields
    const brandDoc = await Brand.findOne({ brandId })
      .select('-password -_id -__v')
      .lean();
    if (!brandDoc) return res.status(404).json({ message: 'Brand not found.' });

    // fetch wallet balance
    const milestoneDoc = await Milestone.findOne({ brandId }).lean();
    const walletBalance = milestoneDoc ? milestoneDoc.walletBalance : 0;

    return res.status(200).json({ ...brandDoc, walletBalance });
  } catch (error) {
    console.error('Error in getBrandById:', error);
    return res.status(500).json({ message: 'Internal server error while fetching brand.' });
  }
};

// controllers/influencerController.js
exports.getByInfluencerId = async (req, res) => {
  try {
    // 1) Pull influencerId from query
    const influencerId = req.query.id;
    if (!influencerId) {
      return res
        .status(400)
        .json({ message: 'Query parameter id is required.' });
    }

    // 2) Fetch influencer (basic profile / onboarding / etc.)
    const influencer = await Influencer.findOne(
      { influencerId },
      '-password -__v'
    ).lean();

    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    // 3) Fetch Modash data for this influencer
    //    We try via ObjectId link *or* via influencerId string
    const modashProfiles = await Modash.find(
      {
        $or: [
          { influencer: influencer._id },              // linked via ref
          { influencerId: influencer.influencerId }    // backup by string
        ]
      },
      '-__v -providerRaw' // optional: hide heavy/raw fields
    ).lean();

    // If you only ever want the Modash for the primary platform:
    // const modashProfile = await Modash.findOne(
    //   { influencer: influencer._id, provider: influencer.primaryPlatform },
    //   '-__v -providerRaw'
    // ).lean();

    // 4) Send combined data back
    return res.status(200).json({
      influencer,
      modash: modashProfiles    // or `modash: modashProfile` if using single
    });
  } catch (error) {
    console.error('Error fetching influencer & Modash by ID:', error);
    return res
      .status(500)
      .json({ message: 'Internal server error' });
  }
};


exports.getCampaignById = async (req, res) => {
  try {
    const campaignsId = req.query.id;
    if (!campaignsId) {
      return res
        .status(400)
        .json({ message: 'Query parameter id (campaignsId) is required.' });
    }

    const campaign = await Campaign.findOne({ campaignsId }).populate('interestId', 'name');
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }
    return res.json(campaign);
  } catch (error) {
    console.error('Error in getCampaignById:', error);
    return res
      .status(500)
      .json({ message: 'Internal server error while fetching campaign.' });
  }
};



exports.getCampaignsByBrandId = async (req, res) => {
  try {
    // 1) Extract & validate brandId
    const {
      brandId,
      page: p = 1,
      limit: l = 10,
      search = '',
      sortBy = 'createdAt',
      sortOrder = 'desc',
      status = 0
    } = req.body;

    if (!brandId) {
      return res
        .status(400)
        .json({ message: 'brandId is required in the request body' });
    }

    // 2) Normalize & build base filter
    const page = Math.max(parseInt(p, 10), 1);
    const limit = Math.min(Math.max(parseInt(l, 10), 1), 100);
    const statusFlag = parseInt(status, 10) || 0;
    const filter = { brandId };

    // 2a) status filtering
    if (statusFlag === 1) filter.isActive = 1;
    else if (statusFlag === 2) filter.isActive = 0;

    // 2b) text & numeric search across whole schema
    if (search.trim()) {
      const term = search.trim();
      const re = new RegExp(term, 'i');
      const orClauses = [
        // string fields
        { brandName: re },
        { productOrServiceName: re },
        { description: re },
        { 'targetAudience.location': re },
        { interestName: re },
        { goal: re },
        { creativeBriefText: re },
        { additionalNotes: re },
        // array-of-strings fields (no $elemMatch)
        { images: re },
        { creativeBrief: re }
      ];

      // if it's a number, search numeric fields too
      const num = Number(term);
      if (!Number.isNaN(num)) {
        orClauses.push(
          { 'targetAudience.age.MinAge': num },
          { 'targetAudience.age.MaxAge': num },
          { budget: num },
          { applicantCount: num }
        );
      }

      filter.$or = orClauses;
    }

    // 3) Count total
    const total = await Campaign.countDocuments(filter);

    // 4) Sort validation
    const ALLOWED_SORT = [
      'brandName',
      'productOrServiceName',
      'createdAt',
      'timeline.startDate',
      'timeline.endDate',
      'budget'
    ];
    const field = ALLOWED_SORT.includes(sortBy) ? sortBy : 'createdAt';
    const dir = sortOrder.toLowerCase() === 'asc' ? 1 : -1;

    // 5) Fetch paged results
    const campaigns = await Campaign.find(filter)
      .select('-__v')
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // 6) Respond
    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      status: statusFlag,
      campaigns
    });
  } catch (err) {
    console.error('Error in getCampaignsByBrandId:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.adminGetInfluencerById = async (req, res) => {
  try {
    const id = req.body?.id || req.body?.influencerId;
    if (!id) {
      return res.status(400).json({ message: 'Body parameter "id" (influencerId) is required.' });
    }

    const influencer = await Influencer.findOne({ influencerId: id })
      .select('-password -__v') // return full doc except sensitive/internal fields
      .lean();

    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    return res.status(200).json({ influencer });
  } catch (err) {
    console.error('Error in adminGetInfluencerById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.adminGetInfluencerList = async (req, res) => {
  try {
    // 1) Parse inputs
    const page = Math.max(parseInt(req.body.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 10, 1), 100);
    const search = (req.body.search || '').trim();
    const sortBy = (req.body.sortBy || 'createdAt').trim();
    const sortOrder = String(req.body.sortOrder || 'desc').toLowerCase();

    // 2) Build filter (search across name/email/phone/primaryPlatform/_ac/influencerId/planName)
    const filter = {};
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { primaryPlatform: re },
        { influencerId: re },
        { _ac: re }, // tokenized autocomplete array
        { 'subscription.planName': re }
      ];
    }

    // 3) Count total
    const total = await Influencer.countDocuments(filter);

    // 4) Sorting
    const ALLOWED_SORT = new Set([
      'name',
      'email',
      'phone',
      'primaryPlatform',
      'createdAt',
      'planName',     // maps to subscription.planName
      'expiresAt'     // maps to subscription.expiresAt
    ]);
    const field = ALLOWED_SORT.has(sortBy) ? sortBy : 'createdAt';
    const dir = sortOrder === 'asc' ? 1 : -1;

    // Build sort object (handle nested plan fields)
    const sortObj = {};
    if (field === 'planName') {
      sortObj['subscription.planName'] = dir;
    } else if (field === 'expiresAt') {
      sortObj['subscription.expiresAt'] = dir;
    } else {
      sortObj[field] = dir;
    }
    // tie-breaker
    sortObj.createdAt = -1;

    // 5) Fetch data (only necessary fields + plan & expiry)
    const docs = await Influencer.find(filter)
      .select('influencerId name email phone primaryPlatform subscription.planName subscription.expiresAt subscriptionExpired createdAt')
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // 5a) Shape response and compute expiry flag robustly
    const now = new Date();
    const influencers = docs.map(d => {
      const planName = d.subscription?.planName ?? 'free';
      const expiresAt = d.subscription?.expiresAt ?? null;

      // Treat as expired if explicit flag set OR expiry date in the past
      const isExpired =
        Boolean(d.subscriptionExpired) ||
        (expiresAt ? new Date(expiresAt) < now : false);

      return {
        influencerId: d.influencerId,
        name: d.name || '',
        email: d.email || '',
        phone: d.phone || '',
        primaryPlatform: d.primaryPlatform ?? null,
        planName,
        expiresAt,
        subscriptionExpired: isExpired
      };
    });

    // 6) Respond
    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      sortBy: field,
      sortOrder: dir === 1 ? 'asc' : 'desc',
      influencers
    });
  } catch (err) {
    console.error('Error in adminGetInfluencerList:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.adminAddYouTubeEmail = async (req, res) => {
  const rawHandle = (req.body?.handle || '').trim();
  const email = (req.body?.email || '').trim();
  const platform = 'youtube'; // fixed

  if (!rawHandle || !email) {
    return res.status(400).json({
      status: 'error',
      message: 'handle and email are required',
    });
  }

  const handle = rawHandle.startsWith('@')
    ? rawHandle.toLowerCase()
    : `@${rawHandle.toLowerCase()}`;

  // 1) Upsert MissingEmail in THIS DB
  let me = await MissingEmail.findOne({ handle, platform });
  const isExisting = !!me;

  if (!me) {
    me = await MissingEmail.create({
      // missingEmailId is generated by schema (uuid)
      handle,
      platform,
      email,
      createdByAdminId: req.user?.adminId || null,
    });
  } else {
    me.email = email;
    await me.save();
  }

  // 2) Attach this MissingEmail record to any Invitations for the same handle/platform
  //    that don't yet have missingEmailId.
  try {
    await Invitation.updateMany(
      {
        handle,
        platform,
        $or: [
          { missingEmailId: { $exists: false } },
          { missingEmailId: null },
          { missingEmailId: '' },
        ],
      },
      { $set: { missingEmailId: me.missingEmailId } }
    );
  } catch (err) {
    console.error(
      'adminAddYouTubeEmail – failed to attach MissingEmail to invitations:',
      err
    );
  }

  // 3) On first creation ONLY, auto-send invitations
  //    for all brands that have this handle in their Invitation collection.
  let autoInvitesSent = 0;

  if (!isExisting) {
    try {
      const invitations = await Invitation.find({
        handle,
        platform,
      }).lean();

      for (const inv of invitations) {
        if (!inv.brandId) continue;

        try {
          await _sendCampaignInvitationInternal({
            brandId: inv.brandId,
            campaignId: inv.campaignId || null,
            invitationId: inv.invitationId,
            influencerId: null,
            campaignLink: null,
            compensation: null,
            deliverables: null,
            additionalNotes: null,
            subject: null,
            body: null,
          });
          autoInvitesSent += 1;
        } catch (sendErr) {
          console.error(
            'adminAddYouTubeEmail – failed to auto-send invitation',
            {
              invitationId: inv.invitationId,
              brandId: inv.brandId,
            },
            sendErr
          );
        }
      }
    } catch (err) {
      console.error(
        'adminAddYouTubeEmail – error while auto-sending invitations:',
        err
      );
    }
  }

  return res.json({
    status: isExisting ? 'exists' : 'saved',
    message: isExisting
      ? 'Email updated for existing handle.'
      : 'Email saved successfully.',
    data: {
      missingEmailId: me.missingEmailId,
      email: me.email,
      handle: me.handle,
      platform: me.platform,
      createdAt: me.createdAt,
      updatedAt: me.updatedAt,
      autoInvitesSent, // 🔥 how many brand invitations were auto-sent
    },
  });
};

exports.listMissingEmail = async (req, res) => {
  const body = req.body || {};

  // Pagination
  const page = Math.max(1, parseInt(body.page ?? '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '50', 10)));

  // Optional filters
  const rawSearch = typeof body.search === 'string' ? body.search.trim() : '';
  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const rawHandle = typeof body.handle === 'string' ? body.handle.trim() : '';
  const rawCreatedByAdmin = typeof body.createdByAdminId === 'string' ? body.createdByAdminId.trim() : '';

  const query = {};

  // Email filter (exact)
  if (rawEmail) {
    query.email = rawEmail;
  }

  // Handle filter (normalize to lowercase @handle, exact)
  if (rawHandle) {
    const handle = (rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`).toLowerCase();
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({ status: 'error', message: 'Invalid handle format in filter' });
    }
    query.handle = handle;
  }

  // createdByAdminId filter (exact)
  if (rawCreatedByAdmin) {
    query.createdByAdminId = rawCreatedByAdmin;
  }

  // Base fetch
  const [total, docs] = await Promise.all([
    MissingEmail.countDocuments(query),
    MissingEmail.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select({
        _id: 0,
        missingEmailId: 1,
        email: 1,
        handle: 1,
        platform: 1,
        youtube: 1,
        createdByAdminId: 1,
        createdAt: 1,
        updatedAt: 1
      })
      .lean()
  ]);

  // Optional universal search across email/handle/id/adminId
  let items = docs;
  if (rawSearch) {
    const rx = new RegExp(escapeRegex(rawSearch), 'i');
    items = items.filter(r =>
      rx.test(r.email || '') ||
      rx.test(r.handle || '') ||
      rx.test(r.missingEmailId || '') ||
      rx.test(r.createdByAdminId || '')
    );
  }

  return res.json({
    page,
    limit,
    total,
    hasNext: page * limit < total,
    data: items
  });
};

exports.updateMissingEmail = async (req, res) => {
  const missingEmailId = (req.body?.missingEmailId || '').trim();
  const newEmailRaw = (req.body?.email || '').trim().toLowerCase();

  if (!missingEmailId) {
    return res.status(400).json({
      status: 'error',
      message: 'missingEmailId is required'
    });
  }

  if (!newEmailRaw) {
    return res.status(400).json({
      status: 'error',
      message: 'email is required'
    });
  }

  if (!EMAIL_RX.test(newEmailRaw)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid email address'
    });
  }

  // Find by missingEmailId
  const doc = await MissingEmail.findOne({ missingEmailId });
  if (!doc) {
    return res.status(404).json({
      status: 'error',
      message: 'MissingEmail record not found'
    });
  }

  // 1) Update email on MissingEmail doc
  doc.email = newEmailRaw;
  await doc.save();

  // 2) Attach this MissingEmail record to any Invitations
  //    for the same handle/platform that don't yet have missingEmailId
  let autoInvitesSent = 0;

  try {
    await Invitation.updateMany(
      {
        handle: doc.handle,
        platform: doc.platform,
        $or: [
          { missingEmailId: { $exists: false } },
          { missingEmailId: null },
          { missingEmailId: '' },
        ],
      },
      { $set: { missingEmailId: doc.missingEmailId } }
    );
  } catch (err) {
    console.error(
      'updateMissingEmail – failed to attach MissingEmail to invitations:',
      err
    );
  }

  // 3) Auto-send campaign invitations for ALL invitations of this handle/platform
  try {
    const invitations = await Invitation.find({
      handle: doc.handle,
      platform: doc.platform,
    }).lean();

    for (const inv of invitations) {
      if (!inv.brandId) continue;

      try {
        await _sendCampaignInvitationInternal({
          brandId: inv.brandId,
          campaignId: inv.campaignId || null,
          invitationId: inv.invitationId,
          influencerId: null,
          campaignLink: null,
          compensation: null,
          deliverables: null,
          additionalNotes: null,
          subject: null,
          body: null,
        });
        autoInvitesSent += 1;
      } catch (sendErr) {
        console.error(
          'updateMissingEmail – failed to auto-send invitation',
          {
            invitationId: inv.invitationId,
            brandId: inv.brandId,
          },
          sendErr
        );
      }
    }
  } catch (err) {
    console.error(
      'updateMissingEmail – error while auto-sending invitations:',
      err
    );
  }

  return res.json({
    status: 'success',
    message: 'Email updated successfully.',
    data: {
      missingEmailId: doc.missingEmailId,
      email: doc.email,
      handle: doc.handle,
      platform: doc.platform,
      youtube: doc.youtube || null,
      createdByAdminId: doc.createdByAdminId || null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      autoInvitesSent, // 🔥 how many invites we auto-sent after updating
    }
  });
};

exports.checkMissingEmailByHandle = async (req, res) => {
  try {
    const rawHandle = (req.body?.handle || '').trim();
    const rawPlatform = (req.body?.platform || '').trim().toLowerCase();

    if (!rawHandle) {
      return res.status(400).json({
        status: 0,
        message: 'handle is required'
      });
    }

    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 0,
        message:
          'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-".'
      });
    }

    // MissingEmail currently only supports YouTube
    const platform = rawPlatform || 'youtube';
    if (platform !== 'youtube') {
      return res.status(400).json({
        status: 0,
        message: 'Invalid platform. MissingEmail only supports "youtube".'
      });
    }

    const doc = await MissingEmail.findOne({ handle, platform }).lean();

    if (!doc) {
      // Not found
      return res.json({
        status: 0,
        handle,
        email: null,
        platform
      });
    }

    // Found
    return res.json({
      status: 1,
      handle: doc.handle,
      email: doc.email,
      platform: doc.platform
    });
  } catch (err) {
    console.error('Error in checkMissingEmailByHandle:', err);
    return res.status(500).json({
      status: 0,
      message: 'Internal server error while checking missing email.'
    });
  }
};


exports.getAllPayments = async (req, res) => {
  try {
    // 1) Parse inputs
    const page = Math.max(parseInt(req.body.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 10, 1), 100);
    const search = (req.body.search || '').trim();
    const sortBy = (req.body.sortBy || 'createdAt').trim();
    const sortOrder = String(req.body.sortOrder || 'desc').toLowerCase();

    // Filters
    const statusFilter = (req.body.status || '').trim(); // e.g., 'paid', 'created', 'failed'
    const roleFilter = (req.body.role || '').trim();     // e.g., 'Brand', 'Influencer'

    // 2) Build Query Filter
    const filter = {};

    // 2a) Exact Match Filters
    if (statusFilter && statusFilter !== 'all') {
      filter.status = statusFilter;
    }
    if (roleFilter && roleFilter !== 'all') {
      filter.role = roleFilter; // Case sensitive based on model enum ["Brand", "Influencer"]
    }

    // 2b) Text Search (Order ID, Payment ID, Invoice Number, Invoice Email, Plan Name)
    if (search) {
      const re = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { orderId: re },
        { paymentId: re },
        { invoiceNumber: re },
        { invoiceEmailTo: re },
        { planName: re },
        { userId: re } // Allows searching by specific ID if known
      ];
    }

    // 3) Count total documents
    const total = await Payment.countDocuments(filter);

    // 4) Validate Sort
    const ALLOWED_SORT = ['amount', 'createdAt', 'paidAt', 'status', 'planName'];
    const field = ALLOWED_SORT.includes(sortBy) ? sortBy : 'createdAt';
    const dir = sortOrder === 'asc' ? 1 : -1;

    // 5) Fetch Payments
    const payments = await Payment.find(filter)
      .sort({ [field]: dir })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // 6) Enrich Data (Fetch Brand/Influencer Names)
    //    We gather all IDs first to minimize DB calls
    const brandIds = [];
    const influencerIds = [];

    payments.forEach(p => {
      if (p.role === 'Brand' && p.userId) brandIds.push(p.userId);
      if (p.role === 'Influencer' && p.userId) influencerIds.push(p.userId);
    });

    // Fetch details in parallel
    const [brands, influencers] = await Promise.all([
      Brand.find({ brandId: { $in: brandIds } }).select('brandId name brandName email').lean(),
      Influencer.find({ influencerId: { $in: influencerIds } }).select('influencerId name influencerName email').lean()
    ]);

    // Create lookup maps
    const brandMap = {};
    brands.forEach(b => {
      brandMap[b.brandId] = b.name || b.brandName || b.email || 'Unknown Brand';
    });

    const influencerMap = {};
    influencers.forEach(i => {
      influencerMap[i.influencerId] = i.name || i.influencerName || i.email || 'Unknown Influencer';
    });

    // 7) Format Response
    const data = payments.map(p => {
      let displayName = 'Unknown';

      if (p.role === 'Brand') {
        displayName = brandMap[p.userId] || `Brand (${p.userId})`;
      } else if (p.role === 'Influencer') {
        displayName = influencerMap[p.userId] || `Influencer (${p.userId})`;
      }

      return {
        _id: p._id,
        orderId: p.orderId,
        paymentId: p.paymentId || 'N/A',
        amount: p.amount, // Note: usually in cents if using Stripe/Razorpay, clarify in frontend
        currency: p.currency,
        status: p.status,
        planName: p.planName,
        role: p.role,
        userId: p.userId,
        userName: displayName, // Enriched field
        invoiceNumber: p.invoiceNumber || '-',
        invoiceEmailTo: p.invoiceEmailTo || '-',
        createdAt: p.createdAt,
        paidAt: p.paidAt
      };
    });

    // 8) Return Result
    return res.status(200).json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      sortBy: field,
      sortOrder: sortOrder,
      payments: data
    });

  } catch (error) {
    console.error('Error in getAllPayments:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};




exports.getAllCampaignsLite = async (req, res) => {
  try {
    const search = (req.body.search || "").trim();
    const statusFlag = parseInt(req.body.type, 10) || 0; // 0=all, 1=active, 2=inactive

    // ✅ brandId from request
    const brandIdRaw = req.body.brandId ?? req.body.brand_id ?? req.body.brand ?? "";
    const brandId = String(brandIdRaw || "").trim();

    // Build filter
    const filter = {};

    // ✅ Filter by brandId (if provided)
    if (brandId) {
      filter.brandId = brandId; // if stored as string
      // If stored as ObjectId, use:
      // filter.brandId = new mongoose.Types.ObjectId(brandId);
    }

    // Search (productOrServiceName)
    if (search) {
      const re = new RegExp(search, "i");
      filter.productOrServiceName = re;
    }

    // Status filter
    if (statusFlag === 1) filter.isActive = 1;
    else if (statusFlag === 2) filter.isActive = 0;

    // Fetch minimal fields INCLUDING campaignsId
    const rows = await Campaign.find(filter)
      .select("brandId campaignsId productOrServiceName")
      .sort({ createdAt: -1 })
      .lean();

    // Shape response: send campaignsId (NOT _id)
    const campaigns = rows.map((c) => ({
      brandId: c.brandId,
      campaignsId: c.campaignsId || null,
      productOrServiceName: c.productOrServiceName,
    }));

    return res.status(200).json({
      status: statusFlag,
      brandId: brandId || null,
      total: campaigns.length,
      campaigns,
    });
  } catch (err) {
    console.error("Error in getAllCampaignsLite:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

