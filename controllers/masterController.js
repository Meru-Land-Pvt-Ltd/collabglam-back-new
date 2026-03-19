const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { AdminModel, ROLES } = require("../models/master");
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
  const domain = "collabglam.cloud";

  let base = slugifyName(name);

  if (!base) {
    const emailPrefix = String(email || "").split("@")[0];
    base = slugifyName(emailPrefix);
  }

  if (!base) {
    base = "admin";
  }

  let candidate = `${base}@${domain}`;
  let counter = 1;

  while (true) {
    const existing = await AdminModel.findOne({
      proxyEmail: candidate,
      ...(currentAdminId ? { _id: { $ne: currentAdminId } } : {}),
    }).select("_id proxyEmail");

    if (!existing) return candidate;

    candidate = `${base}${counter}@${domain}`;
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

  if (role === ROLES.SUPER_ADMIN) {
    return {
      parentAdmin: null,
      rootAdmin: null,
      teamType: "leadership",
    };
  }

  if (inviter.role === ROLES.SUPER_ADMIN && role === ROLES.REVENUE_HEAD) {
    return {
      parentAdmin: inviter._id,
      rootAdmin: inviter._id,
      teamType: "sales",
    };
  }

  if (inviter.role === ROLES.SUPER_ADMIN && [ROLES.IME, ROLES.BME].includes(role)) {
    return {
      parentAdmin: explicitParentAdmin || null,
      rootAdmin: inviter._id,
      teamType: "execution",
    };
  }

  if (inviter.role === ROLES.REVENUE_HEAD && [ROLES.IME, ROLES.BME].includes(role)) {
    return {
      parentAdmin: inviter._id,
      rootAdmin: inviter.rootAdmin || inviter._id,
      teamType: "execution",
    };
  }

  return {
    parentAdmin: null,
    rootAdmin: inviter.rootAdmin || inviter._id || null,
    teamType: null,
  };
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
      "+passwordHash role status name email access parentAdmin rootAdmin"
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
      },
    });
  } catch (err) {
    return res.status(500).json({ message: err.message || "Internal error" });
  }
};

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
      admin = await AdminModel.create({
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
        "email name role status invitedAt lastLoginAt createdAt updatedAt access parentAdmin rootAdmin createdBy"
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

    const adminId = clean(req.body?.adminId);
    const status = clean(req.body?.status);
    const role = normalizeRole(req.body?.role);

    const accessProvided = Array.isArray(req.body?.access);
    const access = parseAccess(req.body?.access);

    if (!adminId || !status) {
      return res.status(400).json({
        message: "adminId and status are required",
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

    if (role) {
      if (!canInviteRole(actor.role, role)) {
        return res.status(403).json({
          message: "You are not allowed to assign this role",
        });
      }
      admin.role = role;
    }

    admin.status = status;
    if (accessProvided) admin.access = access;

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
      "email name role status access lastLoginAt createdAt updatedAt parentAdmin rootAdmin"
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
        message: "brandId and RHId are required",
      });
    }

    // 1) If brand already has ACTIVE assignment, don't create new
    const activeAssign = await BrandAssigned.findOne({
      brandId,
      status: "active",
    }).exec();

    if (activeAssign) {
      // if different RHId is trying to assign -> conflict
      if (String(activeAssign.RHId) !== String(RHId)) {
        return res.status(409).json({
          success: false,
          message: "Brand already has an active assignment with a different RHId",
          data: activeAssign,
        });
      }

      // same RHId -> update only (no new doc)
      if (bdmId !== undefined) activeAssign.bdmId = bdmId;
      if (idmId !== undefined) activeAssign.idmId = idmId;

      await activeAssign.save();

      return res.status(200).json({
        success: true,
        message: "Brand assignment updated successfully",
        data: activeAssign,
      });
    }

    // 2) No active assignment:
    // If there is an old assignment for same brandId + RHId (status not active) -> update it to active
    const existingInactive = await BrandAssigned.findOne({
      brandId,
      RHId,
      status: { $ne: "active" },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .exec();

    if (existingInactive) {
      existingInactive.status = "active";
      if (bdmId !== undefined) existingInactive.bdmId = bdmId;
      if (idmId !== undefined) existingInactive.idmId = idmId;

      await existingInactive.save();

      return res.status(200).json({
        success: true,
        message: "Previous assignment re-activated and updated",
        data: existingInactive,
      });
    }

    // 3) Nothing exists -> create new
    const newAssign = await BrandAssigned.create({
      brandId,
      RHId,
      bdmId: bdmId ?? null,
      idmId: idmId ?? null,
      status: "active",
    });

    return res.status(201).json({
      success: true,
      message: "Brand assigned successfully",
      data: newAssign,
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
      if(adminId == "64b8c8f1c9d898001d9e7c3e"){

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
  
      const executives = await AdminModel.find({ parentAdmin: adminId,status: "active" })
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

  exports.rmlist= async(req,res)=>{
    try{
      const rms = await AdminModel.find({role:"revenue_head",status:"active"})
      .select("-passwordHash -inviteTokenHash")
      .sort({ createdAt: -1 });

      return res.status(200).json({
        success: true,
        count: rms.length,
        data: rms,
      });
    }catch(e){
      return res.status(500).json({
        success: false,
        message: e?.message || "Internal error",
      });
    }
  }





  