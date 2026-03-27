const mongoose = require("mongoose");
const Delieverable = require("../models/delieverable");
const CampaignInvite = require("../models/campaignInvitation");
const Campaign = require("../models/campaign");
const { InfluencerModel: Influencer } = require("../models/influencer"); // adjust path if needed
const Milestone = require("../models/milestone");
const Notification = require("../models/notification");

const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
const toObjectId = (id) => new mongoose.Types.ObjectId(id);

const normalizeUrls = (url) => {
  if (!url) return [];

  const items = Array.isArray(url) ? url : [url];

  return items
    .map((item) => {
      if (!item) return null;

      if (typeof item === "string") {
        return { label: "", url: item };
      }

      if (typeof item === "object" && item.url) {
        return {
          label: item.label || "",
          url: item.url,
        };
      }

      return null;
    })
    .filter((item) => item && item.url);
};

const normalizeDoc = (obj) => {
  if (!obj) return obj;

  const raw = typeof obj.toObject === "function" ? obj.toObject() : obj;
  const { __v, ...rest } = raw;

  return {
    ...rest,
    _id: raw._id ? String(raw._id) : undefined,
    deliverableId: raw._id ? String(raw._id) : undefined,
    brandId: raw.brandId ? String(raw.brandId) : "",
    influencerId: raw.influencerId ? String(raw.influencerId) : "",
    campaignId: raw.campaignId ? String(raw.campaignId) : "",
    milestoneId: raw.milestoneId ? String(raw.milestoneId) : "",
    milestoneHistoryId: raw.milestoneHistoryId ? String(raw.milestoneHistoryId) : "",
  };
};

const createNotificationSafe = async (payload) => {
  try {
    await Notification.create(payload);
  } catch (err) {
    console.error("Notification create failed:", err?.message || err);
  }
};

// 1) POST: Create deliverable approval (PENDING)
exports.createDeliverableApproval = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      campaignId,
      title,
      description,
      url,
      milestoneHistoryId,
    } = req.body;

    if (!brandId || !influencerId || !campaignId || !title || !milestoneHistoryId) {
      return res.status(400).json({
        success: false,
        message:
          "brandId, influencerId, campaignId, title, and milestoneHistoryId are required.",
      });
    }

    if (
      !isValidObjectId(brandId) ||
      !isValidObjectId(influencerId) ||
      !isValidObjectId(campaignId) ||
      !isValidObjectId(milestoneHistoryId)
    ) {
      return res.status(400).json({
        success: false,
        message: "One or more ids are invalid.",
      });
    }

    const brandObjectId = toObjectId(brandId);
    const influencerObjectId = toObjectId(influencerId);
    const campaignObjectId = toObjectId(campaignId);
    const milestoneHistoryObjectId = toObjectId(milestoneHistoryId);

    const msDoc = await Milestone.findOne({
      "milestoneHistory._id": milestoneHistoryObjectId,
    })
      .select("_id brandId milestoneHistory")
      .lean();

    if (!msDoc) {
      return res.status(404).json({
        success: false,
        message: "Milestone history not found for given milestoneHistoryId.",
      });
    }

    const historyItem = (msDoc.milestoneHistory || []).find(
      (h) => String(h._id) === String(milestoneHistoryObjectId)
    );

    if (!historyItem) {
      return res.status(404).json({
        success: false,
        message: "Milestone history item not found.",
      });
    }

    if (String(msDoc.brandId) !== String(brandObjectId)) {
      return res.status(400).json({
        success: false,
        message: "brandId does not match milestone brandId.",
      });
    }

    if (String(historyItem.campaignId) !== String(campaignObjectId)) {
      return res.status(400).json({
        success: false,
        message: "campaignId does not match milestone history campaignId.",
      });
    }

    if (String(historyItem.influencerId) !== String(influencerObjectId)) {
      return res.status(400).json({
        success: false,
        message: "influencerId does not match milestone history influencerId.",
      });
    }

    const deliverableApprovalId = new mongoose.Types.ObjectId().toString();

    const doc = await Delieverable.create({
      brandId: brandObjectId,
      influencerId: influencerObjectId,
      campaignId: campaignObjectId,
      milestoneId: msDoc._id,
      milestoneHistoryId: milestoneHistoryObjectId,
      delieverableApprovalId: deliverableApprovalId, // keep this only if schema uses this exact typo field
      title,
      description: description || "",
      url: normalizeUrls(url),
      status: "pending",
      approvedRole: "",
      comments: "",
      approvalId: "",
    });

    const [influencerDoc, campaignDoc] = await Promise.all([
      Influencer.findById(influencerObjectId).select("name").lean(),
      Campaign.findById(campaignObjectId).select("campaignTitle").lean(),
    ]);

    const influencerName = influencerDoc?.name || "Influencer";
    const campaignName = campaignDoc?.campaignTitle || "Campaign";
    const milestoneTitle = historyItem?.milestoneTitle || "";

    await createNotificationSafe({
      brandId: String(brandObjectId),
      type: "deliverable.submitted",
      title: "New deliverable submitted",
      message: `${influencerName} submitted a deliverable for ${campaignName}${
        milestoneTitle ? ` (Milestone: ${milestoneTitle})` : ""
      }.`,
      entityType: "deliverable",
      entityId: String(doc._id),
      actionPath: `/brand/deliverables?campaignId=${campaignId}`,
      isRead: false,
    });

    return res.status(201).json({
      success: true,
      message: "Deliverable approval created (pending).",
      data: normalizeDoc(doc),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to create deliverable approval.",
      error: err.message,
    });
  }
};

// 2) POST: Update status to approved/revision
exports.updateDeliverableApprovalStatus = async (req, res) => {
  try {
    const deliverableId =
      req.params.deliverableId || req.params.delieverableApprovalId;

    const { status, comments, approvedRole, approvalId } = req.body;

    if (!deliverableId || !isValidObjectId(deliverableId)) {
      return res.status(400).json({
        success: false,
        message: "Valid deliverableId is required.",
      });
    }

    if (!["approved", "revision"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be either 'approved' or 'revision'.",
      });
    }

    const update = { status };

    if (typeof comments === "string") update.comments = comments;
    if (typeof approvalId === "string") update.approvalId = approvalId;

    if (approvedRole !== undefined) {
      if (!["Brand", "Admin"].includes(approvedRole)) {
        return res.status(400).json({
          success: false,
          message: "approvedRole must be 'Brand' or 'Admin'.",
        });
      }
      update.approvedRole = approvedRole;
    }

    const doc = await Delieverable.findByIdAndUpdate(
      deliverableId,
      { $set: update },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Deliverable approval not found.",
      });
    }

    const campaignDoc = await Campaign.findById(doc.campaignId)
      .select("campaignTitle")
      .lean();

    const campaignName = campaignDoc?.campaignTitle || "Campaign";
    const statusLabel =
      status === "approved" ? "Approved" : "Revision requested";
    const notifTitle =
      status === "approved"
        ? "Deliverable approved ✅"
        : "Deliverable needs changes ✏️";

    const byRole = approvedRole || doc.approvedRole || "Brand";

    const commentLine =
      typeof comments === "string" && comments.trim()
        ? ` Comment: ${comments.trim()}`
        : "";

    await createNotificationSafe({
      influencerId: String(doc.influencerId),
      type: "deliverable.status.updated",
      title: notifTitle,
      message: `${byRole} marked your deliverable "${doc.title}" as ${statusLabel} in ${campaignName}.${commentLine}`,
      entityType: "deliverable",
      entityId: String(doc._id),
      actionPath: `/influencer/campaigns-invite/${String(doc.campaignId)}`,
      isRead: false,
    });

    return res.status(200).json({
      success: true,
      message: `Deliverable status updated to '${status}'.`,
      data: normalizeDoc(doc),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to update deliverable status.",
      error: err.message,
    });
  }
};

// 3) GET: List deliverables by campaignId (+ optional status)
exports.listDeliverablesByCampaign = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { status } = req.query;

    if (!campaignId || !isValidObjectId(campaignId)) {
      return res.status(400).json({
        success: false,
        message: "Valid campaignId is required.",
      });
    }

    const query = { campaignId: toObjectId(campaignId) };
    if (status) query.status = status;

    const docs = await Delieverable.find(query)
      .sort({ createdAt: -1 })
      .lean();

    const influencerIds = [
      ...new Set(
        docs
          .map((d) => (d?.influencerId ? String(d.influencerId) : null))
          .filter(Boolean)
      ),
    ];

    const influencers = influencerIds.length
      ? await Influencer.find({ _id: { $in: influencerIds.map(toObjectId) } })
          .select("name")
          .lean()
      : [];

    const infMap = new Map(influencers.map((i) => [String(i._id), i]));

    const milestoneHistoryIds = [
      ...new Set(
        docs
          .map((d) => (d?.milestoneHistoryId ? String(d.milestoneHistoryId) : null))
          .filter(Boolean)
      ),
    ];

    const rows = milestoneHistoryIds.length
      ? await Milestone.aggregate([
          { $unwind: "$milestoneHistory" },
          {
            $match: {
              "milestoneHistory._id": {
                $in: milestoneHistoryIds.map((id) => new mongoose.Types.ObjectId(id)),
              },
            },
          },
          {
            $project: {
              _id: 0,
              milestoneHistoryId: "$milestoneHistory._id",
              milestoneTitle: "$milestoneHistory.milestoneTitle",
            },
          },
        ])
      : [];

    const titleByHistoryId = new Map(
      rows.map((r) => [String(r.milestoneHistoryId), r.milestoneTitle])
    );

    const data = docs.map((d) => {
      const inf = infMap.get(String(d.influencerId));
      const influencerName = inf?.name || "";
      const mhId = d?.milestoneHistoryId ? String(d.milestoneHistoryId) : "";

      return {
        ...normalizeDoc(d),
        milestoneTitle: titleByHistoryId.get(mhId) || "",
        influencerName,
        influencer: inf
          ? {
              _id: String(inf._id),
              name: inf.name || "",
            }
          : null,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Deliverables fetched successfully.",
      count: data.length,
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch deliverables.",
      error: err.message,
    });
  }
};

// 4) GET: List influencer invites + campaign name
// Assumption: campaignInvitation model is also updated to use ObjectId fields:
// { influencerId: ObjectId, campaignId: ObjectId, platform, createdAt }
exports.listInfluencerDeliverablesByCampaign = async (req, res) => {
  try {
    const { influencerId, campaignId } = req.params;

    if (!influencerId || !isValidObjectId(influencerId)) {
      return res.status(400).json({
        success: false,
        message: "Valid influencerId is required.",
      });
    }

    if (!campaignId || !isValidObjectId(campaignId)) {
      return res.status(400).json({
        success: false,
        message: "Valid campaignId is required.",
      });
    }

    const invites = await CampaignInvite.find({
      influencerId: toObjectId(influencerId),
      campaignId: toObjectId(campaignId),
    })
      .select("campaignId influencerId platform createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const campaign = await Campaign.findOne({
      _id: toObjectId(campaignId),
    })
      .select("campaignTitle")
      .lean();

    const docs = invites.map((inv) => ({
      influencerId: String(inv.influencerId),
      campaignId: String(inv.campaignId),
      platform: inv.platform,
      createdAt: inv.createdAt,
      campaign: campaign
        ? {
            _id: String(campaign._id),
            campaignTitle: campaign.campaignTitle,
          }
        : null,
    }));

    return res.status(200).json({
      success: true,
      message: "Deliverables fetched successfully.",
      count: docs.length,
      data: docs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch deliverables.",
      error: err.message,
    });
  }
};


exports.listInfluencerDeliverablesByCampaign2 = async (req, res) => {
  try {
    const { campaignId } = req.params;

    if (!campaignId || !isValidObjectId(campaignId)) {
      return res.status(400).json({
        success: false,
        message: "Valid campaignId is required.",
      });
    }

    const invites = await CampaignInvite.find({ campaignId: toObjectId(campaignId) })
      .select("influencerId deliverables platform createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const influencerIds = [
      ...new Set(
        invites
          .map((x) => x.influencerId)
          .filter(Boolean)
          .map((id) => String(id))
      ),
    ];

    const influencers = influencerIds.length
      ? await Influencer.find({ _id: { $in: influencerIds.map(toObjectId) } })
          .select("name email countryName categories languages")
          .lean()
      : [];

    const metaByInfluencer = new Map();

    for (const inv of invites) {
      const infId = inv?.influencerId ? String(inv.influencerId) : null;
      if (!infId) continue;

      const p = inv?.platform ? String(inv.platform) : null;
      const c = inv?.createdAt || null;

      if (!metaByInfluencer.has(infId)) {
        metaByInfluencer.set(infId, {
          platforms: new Set(),
          createdAt: c,
        });
      }

      const meta = metaByInfluencer.get(infId);

      if (p) meta.platforms.add(p);

      if (c && (!meta.createdAt || new Date(c) > new Date(meta.createdAt))) {
        meta.createdAt = c;
      }
    }

    const influencersWithMeta = influencers.map((inf) => {
      const id = String(inf._id);
      const meta = metaByInfluencer.get(id);

      return {
        _id: String(inf._id),
        name: inf.name || "",
        email: inf.email || "",
        countryName: inf.countryName || "",
        categories: inf.categories || [],
        languages: inf.languages || [],
        platforms: meta ? Array.from(meta.platforms) : [],
        createdAt: meta?.createdAt || null,
      };
    });

    const totalInvites = invites.length;
    const totalInfluencers = influencerIds.length;
    const totalDeliverables = invites.reduce((sum, inv) => {
      const d = inv?.deliverables;
      if (Array.isArray(d)) return sum + d.length;
      if (!d) return sum;
      return sum + 1;
    }, 0);

    return res.status(200).json({
      success: true,
      total: {
        invites: totalInvites,
        influencers: totalInfluencers,
        deliverables: totalDeliverables,
      },
      influencers: influencersWithMeta,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch totals + influencer list.",
      error: err.message,
    });
  }
};

// 6) GET ALL deliverables by brandId OR influencerId
exports.getAllDeliverables = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      status,
      campaignId,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    if (!brandId && !influencerId) {
      return res.status(400).json({
        success: false,
        message: "brandId or influencerId is required.",
      });
    }

    if (brandId && !isValidObjectId(brandId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid brandId.",
      });
    }

    if (influencerId && !isValidObjectId(influencerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid influencerId.",
      });
    }

    if (campaignId && !isValidObjectId(campaignId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid campaignId.",
      });
    }

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));

    const query = {};
    if (brandId) query.brandId = toObjectId(brandId);
    if (influencerId) query.influencerId = toObjectId(influencerId);
    if (status) query.status = String(status);
    if (campaignId) query.campaignId = toObjectId(campaignId);

    const term = String(search || "").trim();
    if (term) {
      const rx = new RegExp(escapeRegex(term), "i");

      const [matchedCampaigns, matchedMilestones] = await Promise.all([
        Campaign.find({ campaignTitle: rx }).select("_id").lean(),
        Milestone.aggregate([
          { $unwind: "$milestoneHistory" },
          { $match: { "milestoneHistory.milestoneTitle": rx } },
          {
            $project: {
              _id: 0,
              milestoneHistoryId: "$milestoneHistory._id",
            },
          },
        ]),
      ]);

      const matchedCampaignIds = matchedCampaigns
        .map((c) => c._id)
        .filter(Boolean);

      const matchedMilestoneHistoryIds = matchedMilestones
        .map((m) => m.milestoneHistoryId)
        .filter(Boolean);

      const orList = [
        { title: rx },
        { description: rx },
        { comments: rx },
      ];

      if (isValidObjectId(term)) {
        orList.push({ _id: toObjectId(term) });
      }

      if (matchedCampaignIds.length) {
        orList.push({ campaignId: { $in: matchedCampaignIds } });
      }

      if (matchedMilestoneHistoryIds.length) {
        orList.push({ milestoneHistoryId: { $in: matchedMilestoneHistoryIds } });
      }

      query.$or = orList;
    }

    const [docs, total] = await Promise.all([
      Delieverable.find(query)
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      Delieverable.countDocuments(query),
    ]);

    const influencerIds = [
      ...new Set(
        docs
          .map((d) => (d?.influencerId ? String(d.influencerId) : null))
          .filter(Boolean)
      ),
    ];

    const campaignIds = [
      ...new Set(
        docs
          .map((d) => (d?.campaignId ? String(d.campaignId) : null))
          .filter(Boolean)
      ),
    ];

    const milestoneHistoryIds = [
      ...new Set(
        docs
          .map((d) => (d?.milestoneHistoryId ? String(d.milestoneHistoryId) : null))
          .filter(Boolean)
      ),
    ];

    const [influencers, campaigns, rows] = await Promise.all([
      influencerIds.length
        ? Influencer.find({ _id: { $in: influencerIds.map(toObjectId) } })
            .select("name")
            .lean()
        : [],
      campaignIds.length
        ? Campaign.find({ _id: { $in: campaignIds.map(toObjectId) } })
            .select("campaignTitle")
            .lean()
        : [],
      milestoneHistoryIds.length
        ? Milestone.aggregate([
            { $unwind: "$milestoneHistory" },
            {
              $match: {
                "milestoneHistory._id": {
                  $in: milestoneHistoryIds.map((id) => new mongoose.Types.ObjectId(id)),
                },
              },
            },
            {
              $project: {
                _id: 0,
                milestoneHistoryId: "$milestoneHistory._id",
                milestoneTitle: "$milestoneHistory.milestoneTitle",
              },
            },
          ])
        : [],
    ]);

    const infMap = new Map(influencers.map((i) => [String(i._id), i]));
    const campMap = new Map(campaigns.map((c) => [String(c._id), c]));
    const titleByHistoryId = new Map(
      rows.map((r) => [String(r.milestoneHistoryId), r.milestoneTitle])
    );

    const data = docs.map((d) => {
      const inf = infMap.get(String(d.influencerId));
      const camp = campMap.get(String(d.campaignId));
      const mhId = d?.milestoneHistoryId ? String(d.milestoneHistoryId) : "";

      return {
        ...normalizeDoc(d),
        campaignName: camp?.campaignTitle || "",
        milestoneTitle: titleByHistoryId.get(mhId) || "",
        influencerName: inf?.name || "",
        influencer: inf
          ? {
              _id: String(inf._id),
              name: inf.name || "",
            }
          : null,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Deliverables fetched successfully.",
      page: p,
      limit: l,
      total,
      count: data.length,
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch deliverables.",
      error: err.message,
    });
  }
};