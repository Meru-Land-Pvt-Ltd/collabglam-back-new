const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { AdminModel } = require("../models/master");
const INVITE_EXP_MINUTES = Number(process.env.INVITE_EXP_MINUTES || 60);
const {sendEmail}=require("../services/emailService")
const {adminInviteEmailTemplate} = require("../template/inviteRole")
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
  
      if (!existing) {
        return candidate;
      }
  
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

const sendEmailSES = async ({ to, payload }) => {
  console.log("Mock email sent to:", to);
  console.log("Subject:", payload.subject);
  console.log("HTML:", payload.html);

  return true;
};



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
      "+passwordHash role status name email access"
    );

    if (!admin) {
      return res.status(401).json({
        message: "Invalid credentials",
      });
    }

    if (admin.status && admin.status !== "active") {
      return res.status(403).json({
        message: `Admin is ${admin.status}`,
      });
    }

    if (!admin.passwordHash) {
      return res.status(403).json({
        message: "Password not set. Please use invite link.",
      });
    }

    const isMatch = await bcrypt.compare(password, admin.passwordHash);
    if (!isMatch) {
      return res.status(401).json({
        message: "Invalid credentials",
      });
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      return res.status(500).json({
        message: "JWT_SECRET is missing in env",
      });
    }

    const payload = {
      adminId: admin._id.toString(),
      role: admin.role,
      email: admin.email,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

    try {
      admin.lastLoginAt = new Date();
      await admin.save();
    } catch (e) {}

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
      },
    });
  } catch (err) {
    return res.status(500).json({
      message: err.message || "Internal error",
    });
  }
};

// ======================
// Admin Invite
// ======================
exports.inviteAdmin = async (req, res) => {
    try {
      const email = clean(req.body?.email).toLowerCase();
      const role = clean(req.body?.role);
      const name = clean(req.body?.name);
      const access = parseAccess(req.body?.access);
  
      if (!email || !role) {
        return res.status(400).json({
          message: "email and role are required",
        });
      }
  
      let admin = await AdminModel.findOne({ email: exactCI(email) }).select(
        "+passwordHash +inviteTokenHash"
      );
  
      if (admin && admin.status === "active" && admin.passwordHash) {
        return res.status(409).json({
          message: "Admin already active",
        });
      }
  
      if (!admin) {
        admin = await AdminModel.create({
          email,
          name: name || undefined,
          role,
          status: "pending",
          access,
          createdBy: req.admin?.adminId,
        });
      } else {
        admin.role = role;
        if (name) admin.name = name;
        admin.status = "pending";
  
        if (Array.isArray(req.body?.access)) {
          admin.access = access;
        }
      }
  
      const rawToken = generateInviteToken(32);
      const tokenHash = sha256(rawToken);
  
      admin.invitedAt = new Date();
      admin.inviteTokenHash = tokenHash;
      admin.inviteExpiresAt = new Date(
        Date.now() + INVITE_EXP_MINUTES * 60 * 1000
      );
  
      await admin.save();
  
      const adminAppUrl = process.env.ADMIN_APP_URL || "http://localhost:3000";
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
      return res.status(500).json({
        message: err.message || "Internal error",
      });
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
        "+inviteTokenHash +passwordHash role status email name access proxyEmail"
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
// List Admins
// ======================
exports.listAdmins = async (req, res) => {
  try {
    const admins = await AdminModel.find({})
      .select("email name role status invitedAt lastLoginAt createdAt updatedAt access")
      .sort({ createdAt: -1 });

    return res.status(200).json(admins);
  } catch (err) {
    return res.status(500).json({
      message: err.message || "Internal error",
    });
  }
};

// ======================
// Update Admin Status
// ======================
exports.updateStatus = async (req, res) => {
  try {
    const adminId = clean(req.body?.adminId);
    const status = clean(req.body?.status);
    const role = clean(req.body?.role);

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

    admin.status = status;
    if (role) admin.role = role;
    if (accessProvided) admin.access = access;

    await admin.save();

    return res.status(200).json({
      message: "Admin status updated successfully",
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
      "email name role status access lastLoginAt createdAt updatedAt"
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
      permissions,
      canEditPermissions,
    });
  } catch (err) {
    return res.status(500).json({
      message: err.message || "Internal error",
    });
  }
};