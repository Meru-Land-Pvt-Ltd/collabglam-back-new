const jwt = require("jsonwebtoken");
const { AdminModel } = require("../models/master");

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

async function optionalAdminAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      req.admin = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const admin = await AdminModel.findById(decoded.adminId || decoded.id).select(
      "email name role status access proxyEmail parentAdmin rootAdmin"
    );

    if (!admin) {
      req.admin = null;
      return next();
    }

    req.admin = {
      _id: String(admin._id),
      adminId: String(admin._id),
      email: admin.email || decoded.email,
      name: admin.name || "",
      proxyEmail: admin.proxyEmail || "",
      role: String(admin.role || "").trim().toLowerCase(),
      status: String(admin.status || "").toLowerCase(),
      parentAdmin: admin.parentAdmin ? String(admin.parentAdmin) : null,
      rootAdmin: admin.rootAdmin ? String(admin.rootAdmin) : null,
      access: Array.isArray(admin.access)
        ? admin.access.map((a) => ({
            key: normalizeKey(a?.key),
            name: a?.name ? String(a.name) : undefined,
            isEdit: Boolean(a?.isEdit),
            isDelete: Boolean(a?.isDelete),
            isManager: Boolean(a?.isManager),
          }))
        : [],
      iat: decoded.iat,
      exp: decoded.exp,
    };

    return next();
  } catch (err) {
    req.admin = null;
    return next();
  }
}

async function adminAuth(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({
        message: "Authorization token missing",
      });
    }

    const token = header.split(" ")[1];
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      return res.status(500).json({
        message: "JWT_SECRET is missing in env",
      });
    }

    const decoded = jwt.verify(token, secret);

    if (!decoded?.adminId) {
      return res.status(401).json({
        message: "Invalid token",
      });
    }

    const admin = await AdminModel.findById(decoded.adminId).select(
      "email name role status access proxyEmail parentAdmin rootAdmin"
    );

    if (!admin) {
      return res.status(401).json({
        message: "Admin not found",
      });
    }

    const adminStatus = normalizeKey(admin.status || "");
    if (adminStatus && adminStatus !== "active") {
      return res.status(403).json({
        message: "Admin account is not active",
      });
    }

    const roleKey = String(admin.role || "").trim().toLowerCase();
    if (!roleKey) {
      return res.status(403).json({
        message: "Role not assigned",
      });
    }

    const access = Array.isArray(admin.access)
      ? admin.access.map((a) => ({
          key: normalizeKey(a?.key),
          name: a?.name ? String(a.name) : undefined,
          isEdit: Boolean(a?.isEdit),
          isDelete: Boolean(a?.isDelete),
          isManager: Boolean(a?.isManager),
        }))
      : [];

    req.admin = {
      _id: String(admin._id),
      adminId: String(admin._id),
      email: admin.email || decoded.email,
      name: admin.name || "",
      proxyEmail: admin.proxyEmail || "",
      role: roleKey,
      status: String(admin.status || "").toLowerCase(),
      parentAdmin: admin.parentAdmin ? String(admin.parentAdmin) : null,
      rootAdmin: admin.rootAdmin ? String(admin.rootAdmin) : null,
      access,
      iat: decoded.iat,
      exp: decoded.exp,
    };

    return next();
  } catch (err) {
    return res.status(401).json({
      message: "Invalid token",
    });
  }
}

module.exports = {
  adminAuth,
  optionalAdminAuth
};