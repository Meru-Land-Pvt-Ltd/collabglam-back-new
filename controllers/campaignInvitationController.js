const mongoose = require("mongoose");

const CampaignInvitation = require("../models/campaignInvitation");
const Campaign = require("../models/campaign");
const Modash = require("../models/modash");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Brand = require("../models/brand");

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

function normalizeHandle(h) {
  if (!h) return null;
  const t = String(h).trim();
  const withAt = t.startsWith("@") ? t : `@${t}`;
  return withAt.toLowerCase();
}

function toObjectId(v) {
  return new mongoose.Types.ObjectId(String(v));
}

function toObjectIds(values = []) {
  return values
    .map((v) => String(v || "").trim())
    .filter((v) => isObjectId(v))
    .map((v) => new mongoose.Types.ObjectId(v));
}

function parseObjectIdArray(raw) {
  let ids = [];

  if (Array.isArray(raw)) {
    ids = raw.map((x) => String(x || "").trim()).filter(Boolean);
  } else if (typeof raw === "string") {
    const v = raw.trim();
    if (v) ids = [v];
  } else if (raw != null) {
    const v = String(raw).trim();
    if (v) ids = [v];
  }

  ids = [...new Set(ids)];
  return ids.filter((id) => isObjectId(id));
}

async function enrichInvitations(invitations, { includeCampaign = true, includeNames = true } = {}) {
  let campaignMap = new Map();
  let brandMap = new Map();
  let influencerMap = new Map();
  let modashMap = new Map();

  if (includeCampaign && invitations.length) {
    const campaignIds = [...new Set(invitations.map((i) => i.campaignId).filter(Boolean).map(String))];

    const campaigns = await Campaign.find({ _id: { $in: campaignIds } })
      .select(
        "_id campaignTitle brandId description campaignBudget budget influencerBudget minFollowers maxFollowers targetCountry targetAgeRanges paymentType startAt endAt"
      )
      .lean();

    campaignMap = new Map(campaigns.map((c) => [String(c._id), c]));
  }

  if (includeNames && invitations.length) {
    const brandIds = [...new Set(invitations.map((i) => i.brandId).filter(Boolean).map(String))];
    const influencerIds = [...new Set(invitations.map((i) => i.influencerId).filter(Boolean).map(String))];
    const modashUserIds = [
      ...new Set(invitations.map((i) => i.modashUserId).filter(Boolean).map((x) => String(x).trim())),
    ];
    const platforms = [
      ...new Set(invitations.map((i) => i.platform).filter(Boolean).map((x) => String(x).trim().toLowerCase())),
    ];

    const [brands, influencers, modashDocs] = await Promise.all([
      brandIds.length
        ? Brand.find({ _id: { $in: brandIds } }).select("_id name brandName companyName email").lean()
        : [],
      influencerIds.length
        ? Influencer.find({ _id: { $in: influencerIds } }).select("_id name email").lean()
        : [],
      modashUserIds.length
        ? Modash.find({
          userId: { $in: modashUserIds },
          ...(platforms.length ? { provider: { $in: platforms } } : {}),
        })
          .select("userId provider fullname username handle")
          .lean()
        : [],
    ]);

    brandMap = new Map(
      brands.map((b) => [
        String(b._id),
        {
          brandName: b.name || b.brandName || b.companyName || "",
          brandEmail: b.email || null,
        },
      ])
    );

    influencerMap = new Map(
      influencers.map((i) => [
        String(i._id),
        {
          influencerName: i.name || "",
          influencerEmail: i.email || null,
        },
      ])
    );

    modashMap = new Map(
      modashDocs.map((m) => [
        `${String(m.userId).trim()}|${String(m.provider).trim().toLowerCase()}`,
        m.fullname || m.username || m.handle || "",
      ])
    );
  }

  return invitations.map((inv) => {
    const campaign = includeCampaign ? campaignMap.get(String(inv.campaignId)) : null;
    const brandInfo = includeNames ? brandMap.get(String(inv.brandId)) : null;
    const influencerInfo = includeNames ? influencerMap.get(String(inv.influencerId)) : null;

    let influencerName = influencerInfo?.influencerName || "";
    if (!influencerName && inv.modashUserId) {
      const key = `${String(inv.modashUserId).trim()}|${String(inv.platform || "").trim().toLowerCase()}`;
      influencerName = modashMap.get(key) || "";
    }

    const out = {
      _id: String(inv._id),

      brandId: inv.brandId ? String(inv.brandId) : null,
      brandName: includeNames ? brandInfo?.brandName || null : undefined,

      influencerId: inv.influencerId ? String(inv.influencerId) : null,
      influencerName: includeNames ? influencerName || null : undefined,
      influencerEmail: includeNames ? influencerInfo?.influencerEmail || null : undefined,

      campaignId: inv.campaignId ? String(inv.campaignId) : null,
      campaignTitle: includeCampaign ? campaign?.campaignTitle || null : undefined,
      description: includeCampaign ? campaign?.description || null : undefined,

      campaignBudget: includeCampaign ? campaign?.campaignBudget ?? null : undefined,
      budget: includeCampaign ? campaign?.budget ?? null : undefined,
      influencerBudget: includeCampaign ? campaign?.influencerBudget ?? null : undefined,

      minFollowers: includeCampaign ? campaign?.minFollowers ?? null : undefined,
      maxFollowers: includeCampaign ? campaign?.maxFollowers ?? null : undefined,
      targetCountry: includeCampaign ? campaign?.targetCountry ?? null : undefined,
      targetAgeRanges: includeCampaign ? campaign?.targetAgeRanges ?? [] : undefined,
      paymentType: includeCampaign ? campaign?.paymentType ?? null : undefined,
      startAt: includeCampaign ? campaign?.startAt ?? null : undefined,
      endAt: includeCampaign ? campaign?.endAt ?? null : undefined,

      platform: inv.platform || null,
      handle: inv.handle || null,
      emailTo: inv.emailTo || null,
      missingEmailId: inv.missingEmailId || null,
      modashUserId: inv.modashUserId || null,

      status: inv.status,
      sentAt: inv.sentAt || null,
      failedAt: inv.failedAt || null,
      failReason: inv.failReason || null,

      createdAt: inv.createdAt,
      updatedAt: inv.updatedAt,
    };

    Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
    return out;
  });
}


exports.createInvitation = async (req, res) => {
  try {
    const brandId = String(req.body?.brandId || "").trim();
    const influencerId = String(req.body?.influencerId || "").trim();
    const campaignIds = parseObjectIdArray(req.body?.campaignIds);

    let platform = String(req.body?.platform || "").trim().toLowerCase();
    let handle = req.body?.handle ? normalizeHandle(req.body.handle) : null;
    let modashUserId = String(req.body?.modashUserId || "").trim() || null;
    let emailTo = String(req.body?.emailTo || "").trim().toLowerCase() || null;

    if (!isObjectId(brandId) || !isObjectId(influencerId) || !campaignIds.length) {
      return res.status(400).json({
        status: "error",
        message: "brandId, influencerId and campaignIds[] are required and must be valid Mongo ObjectIds",
      });
    }

    if (handle && !HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid handle format. Use @username",
      });
    }

    if (emailTo && !emailRegex.test(emailTo)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid emailTo",
      });
    }

    const [brand, influencer, campaigns] = await Promise.all([
      Brand.findById(brandId).select("_id name brandName email").lean(),
      Influencer.findById(influencerId).select("_id name email page1 page2 page3").lean(),
      Campaign.find({
        _id: { $in: campaignIds },
        brandId: new mongoose.Types.ObjectId(brandId),
      })
        .select("_id brandId campaignTitle")
        .lean(),
    ]);

    if (!brand) {
      return res.status(404).json({ status: "error", message: "Brand not found" });
    }

    if (!influencer) {
      return res.status(404).json({ status: "error", message: "Influencer not found" });
    }

    const foundCampaignIds = new Set(campaigns.map((c) => String(c._id)));
    const missingCampaignIds = campaignIds.filter((id) => !foundCampaignIds.has(id));

    if (!campaigns.length) {
      return res.status(404).json({
        status: "error",
        message: "No matching campaigns found for this brand",
        missingCampaignIds,
      });
    }

    if (!emailTo) {
      emailTo = influencer.email || null;
    }

    const storedInvitations = [];

    for (const campaign of campaigns) {
      const filter = {
        brandId: campaign.brandId,
        campaignId: campaign._id,
        influencerId: new mongoose.Types.ObjectId(influencerId),
      };

      const update = {
        $setOnInsert: {
          brandId: campaign.brandId,
          campaignId: campaign._id,
          influencerId: new mongoose.Types.ObjectId(influencerId),
          createdByAdminId: req.user?.adminId && isObjectId(req.user.adminId)
            ? new mongoose.Types.ObjectId(req.user.adminId)
            : null,
        },
        $set: {
          platform: platform || undefined,
          handle: handle || undefined,
          modashUserId: modashUserId || undefined,
          emailTo: emailTo || null,
          status: "sent",
          sentAt: new Date(),
          failedAt: null,
          failReason: null,
        },
      };

      Object.keys(update.$set).forEach((k) => update.$set[k] === undefined && delete update.$set[k]);

      const invitation = await CampaignInvitation.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }).lean();

      storedInvitations.push(invitation);
    }

    const invitations = await enrichInvitations(storedInvitations, {
      includeCampaign: true,
      includeNames: true,
    });

    return res.json({
      status: "success",
      message: "Invitations created successfully",
      requestedCampaigns: campaignIds.length,
      created: invitations.length,
      missingCampaignIds,
      invitations,
    });
  } catch (e) {
    console.error("createInvitation error:", e);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};

exports.getInvitationsList = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "25", 10), 1),
      200
    );
    const skip = (page - 1) * limit;

    const includeCampaign = String(req.query.includeCampaign || "1") === "1";
    const includeNames = String(req.query.includeNames || "1") === "1";

    const filter = {};

    if (req.query.brandId) {
      const brandId = String(req.query.brandId).trim();
      if (!isObjectId(brandId)) {
        return res.status(400).json({ status: "error", message: "Invalid brandId" });
      }
      filter.brandId = new mongoose.Types.ObjectId(brandId);
    }

    if (req.query.campaignId) {
      const campaignId = String(req.query.campaignId).trim();
      if (!isObjectId(campaignId)) {
        return res.status(400).json({ status: "error", message: "Invalid campaignId" });
      }
      filter.campaignId = new mongoose.Types.ObjectId(campaignId);
    }

    if (req.query.influencerId) {
      const influencerId = String(req.query.influencerId).trim();
      if (!isObjectId(influencerId)) {
        return res.status(400).json({ status: "error", message: "Invalid influencerId" });
      }
      filter.influencerId = new mongoose.Types.ObjectId(influencerId);
    }

    if (req.query.platform) {
      filter.platform = String(req.query.platform).trim().toLowerCase();
    }

    if (req.query.handle) {
      const h = normalizeHandle(req.query.handle);
      if (!h || !HANDLE_RX.test(h)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid handle format. Use @username",
        });
      }
      filter.handle = h;
    }

    if (req.query.status) filter.status = String(req.query.status).trim().toLowerCase();
    if (req.query.modashUserId) filter.modashUserId = String(req.query.modashUserId).trim();

    const [total, invitations] = await Promise.all([
      CampaignInvitation.countDocuments(filter),
      CampaignInvitation.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const enriched = await enrichInvitations(invitations, { includeCampaign, includeNames });

    return res.json({
      status: "success",
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      invitations: enriched,
    });
  } catch (e) {
    console.error("getInvitationsList error:", e);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
};

exports.getInvitationsByInfluencerId = async (req, res) => {
  try {
    const influencerId = String(req.params.influencerId || req.query.influencerId || "").trim();

    if (!isObjectId(influencerId)) {
      return res.status(400).json({ status: "error", message: "Valid influencerId is required" });
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "25", 10), 1), 200);
    const skip = (page - 1) * limit;

    const filter = {
      influencerId: new mongoose.Types.ObjectId(influencerId),
    };

    if (req.query.status) filter.status = String(req.query.status).trim().toLowerCase();
    if (req.query.brandId) {
      const brandId = String(req.query.brandId).trim();
      if (!isObjectId(brandId)) {
        return res.status(400).json({ status: "error", message: "Invalid brandId" });
      }
      filter.brandId = new mongoose.Types.ObjectId(brandId);
    }

    const [total, invitations] = await Promise.all([
      CampaignInvitation.countDocuments(filter),
      CampaignInvitation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    const enriched = await enrichInvitations(invitations, {
      includeCampaign: true,
      includeNames: true,
    });

    return res.json({
      status: "success",
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      influencerId,
      invitations: enriched,
    });
  } catch (e) {
    console.error("getInvitationsByInfluencerId error:", e);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};

exports.getInvitationsByBrandId = async (req, res) => {
  try {
    const brandId = String(req.params.brandId || req.query.brandId || "").trim();

    if (!isObjectId(brandId)) {
      return res.status(400).json({ status: "error", message: "Valid brandId is required" });
    }

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "25", 10), 1), 200);
    const skip = (page - 1) * limit;

    const filter = {
      brandId: new mongoose.Types.ObjectId(brandId),
    };

    if (req.query.status) filter.status = String(req.query.status).trim().toLowerCase();

    if (req.query.influencerId) {
      const influencerId = String(req.query.influencerId).trim();
      if (!isObjectId(influencerId)) {
        return res.status(400).json({ status: "error", message: "Invalid influencerId" });
      }
      filter.influencerId = new mongoose.Types.ObjectId(influencerId);
    }

    const [total, invitations] = await Promise.all([
      CampaignInvitation.countDocuments(filter),
      CampaignInvitation.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const enriched = await enrichInvitations(invitations, {
      includeCampaign: true,
      includeNames: true,
    });

    return res.json({
      status: "success",
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      brandId,
      invitations: enriched,
    });
  } catch (e) {
    console.error("getInvitationsByBrandId error:", e);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};

exports.getAllInvitationsByInfluencerId = async (req, res) => {
  try {
    const influencerId = String(req.params.influencerId || req.query.influencerId || "").trim();
    const status = String(req.query.status || "").trim().toLowerCase();

    if (!isObjectId(influencerId)) {
      return res.status(400).json({
        status: "error",
        message: "Valid influencerId is required",
      });
    }

    const filter = {
      influencerId: new mongoose.Types.ObjectId(influencerId),
    };

    if (status) {
      filter.status = status;
    }

    const invitations = await CampaignInvitation.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const enriched = await enrichInvitations(invitations, {
      includeCampaign: true,
      includeNames: true,
    });

    return res.json({
      status: "success",
      total: enriched.length,
      influencerId,
      filter: {
        ...(status ? { status } : {}),
      },
      invitations: enriched,
    });
  } catch (e) {
    console.error("getAllInvitationsByInfluencerId error:", e);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

exports.updateInvitationStatus = async (req, res) => {
  try {
    const campaignId = String(req.body?.campaignId || "").trim();
    const invitationId = String(req.body?.invitationId || "").trim();
    const status = String(req.body?.status || "").trim().toLowerCase();
    const failReason = String(req.body?.failReason || "").trim();

    const allowedStatuses = ["sent", "accepted", "reject", "failed"];

    if (!isObjectId(campaignId)) {
      return res.status(400).json({
        status: "error",
        message: "Valid campaignId is required",
      });
    }

    if (!isObjectId(invitationId)) {
      return res.status(400).json({
        status: "error",
        message: "Valid invitationId is required",
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        status: "error",
        message: `Invalid status. Allowed values: ${allowedStatuses.join(", ")}`,
      });
    }

    const filter = {
      _id: new mongoose.Types.ObjectId(invitationId),
      campaignId: new mongoose.Types.ObjectId(campaignId),
    };

    const update = {
      status,
      updatedAt: new Date(),
    };

    if (status === "accepted") {
      update.failedAt = null;
      update.failReason = null;
    }

    if (status === "reject") {
      update.failedAt = null;
      update.failReason = null;
    }

    if (status === "sent") {
      update.sentAt = new Date();
      update.failedAt = null;
      update.failReason = null;
    }

    if (status === "failed") {
      update.failedAt = new Date();
      update.failReason = failReason || "Invitation failed";
    }

    const invitation = await CampaignInvitation.findOneAndUpdate(
      filter,
      { $set: update },
      { new: true }
    ).lean();

    if (!invitation) {
      return res.status(404).json({
        status: "error",
        message: "Invitation not found for this campaign",
      });
    }

    const enriched = await enrichInvitations([invitation], {
      includeCampaign: true,
      includeNames: true,
    });

    return res.json({
      status: "success",
      message: "Invitation status updated successfully",
      invitation: enriched[0] || invitation,
    });
  } catch (e) {
    console.error("updateInvitationStatus error:", e);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};