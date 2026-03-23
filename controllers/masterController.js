const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { AdminModel, ROLES, PROXY_EMAIL_DOMAIN } = require("../models/master");
const {
  canInviteRole,
  buildAdminVisibilityFilter,
  canManageTarget,
} = require("../utils/adminHierarchy");
const { sendEmail } = require("../services/emailService");
const { adminInviteEmailTemplate } = require("../template/inviteRole");
const brand = require("../models/brand");
const BrandAssigned = require("../models/brandAssigned");
const mongoose = require("mongoose");
const INVITE_EXP_MINUTES = Number(process.env.INVITE_EXP_MINUTES || 60);
const { buildCampaignVisibilityFilter } = require('../utils/campaignAccess');
const Campaign = require('../models/campaign');

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

  if (inviter.role === ROLES.SUPER_ADMIN && [ROLES.IME, ROLES.BME].includes(role)) {
    return {
      parentAdmin: explicitParentAdmin || null,
      rootAdmin: inviterId,
      teamType: "execution",
    };
  }

  if (inviter.role === ROLES.REVENUE_HEAD && [ROLES.IME, ROLES.BME].includes(role)) {
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

    if (actor.role === ROLES.SUPER_ADMIN && [ROLES.IME, ROLES.BME].includes(role)) {
      if (!explicitParentAdmin) {
        return res.status(400).json({
          message: "parentAdmin is required when Super Admin invites IME/BME directly",
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

    const adminAppUrl = process.env.ADMIN_APP_URL || "https://collabglam.cloud";
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

        let assignedRm = "";
        let assignedBm = "";
        let assignedIm = "";
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

            assignedRm = assignedData.RHId
              ? masterMap[String(assignedData.RHId)] || ""
              : "";
            assignedBm = assignedData.bdmId
              ? masterMap[String(assignedData.bdmId)] || ""
              : "";
            assignedIm = assignedData.idmId
              ? masterMap[String(assignedData.idmId)] || ""
              : "";
          }
        }

        return {
          ...item,
          assignedRm,
          assignedBm,
          assignedIm,
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

exports.assignBrand = async (req, res) => {
  try {
    const { brandId, RHId, bdmId, idmId } = req.body;

    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: "brandId is required",
      });
    }

    const wantsRH = RHId !== undefined && RHId !== null && String(RHId).trim() !== "";
    const wantsBDMorIDM = bdmId !== undefined || idmId !== undefined;

    if (!wantsRH && !wantsBDMorIDM) {
      return res.status(400).json({
        success: false,
        message: "Send RHId to assign RH OR send bdmId/idmId to assign BDM/IDM",
      });
    }

    // ---------------------------
    // CASE A: RH assignment (RHId present)
    // ---------------------------
    if (wantsRH) {
      const set = { RHId, status: "active" };
      if (bdmId !== undefined) set.bdmId = bdmId;
      if (idmId !== undefined) set.idmId = idmId;

      // 1) Update active doc if exists
      let doc = await BrandAssigned.findOneAndUpdate(
        { brandId, status: "active" },
        { $set: set },
        { new: true }
      ).exec();

      if (doc) {
        return res.status(200).json({
          success: true,
          message: "RH assigned successfully (updated active assignment)",
          data: doc,
        });
      }

      // 2) Reactivate/update latest old doc if exists
      doc = await BrandAssigned.findOneAndUpdate(
        { brandId },
        { $set: set },
        { new: true, sort: { updatedAt: -1, createdAt: -1 } }
      ).exec();

      if (doc) {
        return res.status(200).json({
          success: true,
          message: "RH assigned successfully (reactivated previous assignment)",
          data: doc,
        });
      }

      // 3) Create new if none exists
      const created = await BrandAssigned.create({
        brandId,
        RHId,
        bdmId: bdmId ?? null,
        idmId: idmId ?? null,
        status: "active",
      });

      return res.status(201).json({
        success: true,
        message: "RH assigned successfully (created new assignment)",
        data: created,
      });
    }

    // ---------------------------
    // CASE B: Only BDM/IDM assignment (RHId NOT present)
    // RH must already exist in DB
    // ---------------------------
    const set = {};
    if (bdmId !== undefined) set.bdmId = bdmId;
    if (idmId !== undefined) set.idmId = idmId;

    // 1) Update active doc ONLY if RH is already assigned
    let updated = await BrandAssigned.findOneAndUpdate(
      {
        brandId,
        status: "active",
        RHId: { $exists: true, $ne: null },
      },
      { $set: set },
      { new: true }
    ).exec();

    if (updated) {
      return res.status(200).json({
        success: true,
        message: "BDM/IDM assigned successfully (updated active RH assignment)",
        data: updated,
      });
    }

    // 2) If no active doc, update latest doc where RH exists (reactivate)
    updated = await BrandAssigned.findOneAndUpdate(
      {
        brandId,
        RHId: { $exists: true, $ne: null },
      },
      { $set: { ...set, status: "active" } },
      { new: true, sort: { updatedAt: -1, createdAt: -1 } }
    ).exec();

    if (!updated) {
      return res.status(400).json({
        success: false,
        message: "RH is not assigned for this brand. Assign RH first, then add BDM/IDM.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "BDM/IDM assigned successfully (updated existing RH assignment)",
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

    const executives = await AdminModel.find({ parentAdmin: adminId, status: "active" })
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

exports.listCampaignsForAdmin = async (req, res) => {
  try {
    const actor = req.admin;

    if (!actor?.adminId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
    }

    const visibilityFilter = await buildCampaignVisibilityFilter(actor);

    const filter = {
      ...visibilityFilter,
      'createdBy.role': 'admin', // only brand-created campaigns
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

    return res.status(200).json({
      success: true,
      count: campaigns.length,
      data: campaigns,
    });
  } catch (e) {
    console.error('listCampaignsForAdmin error:', e);
    return res.status(500).json({
      success: false,
      message: e?.message || 'Internal error',
    });
  }
};