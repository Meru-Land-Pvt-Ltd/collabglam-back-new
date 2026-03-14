require("dotenv").config();

const SupportTicket = require("../models/supportTicket");

const BrandModule = require("../models/brand");
const BrandModel = BrandModule.BrandModel || BrandModule.default || BrandModule;

const InfluencerModule = require("../models/influencer");
const InfluencerModel =
  InfluencerModule.InfluencerModel ||
  InfluencerModule.default ||
  InfluencerModule;

const Campaign = require("../models/campaign");

const {
  handleSendSupportCreatedToUser,
  handleSendSupportCreatedToTeam,
  handleSendSupportReplyToUser,
  handleSendSupportReplyToTeam,
  handleSendSupportStatusUpdatedToUser,
} = require("../services/supportEmailService");

// ✅ Use the SAME helper as disputes
// Adjust path if your shared helper file is elsewhere.
const { buildAttachmentsFromReq } = require("../utils/attachmentUpload");

const ALLOWED_STATUSES = new Set([
  "open",
  "in_progress",
  "waiting_on_user",
  "resolved",
  "closed",
]);

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePaging(page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  return { p, l };
}

function normalizeStatus(status) {
  if (!status) return null;
  const s = String(status).trim();
  if (!ALLOWED_STATUSES.has(s)) return null;
  return s;
}

async function resolveBrandCampaign(brandId, relatedCampaignId) {
  if (!relatedCampaignId) {
    return { relatedCampaignId: null, relatedCampaignName: null };
  }

  const campaign = await Campaign.findOne({
    _id: String(relatedCampaignId),
    brandId: String(brandId),
  }).lean();

  if (!campaign) {
    return { relatedCampaignId: null, relatedCampaignName: null };
  }

  return {
    relatedCampaignId: String(campaign._id),
    relatedCampaignName:
      campaign.productOrServiceName ||
      campaign.campaignTitle ||
      campaign.campaignName ||
      null,
  };
}

async function resolveInfluencerCampaign(relatedCampaignId) {
  if (!relatedCampaignId) {
    return { relatedCampaignId: null, relatedCampaignName: null };
  }

  const campaign = await Campaign.findOne({
    _id: String(relatedCampaignId),
  }).lean();

  if (!campaign) {
    return { relatedCampaignId: null, relatedCampaignName: null };
  }

  return {
    relatedCampaignId: String(campaign._id),
    relatedCampaignName:
      campaign.productOrServiceName ||
      campaign.campaignTitle ||
      campaign.campaignName ||
      null,
  };
}

async function createTicket({
  requesterRole,
  requesterId,
  requesterName,
  requesterEmail,
  category,
  description,
  relatedCampaignId,
  relatedCampaignName,
  attachments,
}) {
  const ticket = new SupportTicket({
    requesterRole,
    requesterId: String(requesterId),
    requesterName: requesterName || null,
    requesterEmail: requesterEmail || null,
    category: String(category).trim(),
    description: String(description).trim(),
    relatedCampaignId: relatedCampaignId || null,
    relatedCampaignName: relatedCampaignName || null,
    attachments: attachments || [],
    status: "open",
    lastMessageAt: new Date(),
    lastMessageByRole: requesterRole,
  });

  await ticket.save();
  return ticket;
}

/* -------------------------------------------------------------------------- */
/*                               BRAND CREATE                                 */
/* -------------------------------------------------------------------------- */

exports.brandCreate = async (req, res) => {
  try {
    const {
      brandId,
      category,
      description,
      relatedCampaignId,
      attachments = [],
    } = req.body || {};

    if (!brandId || !category || !String(description || "").trim()) {
      return res.status(400).json({
        message: "brandId, category and description are required",
      });
    }

    const brand = await BrandModel.findOne({ _id: String(brandId) }).lean();
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const campaignInfo = await resolveBrandCampaign(brandId, relatedCampaignId);

    // ✅ Same attachment flow as disputes
    const sanitizedAttachments = await buildAttachmentsFromReq(req, attachments);

    const ticket = await createTicket({
      requesterRole: "Brand",
      requesterId: brandId,
      requesterName: brand.name || null,
      requesterEmail: brand.email || null,
      category,
      description,
      relatedCampaignId: campaignInfo.relatedCampaignId,
      relatedCampaignName: campaignInfo.relatedCampaignName,
      attachments: sanitizedAttachments,
    });

    try {
      if (brand.email) {
        await handleSendSupportCreatedToUser({
          email: brand.email,
          userName: brand.name,
          role: "Brand",
          ticketId: ticket.ticketId,
          category: ticket.category,
          relatedCampaignName: ticket.relatedCampaignName,
        });
      }

      await handleSendSupportCreatedToTeam({
        ticketId: ticket.ticketId,
        requesterRole: "Brand",
        requesterName: brand.name,
        requesterEmail: brand.email,
        category: ticket.category,
        relatedCampaignName: ticket.relatedCampaignName,
        description: ticket.description,
      });
    } catch (e) {
      console.warn("Support email send failed (brandCreate):", e.message);
    }

    return res.status(201).json({
      message: "Support request created",
      ticketId: ticket.ticketId,
      ticket,
    });
  } catch (err) {
    console.error("Error in brandCreate support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                            INFLUENCER CREATE                               */
/* -------------------------------------------------------------------------- */

exports.influencerCreate = async (req, res) => {
  try {
    const {
      influencerId,
      category,
      description,
      relatedCampaignId,
      attachments = [],
    } = req.body || {};

    if (!influencerId || !category || !String(description || "").trim()) {
      return res.status(400).json({
        message: "influencerId, category and description are required",
      });
    }

    const influencer = await InfluencerModel.findOne({
      _id: String(influencerId),
    }).lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const campaignInfo = await resolveInfluencerCampaign(relatedCampaignId);

    // ✅ Same attachment flow as disputes
    const sanitizedAttachments = await buildAttachmentsFromReq(req, attachments);

    const ticket = await createTicket({
      requesterRole: "Influencer",
      requesterId: influencerId,
      requesterName: influencer.name || null,
      requesterEmail: influencer.email || null,
      category,
      description,
      relatedCampaignId: campaignInfo.relatedCampaignId,
      relatedCampaignName: campaignInfo.relatedCampaignName,
      attachments: sanitizedAttachments,
    });

    try {
      if (influencer.email) {
        await handleSendSupportCreatedToUser({
          email: influencer.email,
          userName: influencer.name,
          role: "Influencer",
          ticketId: ticket.ticketId,
          category: ticket.category,
          relatedCampaignName: ticket.relatedCampaignName,
        });
      }

      await handleSendSupportCreatedToTeam({
        ticketId: ticket.ticketId,
        requesterRole: "Influencer",
        requesterName: influencer.name,
        requesterEmail: influencer.email,
        category: ticket.category,
        relatedCampaignName: ticket.relatedCampaignName,
        description: ticket.description,
      });
    } catch (e) {
      console.warn("Support email send failed (influencerCreate):", e.message);
    }

    return res.status(201).json({
      message: "Support request created",
      ticketId: ticket.ticketId,
      ticket,
    });
  } catch (err) {
    console.error("Error in influencerCreate support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                                BRAND LIST                                  */
/* -------------------------------------------------------------------------- */

exports.brandList = async (req, res) => {
  try {
    const {
      brandId,
      page = 1,
      limit = 10,
      status,
      category,
      search,
    } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    const brand = await BrandModel.findOne({ _id: String(brandId) })
      .select("_id")
      .lean();

    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const { p, l } = normalizePaging(page, limit);

    const filter = {
      requesterRole: "Brand",
      requesterId: String(brandId),
    };

    const normalizedStatus = normalizeStatus(status);
    if (normalizedStatus) {
      filter.status = normalizedStatus;
    }

    if (category && String(category).trim()) {
      filter.category = String(category).trim();
    }

    const searchTerm = typeof search === "string" ? search.trim() : "";
    if (searchTerm) {
      const re = new RegExp(escapeRegex(searchTerm), "i");
      filter.$or = [
        { ticketId: re },
        { category: re },
        { description: re },
        { relatedCampaignName: re },
      ];
    }

    const total = await SupportTicket.countDocuments(filter);
    const rows = await SupportTicket.find(filter)
      .sort({ updatedAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    return res.status(200).json({
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l),
      tickets: rows,
    });
  } catch (err) {
    console.error("Error in brandList support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                             INFLUENCER LIST                                */
/* -------------------------------------------------------------------------- */

exports.influencerList = async (req, res) => {
  try {
    const {
      influencerId,
      page = 1,
      limit = 10,
      status,
      category,
      search,
    } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    const influencer = await InfluencerModel.findOne({
      _id: String(influencerId),
    })
      .select("_id")
      .lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const { p, l } = normalizePaging(page, limit);

    const filter = {
      requesterRole: "Influencer",
      requesterId: String(influencerId),
    };

    const normalizedStatus = normalizeStatus(status);
    if (normalizedStatus) {
      filter.status = normalizedStatus;
    }

    if (category && String(category).trim()) {
      filter.category = String(category).trim();
    }

    const searchTerm = typeof search === "string" ? search.trim() : "";
    if (searchTerm) {
      const re = new RegExp(escapeRegex(searchTerm), "i");
      filter.$or = [
        { ticketId: re },
        { category: re },
        { description: re },
        { relatedCampaignName: re },
      ];
    }

    const total = await SupportTicket.countDocuments(filter);
    const rows = await SupportTicket.find(filter)
      .sort({ updatedAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    return res.status(200).json({
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l),
      tickets: rows,
    });
  } catch (err) {
    console.error("Error in influencerList support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                               BRAND GET ONE                                */
/* -------------------------------------------------------------------------- */

exports.brandGetOne = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { brandId } = req.query;

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    const ticket = await SupportTicket.findOne({
      ticketId: String(ticketId),
      requesterRole: "Brand",
      requesterId: String(brandId),
    }).lean();

    if (!ticket) {
      return res.status(404).json({ message: "Support ticket not found" });
    }

    return res.status(200).json({ ticket });
  } catch (err) {
    console.error("Error in brandGetOne support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                            INFLUENCER GET ONE                              */
/* -------------------------------------------------------------------------- */

exports.influencerGetOne = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { influencerId } = req.query;

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    const ticket = await SupportTicket.findOne({
      ticketId: String(ticketId),
      requesterRole: "Influencer",
      requesterId: String(influencerId),
    }).lean();

    if (!ticket) {
      return res.status(404).json({ message: "Support ticket not found" });
    }

    return res.status(200).json({ ticket });
  } catch (err) {
    console.error("Error in influencerGetOne support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                               BRAND REPLY                                  */
/* -------------------------------------------------------------------------- */

exports.brandReply = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { brandId, text = "", attachments = [] } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required" });
    }

    const ticket = await SupportTicket.findOne({
      ticketId: String(ticketId),
      requesterRole: "Brand",
      requesterId: String(brandId),
    });

    if (!ticket) {
      return res.status(404).json({ message: "Support ticket not found" });
    }

    if (["resolved", "closed"].includes(ticket.status)) {
      return res.status(400).json({
        message: "This support ticket is already closed",
      });
    }

    // ✅ Same attachment flow as disputes
    const sanitizedAttachments = await buildAttachmentsFromReq(req, attachments);

    if (!String(text).trim() && !sanitizedAttachments.length) {
      return res.status(400).json({
        message: "Reply text or attachment is required",
      });
    }

    ticket.messages.push({
      authorRole: "Brand",
      authorId: String(brandId),
      text: String(text || "").trim(),
      attachments: sanitizedAttachments,
      createdAt: new Date(),
    });

    ticket.lastMessageAt = new Date();
    ticket.lastMessageByRole = "Brand";

    if (ticket.status === "waiting_on_user") {
      ticket.status = "in_progress";
    }

    await ticket.save();

    try {
      await handleSendSupportReplyToTeam({
        ticketId: ticket.ticketId,
        requesterRole: "Brand",
        authorRole: "Brand",
        requesterName: ticket.requesterName,
        requesterEmail: ticket.requesterEmail,
        textBody: String(text || "").trim(),
        status: ticket.status,
      });
    } catch (e) {
      console.warn("Support email send failed (brandReply):", e.message);
    }

    return res.status(200).json({
      message: "Reply added",
      ticketId: ticket.ticketId,
    });
  } catch (err) {
    console.error("Error in brandReply support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                            INFLUENCER REPLY                                */
/* -------------------------------------------------------------------------- */

exports.influencerReply = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { influencerId, text = "", attachments = [] } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ message: "influencerId is required" });
    }

    const ticket = await SupportTicket.findOne({
      ticketId: String(ticketId),
      requesterRole: "Influencer",
      requesterId: String(influencerId),
    });

    if (!ticket) {
      return res.status(404).json({ message: "Support ticket not found" });
    }

    if (["resolved", "closed"].includes(ticket.status)) {
      return res.status(400).json({
        message: "This support ticket is already closed",
      });
    }

    // ✅ Same attachment flow as disputes
    const sanitizedAttachments = await buildAttachmentsFromReq(req, attachments);

    if (!String(text).trim() && !sanitizedAttachments.length) {
      return res.status(400).json({
        message: "Reply text or attachment is required",
      });
    }

    ticket.messages.push({
      authorRole: "Influencer",
      authorId: String(influencerId),
      text: String(text || "").trim(),
      attachments: sanitizedAttachments,
      createdAt: new Date(),
    });

    ticket.lastMessageAt = new Date();
    ticket.lastMessageByRole = "Influencer";

    if (ticket.status === "waiting_on_user") {
      ticket.status = "in_progress";
    }

    await ticket.save();

    try {
      await handleSendSupportReplyToTeam({
        ticketId: ticket.ticketId,
        requesterRole: "Influencer",
        authorRole: "Influencer",
        requesterName: ticket.requesterName,
        requesterEmail: ticket.requesterEmail,
        textBody: String(text || "").trim(),
        status: ticket.status,
      });
    } catch (e) {
      console.warn("Support email send failed (influencerReply):", e.message);
    }

    return res.status(200).json({
      message: "Reply added",
      ticketId: ticket.ticketId,
    });
  } catch (err) {
    console.error("Error in influencerReply support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                                ADMIN LIST                                  */
/* -------------------------------------------------------------------------- */

exports.adminList = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      category,
      requesterRole,
      search,
    } = req.body || {};

    const { p, l } = normalizePaging(page, limit);

    const filter = {};

    const normalizedStatus = normalizeStatus(status);
    if (normalizedStatus) {
      filter.status = normalizedStatus;
    }

    if (category && String(category).trim()) {
      filter.category = String(category).trim();
    }

    if (requesterRole && ["Brand", "Influencer"].includes(String(requesterRole))) {
      filter.requesterRole = String(requesterRole);
    }

    const searchTerm = typeof search === "string" ? search.trim() : "";
    if (searchTerm) {
      const re = new RegExp(escapeRegex(searchTerm), "i");
      filter.$or = [
        { ticketId: re },
        { requesterName: re },
        { requesterEmail: re },
        { category: re },
        { description: re },
        { relatedCampaignName: re },
      ];
    }

    const total = await SupportTicket.countDocuments(filter);
    const rows = await SupportTicket.find(filter)
      .sort({ updatedAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    return res.status(200).json({
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l),
      tickets: rows,
    });
  } catch (err) {
    console.error("Error in adminList support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                              ADMIN GET ONE                                 */
/* -------------------------------------------------------------------------- */

exports.adminGetOne = async (req, res) => {
  try {
    const { ticketId } = req.params;

    const ticket = await SupportTicket.findOne({
      ticketId: String(ticketId),
    }).lean();

    if (!ticket) {
      return res.status(404).json({ message: "Support ticket not found" });
    }

    return res.status(200).json({ ticket });
  } catch (err) {
    console.error("Error in adminGetOne support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                               ADMIN REPLY                                  */
/* -------------------------------------------------------------------------- */

exports.adminReply = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const {
      adminId,
      adminName,
      text = "",
      status,
      attachments = [],
    } = req.body || {};

    if (!adminId) {
      return res.status(400).json({ message: "adminId is required" });
    }

    const ticket = await SupportTicket.findOne({
      ticketId: String(ticketId),
    });

    if (!ticket) {
      return res.status(404).json({ message: "Support ticket not found" });
    }

    if (ticket.status === "closed") {
      return res.status(400).json({
        message: "This support ticket is already closed",
      });
    }

    // ✅ Same attachment flow as disputes
    const sanitizedAttachments = await buildAttachmentsFromReq(req, attachments);
    const normalizedStatus = status ? normalizeStatus(status) : null;

    if (!String(text).trim() && !sanitizedAttachments.length && !normalizedStatus) {
      return res.status(400).json({
        message: "Reply text, attachment, or status update is required",
      });
    }

    if (String(text).trim() || sanitizedAttachments.length) {
      ticket.messages.push({
        authorRole: "Admin",
        authorId: String(adminId),
        text: String(text || "").trim(),
        attachments: sanitizedAttachments,
        createdAt: new Date(),
      });

      ticket.lastMessageAt = new Date();
      ticket.lastMessageByRole = "Admin";
    }

    if (normalizedStatus) {
      ticket.status = normalizedStatus;
    } else if (ticket.status === "open") {
      ticket.status = "in_progress";
    }

    ticket.assignedTo = {
      adminId: String(adminId),
      name: adminName || ticket.assignedTo?.name || null,
    };

    await ticket.save();

    try {
      if (ticket.requesterEmail) {
        await handleSendSupportReplyToUser({
          email: ticket.requesterEmail,
          userName: ticket.requesterName,
          ticketId: ticket.ticketId,
          authorRole: "Support Team",
          textBody: String(text || "").trim(),
          status: ticket.status,
        });
      }
    } catch (e) {
      console.warn("Support email send failed (adminReply):", e.message);
    }

    return res.status(200).json({
      message: "Reply added",
      ticketId: ticket.ticketId,
    });
  } catch (err) {
    console.error("Error in adminReply support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/* -------------------------------------------------------------------------- */
/*                           ADMIN UPDATE STATUS                              */
/* -------------------------------------------------------------------------- */

exports.adminUpdateStatus = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { adminId, adminName, status } = req.body || {};

    if (!adminId) {
      return res.status(400).json({ message: "adminId is required" });
    }

    const normalizedStatus = normalizeStatus(status);
    if (!normalizedStatus) {
      return res.status(400).json({ message: "Valid status is required" });
    }

    const ticket = await SupportTicket.findOne({
      ticketId: String(ticketId),
    });

    if (!ticket) {
      return res.status(404).json({ message: "Support ticket not found" });
    }

    ticket.status = normalizedStatus;
    ticket.assignedTo = {
      adminId: String(adminId),
      name: adminName || ticket.assignedTo?.name || null,
    };

    await ticket.save();

    try {
      if (ticket.requesterEmail) {
        await handleSendSupportStatusUpdatedToUser({
          email: ticket.requesterEmail,
          userName: ticket.requesterName,
          ticketId: ticket.ticketId,
          status: ticket.status,
        });
      }
    } catch (e) {
      console.warn("Support email send failed (adminUpdateStatus):", e.message);
    }

    return res.status(200).json({
      message: "Status updated",
      ticketId: ticket.ticketId,
      status: ticket.status,
    });
  } catch (err) {
    console.error("Error in adminUpdateStatus support:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};