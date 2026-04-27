const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Campaign = require("../models/campaign");
const  OpenAI = require("openai");
const BrandInfo = require("../models/brandInfo")
const BrandCoupon = require("../models/brandCoupon")
const cheerio = require("cheerio");
const { GoogleGenAI } = require("@google/genai");
const { scrapeBrandWebsite } = require("../utils/brandScraper");
const { AdminModel, ROLES, PROXY_EMAIL_DOMAIN } = require("../models/master");
const {
  canInviteRole,
  buildAdminVisibilityFilter,
  canManageTarget,
} = require("../utils/adminHierarchy");
const { sendEmail } = require("../services/emailService");
const { adminInviteEmailTemplate } = require("../template/inviteRole");
const brand = require("../models/brand");
const subscription = require("../models/subscription");
const BrandAssigned = require("../models/brandAssigned");
const mongoose = require("mongoose");
const INVITE_EXP_MINUTES = Number(process.env.INVITE_EXP_MINUTES || 60);
const { buildCampaignVisibilityFilter } = require('../utils/campaignAccess');
const EXECUTIVE_ROLES = [ROLES.IME, ROLES.BME, ROLES.SDR];

// ======================
// Local Helpers
// ======================
function slugifyName(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^_+|_+$/g, "");
}

async function generateUniqueProxyEmail(name, email, currentAdminId) {
  let base = slugifyName(name);

  if (!base) {
    const emailPrefix = String(email || "").split("@")[0];
    base = slugifyName(emailPrefix);
  }

  if (!base) {
    base = "admin";
  }

  let candidate = `${base}@${PROXY_EMAIL_DOMAIN}`;
  let counter = 1;

  while (true) {
    const existing = await AdminModel.findOne({
      proxyEmail: candidate,
      ...(currentAdminId ? { _id: { $ne: currentAdminId } } : {}),
    }).select("_id proxyEmail");

    if (!existing) return candidate;

    candidate = `${base}${counter}@${PROXY_EMAIL_DOMAIN}`;
    counter += 1;
  }
}

const clean = (value) => {
  if (value === undefined || value === null) return "";
  return String(value).trim();
};

const exactCI = (value) => {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`, "i");
};

const parseAccess = (access) => {
  if (!Array.isArray(access)) return [];

  return access
    .map((item) => {
      if (typeof item === "string") {
        const key = item.trim().toLowerCase();
        if (!key) return null;

        return {
          key,
          name: key,
          isDelete: true,
          isEdit: true,
          isManager: false,
        };
      }

      if (item && typeof item === "object") {
        const key = clean(item.key).toLowerCase();
        if (!key) return null;

        return {
          key,
          name: clean(item.name) || key,
          isDelete: item.isDelete !== undefined ? Boolean(item.isDelete) : true,
          isEdit: item.isEdit !== undefined ? Boolean(item.isEdit) : true,
          isManager: item.isManager !== undefined ? Boolean(item.isManager) : false,
        };
      }

      return null;
    })
    .filter(Boolean);
};

const generateInviteToken = (size = 32) => {
  return crypto.randomBytes(size).toString("hex");
};

const sha256 = (value) => {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
};

function normalizeRole(role) {
  return clean(role).toLowerCase();
}

function resolveHierarchyFields(inviter, targetRole, explicitParentAdmin) {
  const role = normalizeRole(targetRole);
  const inviterId = inviter?._id || inviter?.adminId || null;
  const inviterRootAdmin = inviter?.rootAdmin || inviterId || null;

  if (role === ROLES.SUPER_ADMIN) {
    return {
      parentAdmin: null,
      rootAdmin: null,
      teamType: "leadership",
    };
  }

  if (inviter.role === ROLES.SUPER_ADMIN && role === ROLES.REVENUE_HEAD) {
    return {
      parentAdmin: inviterId,
      rootAdmin: inviterId,
      teamType: "sales",
    };
  }

  if (inviter.role === ROLES.SUPER_ADMIN && EXECUTIVE_ROLES.includes(role)) {
    return {
      parentAdmin: explicitParentAdmin || null,
      rootAdmin: inviterId,
      teamType: "execution",
    };
  }

  if (inviter.role === ROLES.REVENUE_HEAD && EXECUTIVE_ROLES.includes(role)) {
    return {
      parentAdmin: inviterId,
      rootAdmin: inviterRootAdmin,
      teamType: "execution",
    };
  }

  return {
    parentAdmin: null,
    rootAdmin: inviterRootAdmin,
    teamType: null,
  };
}

function normalizeProxyEmailInput(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return "";

  const localPart = raw.includes("@") ? raw.split("@")[0] : raw;
  const safeLocalPart = slugifyName(localPart);

  if (!safeLocalPart) return "";
  return `${safeLocalPart}@${PROXY_EMAIL_DOMAIN}`;
}

// ======================
// Admin Login
// ======================
exports.adminLogin = async (req, res) => {
  try {
    const email = clean(req.body?.email).toLowerCase();
    const password = clean(req.body?.password);

    if (!email || !password) {
      return res.status(400).json({
        message: "email and password are required",
      });
    }

    const admin = await AdminModel.findOne({ email: exactCI(email) }).select(
      "+passwordHash role status name email access parentAdmin rootAdmin proxyEmail"
    );

    if (!admin) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (admin.status !== "active") {
      return res.status(403).json({ message: `Admin is ${admin.status}` });
    }

    if (!admin.passwordHash) {
      return res.status(403).json({
        message: "Password not set. Please use invite link.",
      });
    }

    const isMatch = await bcrypt.compare(password, admin.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      return res.status(500).json({ message: "JWT_SECRET is missing in env" });
    }

    const payload = {
      adminId: admin._id.toString(),
      role: admin.role,
      email: admin.email,
      parentAdmin: admin.parentAdmin ? String(admin.parentAdmin) : null,
      rootAdmin: admin.rootAdmin ? String(admin.rootAdmin) : null,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

    admin.lastLoginAt = new Date();
    await admin.save();

    return res.status(200).json({
      message: "Login successful",
      token,
      admin: {
        _id: admin._id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        status: admin.status,
        access: admin.access || [],
        parentAdmin: admin.parentAdmin,
        rootAdmin: admin.rootAdmin,
        proxyEmail: admin.proxyEmail,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Internal error" });
  }
};

async function ensureUniqueProxyEmail(proxyEmail, currentAdminId) {
  const existing = await AdminModel.findOne({
    proxyEmail,
    ...(currentAdminId ? { _id: { $ne: currentAdminId } } : {}),
  }).select("_id proxyEmail");

  if (existing) {
    throw new Error("Proxy email already in use");
  }

  return proxyEmail;
}

// ======================
// Invite Admin
// ======================
exports.inviteAdmin = async (req, res) => {
  try {
    const actor = req.admin;

    if (!actor?.adminId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const email = clean(req.body?.email).toLowerCase();
    const role = normalizeRole(req.body?.role);
    const name = clean(req.body?.name);
    const access = parseAccess(req.body?.access);
    const explicitParentAdmin = clean(req.body?.parentAdmin);
    const requestedProxyEmail = normalizeProxyEmailInput(req.body?.proxyEmail);

    if (!email || !role) {
      return res.status(400).json({ message: "email and role are required" });
    }

    if (!Object.values(ROLES).includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    if (!canInviteRole(actor.role, role)) {
      return res.status(403).json({
        message: "You are not allowed to invite this role",
      });
    }

    let parentAdminDoc = null;

    if (actor.role === ROLES.SUPER_ADMIN && EXECUTIVE_ROLES.includes(role)) {
      if (!explicitParentAdmin) {
        return res.status(400).json({
          message: "parentAdmin is required when Super Admin invites IME/BME/SDR directly",
        });
      }

      parentAdminDoc = await AdminModel.findById(explicitParentAdmin).select("_id role rootAdmin");
      if (!parentAdminDoc || parentAdminDoc.role !== ROLES.REVENUE_HEAD) {
        return res.status(400).json({
          message: "parentAdmin must be a valid Revenue Head",
        });
      }
    }

    let admin = await AdminModel.findOne({ email: exactCI(email) }).select(
      "+passwordHash +inviteTokenHash"
    );

    const hierarchy = resolveHierarchyFields(actor, role, parentAdminDoc?._id);

    if (admin && admin.status === "active" && admin.passwordHash) {
      return res.status(409).json({ message: "Admin already active" });
    }

    if (!admin) {
      admin = new AdminModel({
        email,
        name: name || undefined,
        role,
        status: "pending",
        access,
        createdBy: actor.adminId,
        parentAdmin: hierarchy.parentAdmin,
        rootAdmin: hierarchy.rootAdmin,
        teamType: hierarchy.teamType,
      });
    } else {
      admin.role = role;
      if (name) admin.name = name;
      admin.status = "pending";

      if (Array.isArray(req.body?.access)) {
        admin.access = access;
      }

      admin.createdBy = actor.adminId;
      admin.parentAdmin = hierarchy.parentAdmin;
      admin.rootAdmin = hierarchy.rootAdmin;
      admin.teamType = hierarchy.teamType;
    }

    if (requestedProxyEmail) {
      admin.proxyEmail = await ensureUniqueProxyEmail(
        requestedProxyEmail,
        admin._id
      );
    } else if (!admin.proxyEmail) {
      admin.proxyEmail = await generateUniqueProxyEmail(
        admin.name,
        admin.email,
        admin._id
      );
    }

    const rawToken = generateInviteToken(32);
    const tokenHash = sha256(rawToken);

    admin.invitedAt = new Date();
    admin.inviteTokenHash = tokenHash;
    admin.inviteExpiresAt = new Date(Date.now() + INVITE_EXP_MINUTES * 60 * 1000);

    await admin.save();

    const adminAppUrl = process.env.ADMIN_APP_URL || "https://collabglam.com";
    const inviteLink = `${adminAppUrl}/admin/invite?token=${rawToken}`;

    const tpl = adminInviteEmailTemplate({
      invitedEmail: email,
      inviteLink,
      role,
      expiryMinutes: INVITE_EXP_MINUTES,
    });

    await sendEmail({
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });

    const response = {
      message: "Invite sent successfully",
    };

    if (process.env.NODE_ENV !== "production") {
      response.inviteLink = inviteLink;
    }

    return res.status(201).json(response);
  } catch (err) {
    if (err.message === "Proxy email already in use") {
      return res.status(409).json({ message: err.message });
    }

    return res.status(500).json({ message: err.message || "Internal error" });
  }
};

// ======================
// Accept Invite + Set Password
// ======================
exports.acceptInviteSetPassword = async (req, res) => {
  try {
    const token = clean(req.body?.token);
    const password = clean(req.body?.password);

    if (!token || !password) {
      return res.status(400).json({
        message: "token and password are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters",
      });
    }

    const tokenHash = sha256(token);

    const admin = await AdminModel.findOne({
      inviteTokenHash: tokenHash,
      inviteExpiresAt: { $gt: new Date() },
    }).select(
      "+inviteTokenHash +passwordHash role status email name access proxyEmail parentAdmin rootAdmin"
    );

    if (!admin) {
      return res.status(400).json({
        message: "Invite token invalid or expired",
      });
    }

    admin.passwordHash = await bcrypt.hash(password, 10);
    admin.status = "active";

    if (!admin.proxyEmail) {
      admin.proxyEmail = await generateUniqueProxyEmail(
        admin.name,
        admin.email,
        admin._id
      );
    }

    admin.inviteTokenHash = undefined;
    admin.inviteExpiresAt = undefined;

    await admin.save();

    return res.status(200).json({
      message: "Password set successfully. Please login.",
      proxyEmail: admin.proxyEmail,
    });
  } catch (err) {
    return res.status(500).json({
      message: err.message || "Internal error",
    });
  }
};

// ======================
// List Admins - SCOPED
// ======================
exports.listAdmins = async (req, res) => {
  try {
    const actor = req.admin;

    if (!actor?.adminId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const filter = await buildAdminVisibilityFilter(actor);

    const admins = await AdminModel.find(filter)
      .select(
        "email name role status invitedAt proxyEmail lastLoginAt createdAt updatedAt access parentAdmin rootAdmin createdBy"
      )
      .populate("parentAdmin", "name email role")
      .populate("createdBy", "name email role")
      .sort({ createdAt: -1 });

    return res.status(200).json(admins);
  } catch (err) {
    return res.status(500).json({
      message: err.message || "Internal error",
    });
  }
};

// ======================
// Update Admin Status / Role / Access - SCOPED
// ======================
exports.updateStatus = async (req, res) => {
  try {
    const actor = req.admin;

    if (!actor?.adminId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const adminId = clean(req.body?.adminId);
    const status = clean(req.body?.status).toLowerCase();
    const role = normalizeRole(req.body?.role);
    const hasNameField = Object.prototype.hasOwnProperty.call(req.body, "name");
    const name = clean(req.body?.name);

    const accessProvided = Array.isArray(req.body?.access);
    const access = parseAccess(req.body?.access);

    if (!adminId || !status) {
      return res.status(400).json({
        message: "adminId and status are required",
      });
    }

    if (!["pending", "active", "inactive", "suspended"].includes(status)) {
      return res.status(400).json({
        message: "Invalid status",
      });
    }

    const admin = await AdminModel.findById(adminId);

    if (!admin) {
      return res.status(404).json({
        message: "Admin not found",
      });
    }

    const allowed = await canManageTarget(
      { ...actor, _id: actor._id || actor.adminId },
      admin._id
    );

    if (!allowed) {
      return res.status(403).json({
        message: "You are not allowed to update this admin",
      });
    }

    const currentRole = normalizeRole(admin.role);
    const roleChanged = Boolean(role) && role !== currentRole;

    if (roleChanged) {
      if (!Object.values(ROLES).includes(role)) {
        return res.status(400).json({
          message: "Invalid role",
        });
      }

      if (!canInviteRole(actor.role, role)) {
        return res.status(403).json({
          message: "You are not allowed to assign this role",
        });
      }

      admin.role = role;
    }

    if (hasNameField) {
      admin.name = name || undefined;
    }

    admin.status = status;

    if (accessProvided) {
      admin.access = access;
    }

    await admin.save();

    return res.status(200).json({
      message: "Admin updated successfully",
    });
  } catch (err) {
    return res.status(500).json({
      message: err.message || "Internal error",
    });
  }
};

// ======================
// Admin Me
// ======================
exports.adminMe = async (req, res) => {
  try {
    const adminId = req.admin?.adminId;

    if (!adminId) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const admin = await AdminModel.findById(adminId).select(
      "email name role status access lastLoginAt createdAt updatedAt parentAdmin rootAdmin proxyEmail "
    );

    if (!admin) {
      return res.status(404).json({
        message: "Admin not found",
      });
    }

    const permissions = Array.isArray(admin.access)
      ? admin.access.map((p) => ({
        key: String(p?.key || "").toLowerCase().trim(),
        name: p?.name ? String(p.name) : undefined,
        isEdit: Boolean(p?.isEdit),
        isDelete: Boolean(p?.isDelete),
        isManager: Boolean(p?.isManager),
      }))
      : [];

    const canEditPermissions =
      String(admin.status || "").toLowerCase() === "active" &&
      permissions.some((p) => p.isEdit === true);

    return res.status(200).json({
      _id: admin._id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      status: admin.status,
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
      proxyEmail: admin.proxyEmail,
      updatedAt: admin.updatedAt,
      parentAdmin: admin.parentAdmin,
      rootAdmin: admin.rootAdmin,
      permissions,
      canEditPermissions,
    });
  } catch (err) {
    return res.status(500).json({
      message: err.message || "Internal error",
    });
  }
};

exports.sendBulkEmailCsv = async (req, res) => {
  try {
    const admin = req.admin;
    const executiveId = admin?.adminId;
    console.log(req.body, req.file);
    if (!executiveId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const campaignId = String(req.body?.campaignId || "").trim();
    const file = req.file; // multer

    if (!campaignId) {
      return res.status(400).json({
        success: false,
        message: "campaignId is required",
      });
    }

    if (!file?.buffer) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required (field: file)",
      });
    }

    const result = await sendBulkEmailToCsvByCampaignId({
      campaignId,
      executiveId,
      csvBuffer: file.buffer,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: e?.message || "Internal error",
    });
  }
};
exports.fullyManagedBrandList = async (req, res) => {
  try {
    const brandList = await brand
      .find({
        "subscription.planId": "e5cb75da-6d0d-481b-b202-69b9cf864940",
        "subscription.status": "active",
      })
      .lean();

    const enrichedBrandList = await Promise.all(
      brandList.map(async (item) => {
        // change brandId to brand if your BrandAssigned schema uses another field name
        const assignedData = await BrandAssigned.findOne({ brandId: item._id }).lean();

        console.log("assignedData for brand", item._id, assignedData);
        if (assignedData) {
          const masterIds = [
            assignedData.RHId,
            assignedData.bdmId,
            assignedData.idmId,
          ].filter(Boolean);

          if (masterIds.length > 0) {
            const masters = await AdminModel.find({ _id: { $in: masterIds } })
              .select("_id name")
              .lean();

            const masterMap = {};
            masters.forEach((m) => {
              masterMap[String(m._id)] = m.name || "";
            });
          }
        }

        return {
          ...item,
        };
      })
    );

    return res.status(200).json({
      success: true,
      data: enrichedBrandList,
    });
  } catch (e) {
    console.error("fullyManagedBrandList error:", e);
    return res.status(500).json({
      success: false,
      message: e?.message || "Internal error",
    });
  }
};

async function validateExecutivesUnderRH({ RHId, bdmId, idmId, sdrId }) {
  const rhId = String(RHId || "").trim();

  if (!rhId || !mongoose.isValidObjectId(rhId)) {
    throw new Error("Valid RHId is required before assigning BME/IME/SDR");
  }

  const rh = await AdminModel.findOne({
    _id: rhId,
    role: ROLES.REVENUE_HEAD,
    status: "active",
  }).select("_id");

  if (!rh) {
    throw new Error("Assigned RH not found or inactive");
  }

  if (bdmId !== undefined && bdmId !== null && String(bdmId).trim() !== "") {
    if (!mongoose.isValidObjectId(String(bdmId))) {
      throw new Error("Invalid bdmId");
    }

    const bme = await AdminModel.findOne({
      _id: bdmId,
      role: ROLES.BME,
      status: "active",
      parentAdmin: rhId,
    }).select("_id");

    if (!bme) {
      throw new Error("Selected BME does not belong to the assigned RH");
    }
  }

  if (idmId !== undefined && idmId !== null && String(idmId).trim() !== "") {
    if (!mongoose.isValidObjectId(String(idmId))) {
      throw new Error("Invalid idmId");
    }

    const ime = await AdminModel.findOne({
      _id: idmId,
      role: ROLES.IME,
      status: "active",
      parentAdmin: rhId,
    }).select("_id");

    if (!ime) {
      throw new Error("Selected IME does not belong to the assigned RH");
    }
  }

  if (sdrId !== undefined && sdrId !== null && String(sdrId).trim() !== "") {
    if (!mongoose.isValidObjectId(String(sdrId))) {
      throw new Error("Invalid sdrId");
    }

    const sdr = await AdminModel.findOne({
      _id: sdrId,
      role: ROLES.SDR,
      status: "active",
      parentAdmin: rhId,
    }).select("_id");

    if (!sdr) {
      throw new Error("Selected SDR does not belong to the assigned RH");
    }
  }
}

exports.assignBrand = async (req, res) => {
  try {
    const { brandId, RHId, bdmId, idmId } = req.body;

    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: "brandId is required",
      });
    }

    if (!mongoose.isValidObjectId(String(brandId))) {
      return res.status(400).json({
        success: false,
        message: "Invalid brandId",
      });
    }

    const wantsRH =
      RHId !== undefined && RHId !== null && String(RHId).trim() !== "";
    const wantsBDMorIDM = bdmId !== undefined || idmId !== undefined;

    if (!wantsRH && !wantsBDMorIDM) {
      return res.status(400).json({
        success: false,
        message: "Send RHId to assign RH OR send bdmId/idmId to assign BDM/IDM",
      });
    }

    const normalizedBrandId = new mongoose.Types.ObjectId(String(brandId));

    // CASE A: RH assignment
    if (wantsRH) {
      await validateExecutivesUnderRH({ RHId, bdmId, idmId });

      // IMPORTANT:
      // when RH changes, reset old BME/IME unless explicitly sent
      const set = {
        RHId,
        bdmId: bdmId !== undefined ? (bdmId || null) : null,
        idmId: idmId !== undefined ? (idmId || null) : null,
        status: "active",
      };

      let doc = await BrandAssigned.findOneAndUpdate(
        { brandId: normalizedBrandId, status: "active" },
        { $set: set },
        { new: true }
      ).exec();

      if (!doc) {
        doc = await BrandAssigned.findOneAndUpdate(
          { brandId: normalizedBrandId },
          { $set: set },
          { new: true, sort: { updatedAt: -1, createdAt: -1 } }
        ).exec();
      }

      if (!doc) {
        doc = await BrandAssigned.create({
          brandId: normalizedBrandId,
          RHId,
          bdmId: bdmId || null,
          idmId: idmId || null,
          status: "active",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Brand assignment saved successfully",
        data: doc,
      });
    }

    // CASE B: only BME / IME assignment, RH must already exist
    let activeAssignment = await BrandAssigned.findOne({
      brandId: normalizedBrandId,
      status: "active",
      RHId: { $exists: true, $ne: null },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    if (!activeAssignment) {
      activeAssignment = await BrandAssigned.findOne({
        brandId: normalizedBrandId,
        RHId: { $exists: true, $ne: null },
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();
    }

    if (!activeAssignment?.RHId) {
      return res.status(400).json({
        success: false,
        message: "RH is not assigned for this brand. Assign RH first, then add BDM/IDM.",
      });
    }

    await validateExecutivesUnderRH({
      RHId: activeAssignment.RHId,
      bdmId,
      idmId,
    });

    const set = { status: "active" };
    if (bdmId !== undefined) set.bdmId = bdmId || null;
    if (idmId !== undefined) set.idmId = idmId || null;

    const updated = await BrandAssigned.findOneAndUpdate(
      { _id: activeAssignment._id },
      { $set: set },
      { new: true }
    ).exec();

    return res.status(200).json({
      success: true,
      message: "Brand assignment updated successfully",
      data: updated,
    });
  } catch (e) {
    console.error("assignBrand error:", e);
    return res.status(500).json({
      success: false,
      message: e?.message || "Internal error",
    });
  }
};

exports.updateBrandAssignment = async (req, res) => {
  try {
    const { assignmentId, status, bdmId } = req.body;

    if (!assignmentId) {
      return res.status(400).json({
        success: false,
        message: "assignmentId is required",
      });
    }

    if (!mongoose.isValidObjectId(assignmentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid assignmentId",
      });
    }

    const assignment = await BrandAssigned.findById(assignmentId);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Assignment not found",
      });
    }

    if (bdmId && !mongoose.isValidObjectId(bdmId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid bdmId",
      });
    }

    if (status && !["active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    const newStatus = status || assignment.status;

    if (newStatus === "active") {
      const existingActive = await BrandAssigned.findOne({
        brandId: assignment.brandId,
        status: "active",
        _id: { $ne: assignmentId },
      });

      if (existingActive) {
        return res.status(409).json({
          success: false,
          message: "Another active assignment already exists for this brand",
        });
      }
    }

    if (status) assignment.status = status;
    if (bdmId) assignment.bdmId = bdmId;

    await assignment.save();

    return res.status(200).json({
      success: true,
      message: "Assignment updated successfully",
      data: assignment,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: e?.message || "Internal error",
    });
  }
};
//

exports.updateBrandAssignmentStatusAndRH = async (req, res) => {
  try {
    const { assignmentId, status, RHId } = req.body;
    const actor = req.admin;

    if (!actor?.adminId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (adminId == "64b8c8f1c9d898001d9e7c3e") {

    }
    if (!assignmentId) {
      return res.status(400).json({
        success: false,
        message: "assignmentId is required",
      });
    }

    if (!mongoose.isValidObjectId(assignmentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid assignmentId",
      });
    }

    const assignment = await BrandAssigned.findById(assignmentId);

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: "Assignment not found",
      });
    }

    if (RHId && !mongoose.isValidObjectId(RHId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid RHId",
      });
    }

    if (status && !["active", "inactive"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    const newStatus = status || assignment.status;

    if (newStatus === "active") {
      const existingActive = await BrandAssigned.findOne({
        brandId: assignment.brandId,
        status: "active",
        _id: { $ne: assignmentId },
      });

      if (existingActive) {
        return res.status(409).json({
          success: false,
          message: "Another active assignment already exists for this brand",
        });
      }
    }

    if (status) assignment.status = status;
    if (RHId) assignment.RHId = RHId;

    await assignment.save();

    return res.status(200).json({
      success: true,
      message: "Assignment updated successfully",
      data: assignment,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: e?.message || "Internal error",
    });
  }
};

exports.listExecutiveAdmin = async (req, res) => {
  try {
    const admin = req.admin;
    const adminId = admin?.adminId;
    const actorRole = String(admin?.role || "").trim().toLowerCase();
    const requestedRole = String(req.query?.role || req.body?.role || "")
      .trim()
      .toLowerCase();
    const requestedRHId = String(req.query?.RHId || req.body?.RHId || "")
      .trim();

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!mongoose.isValidObjectId(adminId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid adminId",
      });
    }

    const filter = { status: "active" };

    if (requestedRole) {
      if (![ROLES.BME, ROLES.IME, ROLES.SDR].includes(requestedRole)) {
        return res.status(400).json({
          success: false,
          message: "role must be either bme, ime, or sdr",
        });
      }
      filter.role = requestedRole;
    } else {
      filter.role = { $in: [ROLES.BME, ROLES.IME, ROLES.SDR] };
    }

    // Revenue Head: always only own team
    if (actorRole === ROLES.REVENUE_HEAD) {
      filter.parentAdmin = adminId;
    }

    // Super Admin: all by default
    // Other roles / future usage: allow optional RHId filter
    if (actorRole !== ROLES.REVENUE_HEAD && requestedRHId) {
      if (!mongoose.isValidObjectId(requestedRHId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid RHId",
        });
      }

      filter.parentAdmin = requestedRHId;
    }

    const executives = await AdminModel.find(filter)
      .select("-passwordHash -inviteTokenHash")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: executives.length,
      data: executives,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: e?.message || "Internal error",
    });
  }
};

exports.rmlist = async (req, res) => {
  try {
    const rms = await AdminModel.find({ role: "revenue_head", status: "active" })
      .select("-passwordHash -inviteTokenHash")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: rms.length,
      data: rms,
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: e?.message || "Internal error",
    });
  }
}

exports.allocateBrand = async (req, res) => {
  try {
    const admin = req.admin;
    const adminId = admin?.adminId;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: adminId not found",
      });
    }

    const adminIdStr = String(adminId);

    // support both string and ObjectId storage in DB
    const isObjId = mongoose.Types.ObjectId.isValid(adminIdStr);
    const adminObjId = isObjId ? new mongoose.Types.ObjectId(adminIdStr) : null;

    const orConditions = [
      { bdmId: adminIdStr },
      { idmId: adminIdStr },
    ];
    if (adminObjId) {
      orConditions.push({ bdmId: adminObjId }, { idmId: adminObjId });
    }

    const allocations = await BrandAssigned.find({
      status: "active",
      $or: orConditions,
    })
      .populate("brandId") // if brandId is ref; otherwise it will just return brandId as stored
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: allocations.length
        ? "Allocated brands fetched successfully"
        : "No brands allocated to this admin",
      count: allocations.length,
      data: allocations,
    });
  } catch (e) {
    console.error("allocateBrand error:", e);
    return res.status(500).json({
      success: false,
      message: e?.message || "Internal server error",
    });
  }
};

async function enrichCampaignsWithAssignments(campaignDocs = []) {
  if (!Array.isArray(campaignDocs) || !campaignDocs.length) return [];

  const brandIds = [
    ...new Set(
      campaignDocs
        .map((item) => String(item?.brandId || ""))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  if (!brandIds.length) {
    return campaignDocs.map((item) => ({
      ...item,
      assignedRh: "",
      assignedBme: "",
      assignedIme: "",
      RHId: null,
      bdmId: null,
      idmId: null,
      assignmentId: null,
      assignmentStatus: null,
    }));
  }

  const activeAssignments = await BrandAssigned.find({
    brandId: { $in: brandIds },
    status: "active",
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  const assignmentMap = new Map();
  for (const assignment of activeAssignments) {
    const key = String(assignment.brandId);
    if (!assignmentMap.has(key)) assignmentMap.set(key, assignment);
  }

  const missingIds = brandIds.filter((id) => !assignmentMap.has(String(id)));
  if (missingIds.length) {
    const fallbackAssignments = await BrandAssigned.find({
      brandId: { $in: missingIds },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    for (const assignment of fallbackAssignments) {
      const key = String(assignment.brandId);
      if (!assignmentMap.has(key)) assignmentMap.set(key, assignment);
    }
  }

  const assigneeIds = [
    ...new Set(
      [...assignmentMap.values()]
        .flatMap((assignment) => [
          assignment?.RHId,
          assignment?.bdmId,
          assignment?.idmId,
        ])
        .filter(Boolean)
        .map((id) => String(id))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const assignees = assigneeIds.length
    ? await AdminModel.find({ _id: { $in: assigneeIds } })
      .select("_id name email role")
      .lean()
    : [];

  const assigneeMap = new Map();
  assignees.forEach((admin) => {
    assigneeMap.set(
      String(admin._id),
      admin.name || admin.email || ""
    );
  });

  return campaignDocs.map((campaign) => {
    const assignment = assignmentMap.get(String(campaign.brandId));

    const assignedRh = assignment?.RHId
      ? assigneeMap.get(String(assignment.RHId)) || ""
      : "";
    const assignedBme = assignment?.bdmId
      ? assigneeMap.get(String(assignment.bdmId)) || ""
      : "";
    const assignedIme = assignment?.idmId
      ? assigneeMap.get(String(assignment.idmId)) || ""
      : "";

    return {
      ...campaign,
      assignedRh,
      assignedBme,
      assignedIme,

      RHId: assignment?.RHId || null,
      bdmId: assignment?.bdmId || null,
      idmId: assignment?.idmId || null,
      assignmentId: assignment?._id || null,
      assignmentStatus: assignment?.status || null,
    };
  });
}

exports.listCampaignsForAdmin = async (req, res) => {
  try {
    const actor = req.admin;

    if (!actor?.adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const visibilityFilter = await buildCampaignVisibilityFilter(actor);

    const filter = {
      ...visibilityFilter,
      "createdBy.role": "admin",
      isActive: 1,
    };

    const campaigns = await Campaign.find(filter)
      .select({
        _id: 1,
        brandId: 1,
        brandName: 1,
        campaignTitle: 1,
        campaignType: 1,
        campaignCategory: 1,
        campaignSubcategory: 1,
        campaignBudget: 1,
        budget: 1,
        influencerBudget: 1,
        platformSelection: 1,
        targetCountry: 1,
        numberOfInfluencers: 1,
        paymentType: 1,
        status: 1,
        publishStatus: 1,
        scheduledAt: 1,
        startAt: 1,
        endAt: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .sort({ createdAt: -1 })
      .lean();

    const enrichedCampaigns = await enrichCampaignsWithAssignments(campaigns);

    return res.status(200).json({
      success: true,
      count: enrichedCampaigns.length,
      data: enrichedCampaigns,
    });
  } catch (e) {
    console.error("listCampaignsForAdmin error:", e);
    return res.status(500).json({
      success: false,
      message: e?.message || "Internal error",
    });
  }
};

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const DEFAULT_PROVIDER = (process.env.BRAND_RESEARCH_PROVIDER || "both").toLowerCase();

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };

const resolveProperties = {
  matched: { type: "boolean" },
  brand_name: nullableString,
  brand_alias: nullableString,
  domain: nullableString,
  website_url: nullableString,
  logo_url: nullableString,
  industry: nullableString,
  headquarters_country: nullableString,
  confidence: { type: "number" },
  reason: nullableString,
};

const resolveJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: resolveProperties,
  required: Object.keys(resolveProperties),
};

const brandProperties = {
  brand_name: { type: "string" },
  brand_alias: { type: "string" },
  domain: { type: "string" },
  website_url: { type: "string" },
  logo_url: { type: "string" },
  brand_description: { type: "string" },
  industry: { type: "string" },
  sub_industry: { type: "string" },
  brand_category: { type: "string" },
  company_type: { type: "string" },
  business_model: { type: "string" },
  founded_year: { type: "string" },
  headquarters_city: { type: "string" },
  headquarters_state: { type: "string" },
  headquarters_country: { type: "string" },
  operating_regions: { type: "string" },

  last_year_revenue: { type: "string" },
  last_year_revenue_year: { type: "string" },
  employee_count: { type: "string" },
  company_size_category: { type: "string" },
  annual_revenue: { type: "string" },
  revenue_range: { type: "string" },
  funding_total: { type: "string" },
  funding_stage: { type: "string" },
  valuation: { type: "string" },
  profitability_status: { type: "string" },
  growth_rate: { type: "string" },
  brand_maturity: { type: "string" },

  instagram_url: { type: "string" },
  instagram_followers: { type: "string" },
  instagram_engagement_rate: { type: "string" },
  youtube_url: { type: "string" },
  youtube_subscribers: { type: "string" },
  linkedin_url: { type: "string" },
  facebook_url: { type: "string" },
  twitter_url: { type: "string" },
  website_traffic_monthly: { type: "string" },
  app_downloads: { type: "string" },

  primary_contact_name: { type: "string" },
  contact_designation: { type: "string" },
  contact_email: { type: "string" },
  contact_phone: { type: "string" },
  linkedin_contact_url: { type: "string" },
  contact_department: { type: "string" },

  about_page_url: { type: "string" },
  contact_page_url: { type: "string" },
  general_email: { type: "string" },
  sales_email: { type: "string" },
  support_email: { type: "string" },
  public_phone: { type: "string" },
  public_address: { type: "string" },
};

const brandJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: brandProperties,
  required: Object.keys(brandProperties),
};

function hasValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function normalizeText(value) {
  if (!hasValue(value)) return null;
  return String(value).trim();
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const cleaned = String(value).replace(/[,$\s]/g, "").replace(/^USD/i, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function formatNumber(value) {
  const num = normalizeNumber(value);
  if (num === null) return null;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(num);
}

function formatUsd(value) {
  const num = normalizeNumber(value);
  if (num === null) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num);
}

function ensureEndsWithPeriod(text) {
  const value = normalizeText(text);
  if (!value) return null;
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function prefer(primary, fallback) {
  return hasValue(primary) ? primary : hasValue(fallback) ? fallback : null;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeWebsiteLikeInput(value) {
  const text = normalizeText(value);
  if (!text) return null;

  try {
    if (/^https?:\/\//i.test(text)) {
      const parsed = new URL(text);
      return parsed.origin;
    }

    if (!text.includes(" ") && text.includes(".")) {
      const parsed = new URL(`https://${text}`);
      return parsed.origin;
    }
  } catch {
    return null;
  }

  return null;
}

function cleanJsonText(text) {
  if (!text) return "";
  return String(text)
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseJsonText(text, label) {
  const cleaned = cleanJsonText(text);
  if (!cleaned) {
    throw new Error(`${label}: empty response text`);
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`${label}: invalid JSON returned - ${error.message}`);
  }
}

function mergeStructuredObjects(primary = {}, fallback = {}, keys = []) {
  const output = {};
  for (const key of keys) {
    output[key] = hasValue(primary[key])
      ? primary[key]
      : hasValue(fallback[key])
      ? fallback[key]
      : "";
  }
  return output;
}

function unknownNarrative(field) {
  const defaults = {
    brand_name: "The official brand name could not be clearly identified from the currently available public information.",
    brand_alias: "No widely used alternate brand name was clearly identified from the currently available public information.",
    domain: "The root domain could not be clearly identified from the currently available public information.",
    website_url: "The official website could not be clearly identified from the currently available public information.",
    logo_url: "A public logo URL could not be clearly identified from the currently available public information.",
    brand_description:
      "This company appears to be an emerging brand with a limited but developing public footprint. Based on the available information, the business seems to operate in a defined niche and is building its public identity through its website, product messaging, and early market presence. While a full official company overview was not clearly available, the brand appears to focus on a specific audience and value proposition, with messaging centered on solving a practical consumer or business problem. The company’s digital presence suggests that it is still refining its public positioning, but the available signals indicate that it is actively working on brand visibility, customer acquisition, and product communication. The business may still be in an early or growth-oriented phase, which can explain the limited depth of publicly available commercial details such as financial history, valuation disclosures, leadership biographies, or broad operating data. Even so, the existing website and related public references suggest a legitimate commercial effort with a clear intent to build trust, communicate product relevance, and expand reach over time. As the company matures, more complete public information is likely to emerge across official pages, business listings, professional networks, and customer-facing channels.",
    industry: "The exact industry could not be clearly identified from the currently available public information.",
    sub_industry: "The specific sub-industry could not be clearly identified from the currently available public information.",
    brand_category: "The exact brand category could not be clearly identified from the currently available public information.",
    company_type: "The company type could not be clearly identified from the currently available public information.",
    business_model: "The business model could not be clearly identified from the currently available public information.",
    founded_year: "The company’s founding year could not be clearly identified from the currently available public information.",
    headquarters_city: "The headquarters city could not be clearly identified from the currently available public information.",
    headquarters_state: "The headquarters state or region could not be clearly identified from the currently available public information.",
    headquarters_country: "The headquarters country could not be clearly identified from the currently available public information.",
    operating_regions: "The company’s operating regions could not be clearly identified from the currently available public information.",
    last_year_revenue: "Last year’s revenue could not be clearly identified from the currently available public information.",
    last_year_revenue_year: "The specific year tied to the most recent revenue figure could not be clearly identified from the currently available public information.",
    employee_count: "The company’s employee count could not be clearly identified from the currently available public information.",
    company_size_category: "The company’s size category could not be clearly identified from the currently available public information.",
    annual_revenue: "The company’s annual revenue could not be clearly identified from the currently available public information.",
    revenue_range: "The company’s revenue range could not be clearly identified from the currently available public information.",
    funding_total: "The company’s total funding could not be clearly identified from the currently available public information.",
    funding_stage: "The company’s funding stage could not be clearly identified from the currently available public information.",
    valuation: "The company’s valuation could not be clearly identified from the currently available public information.",
    profitability_status: "The company’s profitability status could not be clearly identified from the currently available public information.",
    growth_rate: "The company’s growth rate could not be clearly identified from the currently available public information.",
    brand_maturity: "The brand’s maturity stage could not be clearly identified from the currently available public information.",
    instagram_url: "An official Instagram profile could not be clearly identified from the currently available public information.",
    instagram_followers: "The Instagram follower count could not be clearly identified from the currently available public information.",
    instagram_engagement_rate: "The Instagram engagement rate could not be clearly identified from the currently available public information.",
    youtube_url: "An official YouTube channel could not be clearly identified from the currently available public information.",
    youtube_subscribers: "The YouTube subscriber count could not be clearly identified from the currently available public information.",
    linkedin_url: "An official LinkedIn page could not be clearly identified from the currently available public information.",
    facebook_url: "An official Facebook page could not be clearly identified from the currently available public information.",
    twitter_url: "An official X or Twitter profile could not be clearly identified from the currently available public information.",
    website_traffic_monthly: "Monthly website traffic could not be clearly identified from the currently available public information.",
    app_downloads: "App download volume could not be clearly identified from the currently available public information.",
    primary_contact_name: "A primary public contact person could not be clearly identified from the currently available public information.",
    contact_designation: "A public contact designation could not be clearly identified from the currently available public information.",
    contact_email: "A publicly listed contact email could not be clearly identified from the currently available public information.",
    contact_phone: "A publicly listed contact phone number could not be clearly identified from the currently available public information.",
    linkedin_contact_url: "A public LinkedIn profile for a primary contact could not be clearly identified from the currently available public information.",
    contact_department: "A specific contact department could not be clearly identified from the currently available public information.",
    about_page_url: "A dedicated about page could not be clearly identified from the currently available public information.",
    contact_page_url: "A dedicated contact page could not be clearly identified from the currently available public information.",
    general_email: "A general public email address could not be clearly identified from the currently available public information.",
    sales_email: "A public sales email address could not be clearly identified from the currently available public information.",
    support_email: "A public support email address could not be clearly identified from the currently available public information.",
    public_phone: "A public phone number could not be clearly identified from the currently available public information.",
    public_address: "A public business address could not be clearly identified from the currently available public information.",
  };

  return defaults[field] || "This field could not be clearly identified from the currently available public information.";
}

function wrapNarrative(field, value) {
  const text = normalizeText(value);
  if (!text) return unknownNarrative(field);

  if (text.length > 24 && /[.!?]$/.test(text)) {
    return text;
  }

  switch (field) {
    case "brand_name":
      return ensureEndsWithPeriod(`The official brand name of the company is ${text}`);
    case "brand_alias":
      return ensureEndsWithPeriod(`The brand is also referred to as ${text}`);
    case "domain":
      return ensureEndsWithPeriod(`The company’s root domain is ${text}`);
    case "website_url":
      return ensureEndsWithPeriod(`The official website of the company is ${text}`);
    case "logo_url":
      return ensureEndsWithPeriod(`A public logo or favicon URL associated with the company is ${text}`);
    case "industry":
      return ensureEndsWithPeriod(`The company appears to operate in the ${text} industry`);
    case "sub_industry":
      return ensureEndsWithPeriod(`The company appears to be positioned in the ${text} segment`);
    case "brand_category":
      return ensureEndsWithPeriod(`The brand category appears to be ${text}`);
    case "company_type":
      return ensureEndsWithPeriod(`The company appears to be a ${text}`);
    case "business_model":
      return ensureEndsWithPeriod(`The business model appears to be ${text}`);
    case "founded_year":
      return ensureEndsWithPeriod(`The company appears to have been founded in ${text}`);
    case "headquarters_city":
      return ensureEndsWithPeriod(`The headquarters city appears to be ${text}`);
    case "headquarters_state":
      return ensureEndsWithPeriod(`The headquarters state or region appears to be ${text}`);
    case "headquarters_country":
      return ensureEndsWithPeriod(`The headquarters country appears to be ${text}`);
    case "operating_regions":
      return ensureEndsWithPeriod(`The company appears to operate across ${text}`);
    case "annual_revenue":
      return ensureEndsWithPeriod(`The company’s annual revenue is estimated at ${text}`);
    case "last_year_revenue":
      return ensureEndsWithPeriod(`Last year’s revenue was approximately ${text}`);
    case "last_year_revenue_year":
      return ensureEndsWithPeriod(`The most recent revenue reference appears to correspond to the year ${text}`);
    case "employee_count":
      return ensureEndsWithPeriod(`The company appears to have approximately ${text} employees`);
    case "company_size_category":
      return ensureEndsWithPeriod(`The company appears to fall into the ${text} size category`);
    case "revenue_range":
      return ensureEndsWithPeriod(`The estimated revenue range appears to be ${text}`);
    case "funding_total":
      return ensureEndsWithPeriod(`The company’s total funding is estimated at ${text}`);
    case "funding_stage":
      return ensureEndsWithPeriod(`The company appears to be in the ${text} funding stage`);
    case "valuation":
      return ensureEndsWithPeriod(`The company’s valuation is estimated at ${text}`);
    case "profitability_status":
      return ensureEndsWithPeriod(`The company’s profitability status appears to be ${text}`);
    case "growth_rate":
      return ensureEndsWithPeriod(`The company’s growth rate appears to be ${text}`);
    case "brand_maturity":
      return ensureEndsWithPeriod(`The brand appears to be in the ${text} stage`);
    case "instagram_url":
      return ensureEndsWithPeriod(`The company’s Instagram profile appears to be ${text}`);
    case "instagram_followers":
      return ensureEndsWithPeriod(`The Instagram profile appears to have approximately ${text} followers`);
    case "instagram_engagement_rate":
      return ensureEndsWithPeriod(`The Instagram engagement rate appears to be around ${text}`);
    case "youtube_url":
      return ensureEndsWithPeriod(`The company’s YouTube channel appears to be ${text}`);
    case "youtube_subscribers":
      return ensureEndsWithPeriod(`The YouTube channel appears to have approximately ${text} subscribers`);
    case "linkedin_url":
      return ensureEndsWithPeriod(`The company’s LinkedIn page appears to be ${text}`);
    case "facebook_url":
      return ensureEndsWithPeriod(`The company’s Facebook page appears to be ${text}`);
    case "twitter_url":
      return ensureEndsWithPeriod(`The company’s X or Twitter profile appears to be ${text}`);
    case "website_traffic_monthly":
      return ensureEndsWithPeriod(`Monthly website traffic appears to be approximately ${text}`);
    case "app_downloads":
      return ensureEndsWithPeriod(`The company’s app appears to have approximately ${text} downloads`);
    case "primary_contact_name":
      return ensureEndsWithPeriod(`A primary public contact associated with the company appears to be ${text}`);
    case "contact_designation":
      return ensureEndsWithPeriod(`The public contact designation appears to be ${text}`);
    case "contact_email":
      return ensureEndsWithPeriod(`A publicly listed contact email associated with the company is ${text}`);
    case "contact_phone":
      return ensureEndsWithPeriod(`A publicly listed contact phone number associated with the company is ${text}`);
    case "linkedin_contact_url":
      return ensureEndsWithPeriod(`A LinkedIn profile associated with the primary contact appears to be ${text}`);
    case "contact_department":
      return ensureEndsWithPeriod(`The most relevant public-facing contact department appears to be ${text}`);
    case "about_page_url":
      return ensureEndsWithPeriod(`The company’s about page appears to be ${text}`);
    case "contact_page_url":
      return ensureEndsWithPeriod(`The company’s contact page appears to be ${text}`);
    case "general_email":
      return ensureEndsWithPeriod(`A general public email associated with the company is ${text}`);
    case "sales_email":
      return ensureEndsWithPeriod(`A sales email associated with the company is ${text}`);
    case "support_email":
      return ensureEndsWithPeriod(`A support email associated with the company is ${text}`);
    case "public_phone":
      return ensureEndsWithPeriod(`A public phone number associated with the company is ${text}`);
    case "public_address":
      return ensureEndsWithPeriod(`A public business address associated with the company is ${text}`);
    default:
      return ensureEndsWithPeriod(text);
  }
}

function buildFallbackLongDescription(aiData, resolved, scraped, cleanBrandName) {
  const name = normalizeText(aiData.brand_name) || normalizeText(resolved.brand_name) || cleanBrandName;
  const industry = normalizeText(aiData.industry) || normalizeText(resolved.industry) || "its respective market segment";
  const subIndustry = normalizeText(aiData.sub_industry) || "a focused niche within its broader category";
  const companyType = normalizeText(aiData.company_type) || "a private company";
  const businessModel = normalizeText(aiData.business_model) || "a commercially driven operating model";
  const website = normalizeText(aiData.website_url) || normalizeText(scraped?.website_url) || normalizeText(resolved.website_url) || "its official website";
  const hqCity = normalizeText(aiData.headquarters_city) || "an undisclosed city";
  const hqCountry = normalizeText(aiData.headquarters_country) || normalizeText(resolved.headquarters_country) || "an undisclosed country";
  const foundedYear = normalizeText(aiData.founded_year) || "an undisclosed year";
  const operatingRegions = normalizeText(aiData.operating_regions) || "its target operating markets";
  const productFocus = normalizeText(aiData.brand_category) || "its main category";
  const maturity = normalizeText(aiData.brand_maturity) || "an early-to-growth stage";
  const revenueRange = normalizeText(aiData.revenue_range) || "a developing commercial range";
  const fundingStage = normalizeText(aiData.funding_stage) || "an undisclosed funding stage";
  const contactEmail =
    normalizeText(scraped?.general_email) ||
    normalizeText(scraped?.sales_email) ||
    normalizeText(scraped?.support_email) ||
    "no clearly listed public email";
  const phone = normalizeText(scraped?.public_phone) || "no clearly listed public phone number";

  const paragraph = `${name} appears to be ${companyType} operating in ${industry}, with a more specific focus on ${subIndustry}. Based on the currently available public information, the brand is positioned within ${productFocus} and seems to use ${businessModel} to reach its target audience. The company appears to have a public presence centered around ${website}, where its messaging, positioning, and customer-facing information are presented. Available signals suggest that the business may have been founded around ${foundedYear} and is associated with ${hqCity}, ${hqCountry}, although the depth of public corporate disclosure may still be limited. From a market perspective, the company appears to serve ${operatingRegions}, indicating that its commercial ambition extends beyond a single narrow geography or customer segment.

At a broader level, the brand seems to be in ${maturity}, which is consistent with the level of visibility found across its website, public profiles, and commercial references. The available information suggests that the company is still building out its presence, reputation, and measurable business footprint, even if every commercial metric is not explicitly published. Its financial profile appears to align with ${revenueRange}, while the funding outlook appears most consistent with ${fundingStage}. These indicators should be understood as best-effort public interpretations rather than audited disclosures. In terms of accessibility, the company’s contact presence appears limited but usable, with ${contactEmail} and ${phone} representing the clearest public-facing communication points identified from available material. Overall, ${name} presents itself as a focused and developing brand that is working to strengthen market credibility, product clarity, and long-term brand visibility through its digital presence and public-facing messaging.`;

  return ensureEndsWithPeriod(paragraph);
}

function fillSocialFromScrape(aiData = {}, scraped = {}) {
  return {
    instagram_url: prefer(aiData.instagram_url, scraped?.instagram_url),
    youtube_url: prefer(aiData.youtube_url, scraped?.youtube_url),
    linkedin_url: prefer(aiData.linkedin_url, scraped?.linkedin_url),
    facebook_url: prefer(aiData.facebook_url, scraped?.facebook_url),
    twitter_url: prefer(aiData.twitter_url, scraped?.twitter_url),
  };
}

function resolveEffectiveProvider(requestedProvider) {
  const requested = (requestedProvider || DEFAULT_PROVIDER || "both").toLowerCase();
  const hasOpenAI = Boolean(openai);
  const hasGemini = Boolean(gemini);

  if (!hasOpenAI && !hasGemini) return null;

  if (requested === "both") {
    if (hasOpenAI && hasGemini) return "both";
    if (hasOpenAI) return "openai";
    if (hasGemini) return "gemini";
  }

  if (requested === "openai") {
    if (hasOpenAI) return "openai";
    if (hasGemini) return "gemini";
  }

  if (requested === "gemini") {
    if (hasGemini) return "gemini";
    if (hasOpenAI) return "openai";
  }

  if (hasOpenAI && hasGemini) return "both";
  if (hasOpenAI) return "openai";
  return "gemini";
}

function buildResolvePrompt(brandName, options = {}) {
  const { withSearch = false, websiteHint = null } = options;

  return `
You are resolving the official identity of a brand from only its brand name.

Brand name: "${brandName}"
Official website hint from input: ${websiteHint || "null"}

Instructions:
1. ${withSearch ? "Use live web search and prefer official/public business sources." : "Use the brand hint, scraped context if any, and model knowledge."}
2. Identify the most likely official brand/company.
3. Prefer official website/domain and official brand pages.
4. If multiple brands share the same name, choose the most globally recognized or most likely commercial brand.
5. Do not leave fields empty if a reasonable best-fit answer exists.
6. matched should be true whenever there is a plausible brand match.
7. confidence must be between 0 and 1.
8. domain must be root domain only.
9. website_url should be official homepage if possible.
10. Never return explanatory text outside JSON.

Return only JSON.
`;
}

function buildProfilePrompt(brandName, resolved, scraped, options = {}) {
  const { withSearch = false } = options;

  return `
You are a brand research assistant.

Original input: "${brandName}"

Resolved identity:
- matched: ${resolved?.matched === true ? "true" : "false"}
- brand_name: ${resolved?.brand_name || "null"}
- domain: ${resolved?.domain || "null"}
- website_url: ${resolved?.website_url || "null"}
- industry: ${resolved?.industry || "null"}
- headquarters_country: ${resolved?.headquarters_country || "null"}

Public website evidence:
- about_page_url: ${scraped?.about_page_url || "null"}
- contact_page_url: ${scraped?.contact_page_url || "null"}
- scraped_text:
"""${scraped?.raw_website_text || ""}"""

Instructions:
1. ${withSearch ? "Use live web search plus scraped website text." : "Use provided identity, scraped website text, and model knowledge."}
2. Every field in the output must be a STRING written as a natural-language sentence or short descriptive paragraph.
3. Do not return raw numbers, raw arrays, booleans, or plain values without context.
4. Do not return null, NA, unknown, or blank strings. If something is not clearly available, write a sentence explaining that it could not be clearly identified from public information.
5. brand_description must be a strong descriptive overview of about 300 to 400 words.
6. annual_revenue, last_year_revenue, funding_total, and valuation must be written as descriptive USD strings with a dollar symbol, such as: "Last year's revenue was approximately $500,000, reflecting an estimated 20% year-over-year increase."
7. If public sources mention INR, EUR, CNY, or another currency, convert to USD first before writing the sentence.
8. operating_regions must be one descriptive sentence, not an array.
9. contact_email, support_email, sales_email, general_email, contact_phone, and public_phone must also be descriptive sentences, not bare emails or phone numbers.
10. website_url, domain, social URLs, and page URLs must also be descriptive strings, such as "The official website of the company is https://example.com/."
11. employee_count, app_downloads, website_traffic_monthly, followers, subscribers, growth_rate, and founded_year must be written as descriptive sentence-style strings.
12. Prefer official sources first, but you may use reputable public business information for best-effort completion.
13. Return only valid JSON matching the schema.

Return only JSON.
`;
}

async function resolveBrandIdentityWithOpenAI(brandName, websiteHint = null) {
  if (!openai) throw new Error("OPENAI_API_KEY is not configured");

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    tools: [{ type: "web_search_preview", search_context_size: "high" }],
    input: [
      {
        role: "system",
        content: "You resolve official brand identity and return strict JSON.",
      },
      {
        role: "user",
        content: buildResolvePrompt(brandName, { withSearch: true, websiteHint }),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "brand_resolution",
        schema: resolveJsonSchema,
        strict: true,
      },
    },
    max_output_tokens: 1600,
  });

  const raw = response.output_text || "";
  return {
    provider: "openai",
    parsed: parseJsonText(raw, "OpenAI resolve"),
    raw,
  };
}

async function resolveBrandIdentityWithGemini(brandName, websiteHint = null) {
  if (!gemini) throw new Error("GEMINI_API_KEY is not configured");

  const response = await gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildResolvePrompt(brandName, { withSearch: false, websiteHint }),
    config: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseJsonSchema: resolveJsonSchema,
    },
  });

  const raw = response.text || "";
  return {
    provider: "gemini",
    parsed: parseJsonText(raw, "Gemini resolve"),
    raw,
  };
}

function mergeResolvedResults(openaiResolved, geminiResolved, cleanBrandName, websiteHint = null) {
  const merged = mergeStructuredObjects(
    openaiResolved || {},
    geminiResolved || {},
    Object.keys(resolveProperties)
  );

  const fallbackBrandName =
    normalizeText(merged.brand_name) ||
    normalizeText(openaiResolved?.brand_name) ||
    normalizeText(geminiResolved?.brand_name) ||
    cleanBrandName;

  const fallbackWebsite =
    normalizeText(merged.website_url) ||
    normalizeText(openaiResolved?.website_url) ||
    normalizeText(geminiResolved?.website_url) ||
    websiteHint ||
    null;

  const fallbackDomain =
    normalizeText(merged.domain) ||
    normalizeText(openaiResolved?.domain) ||
    normalizeText(geminiResolved?.domain) ||
    extractDomain(fallbackWebsite || "") ||
    null;

  return {
    matched: true,
    brand_name: fallbackBrandName,
    brand_alias: normalizeText(merged.brand_alias),
    domain: fallbackDomain,
    website_url: fallbackWebsite,
    logo_url: normalizeText(merged.logo_url),
    industry: normalizeText(merged.industry),
    headquarters_country: normalizeText(merged.headquarters_country),
    confidence: Math.max(
      normalizeNumber(openaiResolved?.confidence) || 0,
      normalizeNumber(geminiResolved?.confidence) || 0,
      0.7
    ),
    reason:
      normalizeText(merged.reason) ||
      "Best-fit brand identity resolved from model and public web signals.",
  };
}

async function resolveBrandIdentity(brandName, provider, websiteHint = null) {
  const jobs = [];

  if (provider === "openai" || provider === "both") {
    jobs.push(
      resolveBrandIdentityWithOpenAI(brandName, websiteHint)
        .then((result) => ({ status: "fulfilled", provider: "openai", result }))
        .catch((error) => ({ status: "rejected", provider: "openai", error }))
    );
  }

  if (provider === "gemini" || provider === "both") {
    jobs.push(
      resolveBrandIdentityWithGemini(brandName, websiteHint)
        .then((result) => ({ status: "fulfilled", provider: "gemini", result }))
        .catch((error) => ({ status: "rejected", provider: "gemini", error }))
    );
  }

  const settled = await Promise.all(jobs);

  const openaiSuccess = settled.find(
    (x) => x.provider === "openai" && x.status === "fulfilled"
  )?.result;

  const geminiSuccess = settled.find(
    (x) => x.provider === "gemini" && x.status === "fulfilled"
  )?.result;

  if (!openaiSuccess && !geminiSuccess) {
    const reasons = settled
      .map((x) => `${x.provider}: ${x.error?.message || "unknown error"}`)
      .join(" | ");
    throw new Error(`Brand resolution failed. ${reasons}`);
  }

  return {
    parsed: mergeResolvedResults(
      openaiSuccess?.parsed,
      geminiSuccess?.parsed,
      brandName,
      websiteHint
    ),
    raw: {
      openai: openaiSuccess?.raw || null,
      gemini: geminiSuccess?.raw || null,
      errors: settled
        .filter((x) => x.status === "rejected")
        .map((x) => ({
          provider: x.provider,
          message: x.error?.message || "unknown error",
        })),
    },
  };
}

async function buildBrandProfileWithOpenAI(brandName, resolved, scraped) {
  if (!openai) throw new Error("OPENAI_API_KEY is not configured");

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    tools: [{ type: "web_search_preview", search_context_size: "high" }],
    input: [
      {
        role: "system",
        content:
          "You research brands and return schema-matching JSON with narrative string fields.",
      },
      {
        role: "user",
        content: buildProfilePrompt(brandName, resolved, scraped, { withSearch: true }),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "brand_profile",
        schema: brandJsonSchema,
        strict: true,
      },
    },
    max_output_tokens: 5200,
  });

  const raw = response.output_text || "";
  return {
    provider: "openai",
    parsed: parseJsonText(raw, "OpenAI profile"),
    raw,
  };
}

async function buildBrandProfileWithGemini(brandName, resolved, scraped) {
  if (!gemini) throw new Error("GEMINI_API_KEY is not configured");

  const response = await gemini.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildProfilePrompt(brandName, resolved, scraped, { withSearch: false }),
    config: {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseJsonSchema: brandJsonSchema,
    },
  });

  const raw = response.text || "";
  return {
    provider: "gemini",
    parsed: parseJsonText(raw, "Gemini profile"),
    raw,
  };
}

async function buildBrandProfile(brandName, resolved, scraped, provider) {
  const jobs = [];

  if (provider === "openai" || provider === "both") {
    jobs.push(
      buildBrandProfileWithOpenAI(brandName, resolved, scraped)
        .then((result) => ({ status: "fulfilled", provider: "openai", result }))
        .catch((error) => ({ status: "rejected", provider: "openai", error }))
    );
  }

  if (provider === "gemini" || provider === "both") {
    jobs.push(
      buildBrandProfileWithGemini(brandName, resolved, scraped)
        .then((result) => ({ status: "fulfilled", provider: "gemini", result }))
        .catch((error) => ({ status: "rejected", provider: "gemini", error }))
    );
  }

  const settled = await Promise.all(jobs);

  const openaiSuccess = settled.find(
    (x) => x.provider === "openai" && x.status === "fulfilled"
  )?.result;

  const geminiSuccess = settled.find(
    (x) => x.provider === "gemini" && x.status === "fulfilled"
  )?.result;

  if (!openaiSuccess && !geminiSuccess) {
    const reasons = settled
      .map((x) => `${x.provider}: ${x.error?.message || "unknown error"}`)
      .join(" | ");
    throw new Error(`Brand profile generation failed. ${reasons}`);
  }

  return {
    parsed: mergeAiAndScraped(
      mergeStructuredObjects(
        openaiSuccess?.parsed || {},
        geminiSuccess?.parsed || {},
        Object.keys(brandProperties)
      ),
      scraped,
      resolved,
      brandName
    ),
    raw: {
      openai: openaiSuccess?.raw || null,
      gemini: geminiSuccess?.raw || null,
      errors: settled
        .filter((x) => x.status === "rejected")
        .map((x) => ({
          provider: x.provider,
          message: x.error?.message || "unknown error",
        })),
    },
  };
}

function mergeAiAndScraped(aiData, scraped, resolved, cleanBrandName) {
  const socials = fillSocialFromScrape(aiData, scraped);

  const annualRevenueRaw =
    normalizeText(aiData.annual_revenue) ||
    (normalizeNumber(aiData.annual_revenue) !== null
      ? `Annual revenue is estimated at ${formatUsd(aiData.annual_revenue)}.`
      : null);

  const lastYearRevenueRaw =
    normalizeText(aiData.last_year_revenue) ||
    (normalizeNumber(aiData.last_year_revenue) !== null
      ? `Last year's revenue was approximately ${formatUsd(aiData.last_year_revenue)}.`
      : null);

  const fundingTotalRaw =
    normalizeText(aiData.funding_total) ||
    (normalizeNumber(aiData.funding_total) !== null
      ? `Total funding is estimated at ${formatUsd(aiData.funding_total)}.`
      : null);

  const valuationRaw =
    normalizeText(aiData.valuation) ||
    (normalizeNumber(aiData.valuation) !== null
      ? `The company valuation is estimated at ${formatUsd(aiData.valuation)}.`
      : null);

  const employeeCountRaw =
    normalizeText(aiData.employee_count) ||
    (formatNumber(aiData.employee_count)
      ? `The company appears to have approximately ${formatNumber(aiData.employee_count)} employees.`
      : null);

  const appDownloadsRaw =
    normalizeText(aiData.app_downloads) ||
    (formatNumber(aiData.app_downloads)
      ? `The company’s app appears to have approximately ${formatNumber(aiData.app_downloads)} downloads.`
      : null);

  const websiteTrafficRaw =
    normalizeText(aiData.website_traffic_monthly) ||
    (formatNumber(aiData.website_traffic_monthly)
      ? `Monthly website traffic appears to be approximately ${formatNumber(aiData.website_traffic_monthly)} visits.`
      : null);

  const instagramFollowersRaw =
    normalizeText(aiData.instagram_followers) ||
    (formatNumber(aiData.instagram_followers)
      ? `The Instagram profile appears to have approximately ${formatNumber(aiData.instagram_followers)} followers.`
      : null);

  const youtubeSubscribersRaw =
    normalizeText(aiData.youtube_subscribers) ||
    (formatNumber(aiData.youtube_subscribers)
      ? `The YouTube channel appears to have approximately ${formatNumber(aiData.youtube_subscribers)} subscribers.`
      : null);

  const longDescription =
    normalizeText(aiData.brand_description) ||
    buildFallbackLongDescription(aiData, resolved, scraped, cleanBrandName);

  return {
    brand_name: wrapNarrative(
      "brand_name",
      prefer(aiData.brand_name, resolved.brand_name || cleanBrandName)
    ),
    brand_alias: wrapNarrative("brand_alias", prefer(aiData.brand_alias, resolved.brand_alias)),
    domain: wrapNarrative(
      "domain",
      prefer(aiData.domain, resolved.domain) ||
        extractDomain(scraped?.website_url || resolved?.website_url || "")
    ),
    website_url: wrapNarrative(
      "website_url",
      prefer(aiData.website_url, scraped?.website_url || resolved?.website_url)
    ),
    logo_url: wrapNarrative("logo_url", prefer(aiData.logo_url, resolved.logo_url)),
    brand_description: ensureEndsWithPeriod(longDescription),

    industry: wrapNarrative("industry", prefer(aiData.industry, resolved.industry)),
    sub_industry: wrapNarrative("sub_industry", aiData.sub_industry),
    brand_category: wrapNarrative("brand_category", aiData.brand_category),
    company_type: wrapNarrative("company_type", aiData.company_type),
    business_model: wrapNarrative("business_model", aiData.business_model),
    founded_year: wrapNarrative("founded_year", aiData.founded_year),
    headquarters_city: wrapNarrative("headquarters_city", aiData.headquarters_city),
    headquarters_state: wrapNarrative("headquarters_state", aiData.headquarters_state),
    headquarters_country: wrapNarrative(
      "headquarters_country",
      prefer(aiData.headquarters_country, resolved.headquarters_country)
    ),
    operating_regions: wrapNarrative("operating_regions", aiData.operating_regions),

    last_year_revenue: wrapNarrative("last_year_revenue", lastYearRevenueRaw),
    last_year_revenue_year: wrapNarrative("last_year_revenue_year", aiData.last_year_revenue_year),
    employee_count: wrapNarrative("employee_count", employeeCountRaw),
    company_size_category: wrapNarrative("company_size_category", aiData.company_size_category),
    annual_revenue: wrapNarrative("annual_revenue", annualRevenueRaw),
    revenue_range: wrapNarrative("revenue_range", aiData.revenue_range),
    funding_total: wrapNarrative("funding_total", fundingTotalRaw),
    funding_stage: wrapNarrative("funding_stage", aiData.funding_stage),
    valuation: wrapNarrative("valuation", valuationRaw),
    profitability_status: wrapNarrative("profitability_status", aiData.profitability_status),
    growth_rate: wrapNarrative("growth_rate", aiData.growth_rate),
    brand_maturity: wrapNarrative("brand_maturity", aiData.brand_maturity),

    instagram_url: wrapNarrative("instagram_url", socials.instagram_url),
    instagram_followers: wrapNarrative("instagram_followers", instagramFollowersRaw),
    instagram_engagement_rate: wrapNarrative(
      "instagram_engagement_rate",
      aiData.instagram_engagement_rate
    ),
    youtube_url: wrapNarrative("youtube_url", socials.youtube_url),
    youtube_subscribers: wrapNarrative("youtube_subscribers", youtubeSubscribersRaw),
    linkedin_url: wrapNarrative("linkedin_url", socials.linkedin_url),
    facebook_url: wrapNarrative("facebook_url", socials.facebook_url),
    twitter_url: wrapNarrative("twitter_url", socials.twitter_url),
    website_traffic_monthly: wrapNarrative("website_traffic_monthly", websiteTrafficRaw),
    app_downloads: wrapNarrative("app_downloads", appDownloadsRaw),

    primary_contact_name: wrapNarrative("primary_contact_name", aiData.primary_contact_name),
    contact_designation: wrapNarrative("contact_designation", aiData.contact_designation),
    contact_email: wrapNarrative(
      "contact_email",
      prefer(
        aiData.contact_email,
        scraped?.sales_email || scraped?.general_email || scraped?.support_email
      )
    ),
    contact_phone: wrapNarrative("contact_phone", prefer(aiData.contact_phone, scraped?.public_phone)),
    linkedin_contact_url: wrapNarrative("linkedin_contact_url", aiData.linkedin_contact_url),
    contact_department: wrapNarrative("contact_department", aiData.contact_department),

    about_page_url: wrapNarrative("about_page_url", prefer(aiData.about_page_url, scraped?.about_page_url)),
    contact_page_url: wrapNarrative(
      "contact_page_url",
      prefer(aiData.contact_page_url, scraped?.contact_page_url)
    ),
    general_email: wrapNarrative("general_email", prefer(aiData.general_email, scraped?.general_email)),
    sales_email: wrapNarrative("sales_email", prefer(aiData.sales_email, scraped?.sales_email)),
    support_email: wrapNarrative("support_email", prefer(aiData.support_email, scraped?.support_email)),
    public_phone: wrapNarrative("public_phone", prefer(aiData.public_phone, scraped?.public_phone)),
    public_address: wrapNarrative("public_address", prefer(aiData.public_address, scraped?.public_address)),
  };
}

exports.BrandInformation = async (req, res) => {
  try {
    const brandName = req.body.brandName || req.body.brand_name;
    const forceRefresh = req.body.forceRefresh === true;
    const requestedProvider = req.body.provider || req.body.ai_provider || DEFAULT_PROVIDER;
    const effectiveProvider = resolveEffectiveProvider(requestedProvider);

    if (!brandName || typeof brandName !== "string" || !brandName.trim()) {
      return res.status(400).json({
        success: false,
        message: "brandName is required in request body",
      });
    }

    if (!effectiveProvider) {
      return res.status(500).json({
        success: false,
        message:
          "No AI provider is configured. Please set OPENAI_API_KEY and/or GEMINI_API_KEY.",
      });
    }

    const cleanBrandName = brandName.trim();
    const normalizedBrandName = cleanBrandName.toLowerCase();
    const websiteHint = normalizeWebsiteLikeInput(cleanBrandName);

    const existingBrand = await BrandInfo.findOne({
      normalized_brand_name: normalizedBrandName,
    });

    if (existingBrand && !forceRefresh) {
      return res.status(200).json({
        success: true,
        message: "Brand data fetched from database",
        provider_used: effectiveProvider,
        data: existingBrand,
      });
    }

    const resolutionResult = await resolveBrandIdentity(
      cleanBrandName,
      effectiveProvider,
      websiteHint
    );
    const resolved = resolutionResult.parsed;

    const websiteToScrape =
      normalizeText(resolved.website_url) ||
      (normalizeText(resolved.domain) ? `https://${resolved.domain}` : null) ||
      websiteHint;

    let scraped = null;
    if (websiteToScrape) {
      try {
        scraped = await scrapeBrandWebsite(websiteToScrape);
      } catch (scrapeError) {
        console.warn("scrapeBrandWebsite warning:", scrapeError.message);
      }
    }

    const profileResult = await buildBrandProfile(
      cleanBrandName,
      resolved,
      scraped,
      effectiveProvider
    );

    const finalData = {
      brand_id: existingBrand?.brand_id || crypto.randomUUID(),
      normalized_brand_name: normalizedBrandName,
      input_brand_name: cleanBrandName,

      ...profileResult.parsed,

      website_pages_scraped: Array.isArray(scraped?.website_pages_scraped)
        ? scraped.website_pages_scraped
        : [],
      last_scraped_at: scraped?.last_scraped_at || null,

    };

    const savedBrand = await BrandInfo.findOneAndUpdate(
      { normalized_brand_name: normalizedBrandName },
      { $set: finalData },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Brand data generated and saved successfully",
      provider_used: effectiveProvider,
      data: savedBrand,
    });
  } catch (error) {
    console.error("BrandInformation error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to generate and save brand data",
      error: error.message,
    });
  }
};

const generateRandomCode = (length = 9) => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  let code = "";

  for (let i = 0; i < length; i++) {
    const randomIndex = crypto.randomInt(0, chars.length);
    code += chars[randomIndex];
  }

  return code;
};

const createPromoCode = () => {
  return `CG${generateRandomCode(9)}`;
};

exports.CreateBrandCoupon = async (req, res) => {
  try {
    const {
      brandId,
      subscriptionId,
      newPrice,
      mode,
      expiredAt,
    } = req.body;

    if (!brandId || !subscriptionId || newPrice === undefined || !expiredAt || !mode) {
      return res.status(400).json({
        success: false,
        message: "brandId, subscriptionId, newPrice, expiredAt and mode are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid brandId",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(subscriptionId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid subscriptionId",
      });
    }

    if (Number(newPrice) < 0) {
      return res.status(400).json({
        success: false,
        message: "newPrice cannot be negative",
      });
    }

    let promocode;
    let isUnique = false;

    while (!isUnique) {
      promocode = createPromoCode();

      const existingPromoCode = await BrandCoupon.findOne({
        promocode,
      });

      if (!existingPromoCode) {
        isUnique = true;
      }
    }

    const brandCoupon = await BrandCoupon.create({
      brandId,
      subscriptionId,
      newPrice,
      mode,
      promocode,
      hasUsed: false,
      expiredAt,
    });

    return res.status(201).json({
      success: true,
      message: "Brand coupon created successfully",
      promocode: brandCoupon.promocode,
      data: brandCoupon,
    });

  } catch (error) {
    console.error("CreateBrandCoupon error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create brand coupon",
      error: error.message,
    });
  }
};
exports.subscriptionList = async (req, res) => {
  try {
    const list = await subscription
      .find({
        status: "active",
        role: "Brand",
      })
      .select("name monthlyCost annualCost currency")
      .lean();

    return res.status(200).json({
      success: true,
      message: "Subscription list fetched successfully",
      data: list,
    });
  } catch (error) {
    console.error("subscriptionList error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch subscription list",
      error: error.message,
    });
  }
};