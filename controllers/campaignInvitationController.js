const mongoose = require("mongoose");

const CampaignInvitation = require("../models/campaignInvitation");
const Campaign = require("../models/campaign");
const Modash = require("../models/modash");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Brand = require("../models/brand");

// validation
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
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

/**
 * Accepts:
 * - campaignsIds (array or string)
 * - campaignsId  (array or string)
 * - campaignIds  (array or string)
 * - campaignId   (single string)
 *
 * Returns: array of string IDs, deduped
 */
function parseCampaignIdsFromBody(body) {
  const raw =
    body?.campaignsIds ??
    body?.campaignsId ??
    body?.campaignIds ??
    body?.campaignId;

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

  return [...new Set(ids)];
}

/**
 * Find Modash by userId (+ provider)
 * - userId is Modash.userId (UC....)
 * - provider is youtube / instagram / tiktok
 */
async function findModashByUserId(userId, provider) {
  const id = String(userId || "").trim();
  if (!id) return null;

  if (isObjectId(id)) {
    const byId = await Modash.findById(id).lean();
    if (byId) return byId;
  }

  if (provider) {
    const byPair = await Modash.findOne({ userId: id, provider }).lean();
    if (byPair) return byPair;
  }

  return Modash.findOne({ userId: id }).lean();
}

function extractHandleFromModash(modashDoc) {
  const cand = [modashDoc?.handle, modashDoc?.username].filter(Boolean);
  if (!cand.length) return null;
  return normalizeHandle(cand[0]);
}

/**
 * POST /admin/invitations/store
 * body:
 * {
 *   userId: "UC....",
 *   campaignsId: ["uuid1","uuid2"],
 *   platform: "youtube"
 * }
 */
exports.storeInvitation = async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const platformRaw = String(req.body?.platform || "").trim().toLowerCase();
    const requestedCampaignIds = parseCampaignIdsFromBody(req.body);

    if (!userId || requestedCampaignIds.length === 0) {
      return res.status(400).json({
        status: "error",
        message:
          'userId and campaignsId(s) are required. Send "campaignsId" (string/array) or "campaignsIds" (string/array).',
      });
    }

    // 1) Modash
    const modash = await findModashByUserId(userId, platformRaw || undefined);
    if (!modash) {
      return res.status(404).json({
        status: "error",
        message: "Modash profile not found",
      });
    }

    const platform =
      platformRaw || String(modash?.provider || "youtube").toLowerCase();

    // 2) Handle
    const handle = extractHandleFromModash(modash);
    if (!handle || !HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message: "Could not resolve a valid @handle from Modash data",
      });
    }

    // 3) Optional influencer link using Mongo _id only
    let influencerId = null;

    if (modash?.influencer && isObjectId(modash.influencer)) {
      const influencer = await Influencer.findById(modash.influencer)
        .select("_id")
        .lean();
      influencerId = influencer?._id || null;
    } else if (modash?.influencerId && isObjectId(modash.influencerId)) {
      const influencer = await Influencer.findById(modash.influencerId)
        .select("_id")
        .lean();
      influencerId = influencer?._id || null;
    }

    // 4) Fetch campaigns by campaignsId (UUID string)
    const campaigns = await Campaign.find({
      campaignsId: { $in: requestedCampaignIds },
    })
      .select("_id brandId campaignsId productOrServiceName")
      .lean();

    const byCampaignsId = new Map(
      campaigns.map((c) => [String(c.campaignsId), c])
    );

    const missingCampaigns = requestedCampaignIds.filter(
      (cid) => !byCampaignsId.has(cid)
    );

    // 5) Upsert invitations
    const storedInvitations = [];

    for (const cid of requestedCampaignIds) {
      const campaign = byCampaignsId.get(cid);
      if (!campaign || !campaign.brandId) continue;

      const filter = {
        brandId: campaign.brandId,
        campaignId: campaign._id,
        handle,
        platform,
      };

      const update = {
        $setOnInsert: {
          brandId: campaign.brandId,
          campaignsId: campaign.campaignsId || null,
          handle,
          platform,
          createdByAdminId: req.user?.adminId || null,
          status: "created",
        },
        $set: {
          modashUserId: userId,
          influencerId: influencerId || null,
        },
      };

      const inv = await CampaignInvitation.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }).lean();

      storedInvitations.push({
        invitationId: inv.invitationId,
        brandId: inv.brandId,
        campaignId: inv.campaignId ? String(inv.campaignId) : null,
        campaignsId: inv.campaignsId || null,
        modashUserId: inv.modashUserId || null,
        influencerId: inv.influencerId ? String(inv.influencerId) : null,
        handle: inv.handle,
        platform: inv.platform,
        status: inv.status,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      });
    }

    return res.json({
      status: "success",
      message: "Invitations stored",
      requested: requestedCampaignIds.length,
      stored: storedInvitations.length,
      missingCampaigns,
      invitations: storedInvitations,
    });
  } catch (e) {
    console.error("storeInvitation error:", e);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
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

    const filter = {};

    if (req.query.brandId) {
      filter.brandId = String(req.query.brandId).trim();
    }

    if (req.query.campaignId) {
      const campaignId = String(req.query.campaignId).trim();
      if (!isObjectId(campaignId)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid campaignId",
        });
      }
      filter.campaignId = toObjectId(campaignId);
    }

    if (req.query.campaignsId) {
      const raw = String(req.query.campaignsId).trim();
      const ids = raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      if (ids.length === 1) filter.campaignsId = ids[0];
      if (ids.length > 1) filter.campaignsId = { $in: ids };
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

    if (req.query.status) {
      filter.status = String(req.query.status).trim().toLowerCase();
    }

    if (req.query.modashUserId) {
      filter.modashUserId = String(req.query.modashUserId).trim();
    }

    if (req.query.influencerId) {
      const influencerId = String(req.query.influencerId).trim();
      if (!isObjectId(influencerId)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid influencerId",
        });
      }
      filter.influencerId = toObjectId(influencerId);
    }

    const [total, invitations] = await Promise.all([
      CampaignInvitation.countDocuments(filter),
      CampaignInvitation.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const includeCampaign = String(req.query.includeCampaign || "1") === "1";
    const includeNames = String(req.query.includeNames || "1") === "1";

    let campaignMap = new Map();
    let brandMap = new Map();
    let influencerMap = new Map();
    let modashMap = new Map();

    if (includeCampaign && invitations.length) {
      const campaignIds = [
        ...new Set(
          invitations
            .map((i) => i.campaignId)
            .filter(Boolean)
            .map((x) => String(x))
        ),
      ];

      const campaigns = await Campaign.find({
        _id: { $in: toObjectIds(campaignIds) },
      })
        .select("_id campaignsId productOrServiceName brandId")
        .lean();

      campaignMap = new Map(campaigns.map((c) => [String(c._id), c]));
    }

    if (includeNames && invitations.length) {
      const brandIds = [
        ...new Set(
          invitations
            .map((i) => i.brandId)
            .filter(Boolean)
            .map((x) => String(x))
        ),
      ];

      const influencerIds = [
        ...new Set(
          invitations
            .map((i) => i.influencerId)
            .filter(Boolean)
            .map((x) => String(x))
        ),
      ];

      const modashUserIds = [
        ...new Set(
          invitations
            .map((i) => i.modashUserId)
            .filter(Boolean)
            .map((x) => String(x).trim())
        ),
      ];

      const providers = [
        ...new Set(
          invitations
            .map((i) => i.platform)
            .filter(Boolean)
            .map((x) => String(x).trim().toLowerCase())
        ),
      ];

      const modashQuery = {};
      if (modashUserIds.length) modashQuery.userId = { $in: modashUserIds };
      if (providers.length) modashQuery.provider = { $in: providers };

      const [brands, influencers, modashDocs] = await Promise.all([
        brandIds.length
          ? Brand.find({ brandId: { $in: brandIds } })
              .select("brandId name brandName companyName")
              .lean()
          : [],
        influencerIds.length
          ? Influencer.find({ _id: { $in: toObjectIds(influencerIds) } })
              .select("_id name")
              .lean()
          : [],
        modashUserIds.length
          ? Modash.find(modashQuery)
              .select("userId provider fullname username handle")
              .lean()
          : [],
      ]);

      brandMap = new Map(
        brands.map((b) => [
          String(b.brandId),
          b.name || b.brandName || b.companyName || "",
        ])
      );

      influencerMap = new Map(
        influencers.map((i) => [String(i._id), i.name || ""])
      );

      modashMap = new Map(
        modashDocs.map((m) => [
          `${String(m.userId).trim()}|${String(m.provider).trim().toLowerCase()}`,
          m.fullname || m.username || m.handle || "",
        ])
      );
    }

    const result = invitations.map((inv) => {
      const c = includeCampaign ? campaignMap.get(String(inv.campaignId)) : null;
      const brandName = includeNames
        ? brandMap.get(String(inv.brandId)) || ""
        : undefined;

      let influencerName = undefined;

      if (includeNames) {
        influencerName = inv.influencerId
          ? influencerMap.get(String(inv.influencerId)) || ""
          : "";

        if ((!influencerName || influencerName.trim() === "") && inv.modashUserId) {
          const key = `${String(inv.modashUserId).trim()}|${String(
            inv.platform || ""
          )
            .trim()
            .toLowerCase()}`;
          influencerName = modashMap.get(key) || "";
        }
      }

      return {
        invitationId: inv.invitationId,

        brandId: inv.brandId,
        brandName: includeNames ? brandName || null : undefined,

        influencerId: inv.influencerId ? String(inv.influencerId) : null,
        influencerName: includeNames ? influencerName || null : undefined,

        campaignId: inv.campaignId ? String(inv.campaignId) : null,
        campaignsId: inv.campaignsId || null,

        productOrServiceName: includeCampaign
          ? c?.productOrServiceName || null
          : null,

        platform: inv.platform,
        handle: inv.handle,
        status: inv.status,
        modashUserId: inv.modashUserId || null,

        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      };
    });

    const cleaned = result.map((x) => {
      const y = { ...x };
      Object.keys(y).forEach((k) => y[k] === undefined && delete y[k]);
      return y;
    });

    return res.json({
      status: "success",
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      invitations: cleaned,
    });
  } catch (e) {
    console.error("getInvitationsList error:", e);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
};

/**
 * POST /admin/invitations/by-campaignsId
 * Only supports UUID campaignsId (string or array)
 */
exports.getInvitationsByCampaignsIdPost = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.body?.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.body?.limit || "25", 10), 1),
      200
    );
    const skip = (page - 1) * limit;

    const includeCampaign = String(req.body?.includeCampaign ?? "1") === "1";
    const includeNames = String(req.body?.includeNames ?? "1") === "1";

    const raw = req.body?.campaignsId ?? req.body?.campaignsIds;
    let requestedCampaignsIds = [];

    if (Array.isArray(raw)) {
      requestedCampaignsIds = raw
        .map((x) => String(x || "").trim())
        .filter(Boolean);
    } else if (typeof raw === "string" || raw != null) {
      const v = String(raw || "").trim();
      if (v) requestedCampaignsIds = [v];
    }

    requestedCampaignsIds = [...new Set(requestedCampaignsIds)];

    if (!requestedCampaignsIds.length) {
      return res.status(400).json({
        status: "error",
        message:
          'campaignsId is required (UUID string or array). This API does NOT accept campaignId (Mongo _id).',
      });
    }

    const filter = {};

    if (req.body?.brandId) {
      filter.brandId = String(req.body.brandId).trim();
    }

    if (req.body?.platform) {
      filter.platform = String(req.body.platform).trim().toLowerCase();
    }

    if (req.body?.status) {
      filter.status = String(req.body.status).trim().toLowerCase();
    }

    if (req.body?.modashUserId) {
      filter.modashUserId = String(req.body.modashUserId).trim();
    }

    if (req.body?.influencerId) {
      const influencerId = String(req.body.influencerId).trim();
      if (!isObjectId(influencerId)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid influencerId",
        });
      }
      filter.influencerId = toObjectId(influencerId);
    }

    if (req.body?.handle) {
      const h = normalizeHandle(req.body.handle);
      if (!h || !HANDLE_RX.test(h)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid handle format. Use @username",
        });
      }
      filter.handle = h;
    }

    filter.campaignsId =
      requestedCampaignsIds.length === 1
        ? requestedCampaignsIds[0]
        : { $in: requestedCampaignsIds };

    const [total, invitations] = await Promise.all([
      CampaignInvitation.countDocuments(filter),
      CampaignInvitation.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const found = new Set(
      invitations
        .map((i) => String(i.campaignsId || "").trim())
        .filter(Boolean)
    );

    const missingCampaignsIds = requestedCampaignsIds.filter(
      (id) => !found.has(id)
    );

    let campaignMap = new Map();
    let brandMap = new Map();
    let influencerMap = new Map();
    let modashMap = new Map();

    if (includeCampaign && invitations.length) {
      const campaignIds = [
        ...new Set(
          invitations
            .map((i) => i.campaignId)
            .filter(Boolean)
            .map((x) => String(x))
        ),
      ];

      const campaigns = await Campaign.find({
        _id: { $in: toObjectIds(campaignIds) },
      })
        .select("_id campaignsId productOrServiceName brandId")
        .lean();

      campaignMap = new Map(campaigns.map((c) => [String(c._id), c]));
    }

    if (includeNames && invitations.length) {
      const brandIds = [
        ...new Set(
          invitations
            .map((i) => i.brandId)
            .filter(Boolean)
            .map((x) => String(x))
        ),
      ];

      const influencerIds = [
        ...new Set(
          invitations
            .map((i) => i.influencerId)
            .filter(Boolean)
            .map((x) => String(x))
        ),
      ];

      const modashUserIds = [
        ...new Set(
          invitations
            .map((i) => i.modashUserId)
            .filter(Boolean)
            .map((x) => String(x).trim())
        ),
      ];

      const providers = [
        ...new Set(
          invitations
            .map((i) => i.platform)
            .filter(Boolean)
            .map((x) => String(x).trim().toLowerCase())
        ),
      ];

      const modashQuery = {};
      if (modashUserIds.length) modashQuery.userId = { $in: modashUserIds };
      if (providers.length) modashQuery.provider = { $in: providers };

      const [brands, influencers, modashDocs] = await Promise.all([
        brandIds.length
          ? Brand.find({ brandId: { $in: brandIds } })
              .select("brandId name brandName companyName")
              .lean()
          : [],
        influencerIds.length
          ? Influencer.find({ _id: { $in: toObjectIds(influencerIds) } })
              .select("_id name")
              .lean()
          : [],
        modashUserIds.length
          ? Modash.find(modashQuery)
              .select("userId provider fullname username handle")
              .lean()
          : [],
      ]);

      brandMap = new Map(
        brands.map((b) => [
          String(b.brandId),
          b.name || b.brandName || b.companyName || "",
        ])
      );

      influencerMap = new Map(
        influencers.map((i) => [String(i._id), i.name || ""])
      );

      modashMap = new Map(
        modashDocs.map((m) => [
          `${String(m.userId).trim()}|${String(m.provider).trim().toLowerCase()}`,
          m.fullname || m.username || m.handle || "",
        ])
      );
    }

    const cleaned = invitations.map((inv) => {
      const c = includeCampaign ? campaignMap.get(String(inv.campaignId)) : null;

      const brandName = includeNames
        ? brandMap.get(String(inv.brandId)) || ""
        : undefined;

      let influencerName = undefined;
      if (includeNames) {
        influencerName = inv.influencerId
          ? influencerMap.get(String(inv.influencerId)) || ""
          : "";

        if ((!influencerName || influencerName.trim() === "") && inv.modashUserId) {
          const key = `${String(inv.modashUserId).trim()}|${String(
            inv.platform || ""
          )
            .trim()
            .toLowerCase()}`;
          influencerName = modashMap.get(key) || "";
        }
      }

      const out = {
        invitationId: inv.invitationId,

        brandId: inv.brandId,
        brandName: includeNames ? brandName || null : undefined,

        influencerId: inv.influencerId ? String(inv.influencerId) : null,
        influencerName: includeNames ? influencerName || null : undefined,

        campaignId: inv.campaignId ? String(inv.campaignId) : null,
        campaignsId: inv.campaignsId || null,

        productOrServiceName: includeCampaign
          ? c?.productOrServiceName || null
          : null,

        platform: inv.platform,
        handle: inv.handle,
        status: inv.status,
        modashUserId: inv.modashUserId || null,

        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      };

      Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
      return out;
    });

    return res.json({
      status: "success",
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      requested: requestedCampaignsIds.length,
      returned: cleaned.length,
      missingCampaignsIds,
      invitations: cleaned,
    });
  } catch (e) {
    console.error("getInvitationsByCampaignsIdPost error:", e);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
};