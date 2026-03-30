'use strict';

const jwt = require('jsonwebtoken');
const { AdminModel } = require('../models/master');

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
}

function toDesignation(role) {
  const raw = String(role || '').trim().toLowerCase();
  if (!raw) return '';
  return raw
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function serializeMiniAdmin(admin) {
  if (!admin) return null;

  return {
    _id: String(admin._id),
    adminId: String(admin._id),
    name: admin.name || '',
    email: admin.email || '',
    role: String(admin.role || '').trim().toLowerCase(),
    designation: toDesignation(admin.role),
    teamType: admin.teamType || null,
  };
}

function serializeAccess(access) {
  return Array.isArray(access)
    ? access.map((a) => ({
        key: normalizeKey(a?.key),
        name: a?.name ? String(a.name) : undefined,
        isEdit: Boolean(a?.isEdit),
        isDelete: Boolean(a?.isDelete),
        isManager: Boolean(a?.isManager),
      }))
    : [];
}

function buildAdminPayload(admin, decoded = {}) {
  return {
    _id: String(admin._id),
    adminId: String(admin._id),
    email: admin.email || decoded.email || '',
    name: admin.name || '',
    proxyEmail: admin.proxyEmail || '',
    role: String(admin.role || '').trim().toLowerCase(),
    designation: toDesignation(admin.role),
    status: String(admin.status || '').toLowerCase(),
    teamType: admin.teamType || null,

    parentAdmin: serializeMiniAdmin(admin.parentAdmin),
    rootAdmin: serializeMiniAdmin(admin.rootAdmin),
    createdBy: serializeMiniAdmin(admin.createdBy),

    access: serializeAccess(admin.access),

    iat: decoded.iat,
    exp: decoded.exp,
  };
}

async function fetchAdminById(id) {
  return AdminModel.findById(id)
    .select(
      'email name role status access proxyEmail parentAdmin rootAdmin createdBy teamType'
    )
    .populate('parentAdmin', 'name email role teamType')
    .populate('rootAdmin', 'name email role teamType')
    .populate('createdBy', 'name email role teamType');
}

async function optionalAdminAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!token) {
      req.admin = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await fetchAdminById(decoded.adminId || decoded.id);

    if (!admin) {
      req.admin = null;
      return next();
    }

    req.admin = buildAdminPayload(admin, decoded);
    return next();
  } catch (err) {
    req.admin = null;
    return next();
  }
}

async function adminAuth(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({
        message: 'Authorization token missing',
      });
    }

    const token = header.split(' ')[1];
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      return res.status(500).json({
        message: 'JWT_SECRET is missing in env',
      });
    }

    const decoded = jwt.verify(token, secret);

    if (!decoded?.adminId) {
      return res.status(401).json({
        message: 'Invalid token',
      });
    }

    const admin = await fetchAdminById(decoded.adminId);

    if (!admin) {
      return res.status(401).json({
        message: 'Admin not found',
      });
    }

    const adminStatus = normalizeKey(admin.status || '');
    if (adminStatus && adminStatus !== 'active') {
      return res.status(403).json({
        message: 'Admin account is not active',
      });
    }

    const roleKey = String(admin.role || '').trim().toLowerCase();
    if (!roleKey) {
      return res.status(403).json({
        message: 'Role not assigned',
      });
    }

    req.admin = buildAdminPayload(admin, decoded);
    return next();
  } catch (err) {
    return res.status(401).json({
      message: 'Invalid token',
    });
  }
}

module.exports = {
  adminAuth,
  optionalAdminAuth,
};