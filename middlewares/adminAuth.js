const jwt = require("jsonwebtoken");
const { AdminModel } = require("../models/master");

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
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
      "email role status access proxyEmail"
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

    const roleKey = String(admin.role || "").trim();
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
      adminId: String(admin._id),
      email: admin.email || decoded.email,
      proxyEmail: admin.proxyEmail || "",
      role: roleKey,
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
};