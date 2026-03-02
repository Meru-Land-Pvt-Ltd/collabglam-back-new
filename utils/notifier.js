// utils/notifier.js
const Notification = require('../models/notification');
const sockets = require('../sockets'); // { emitToBrand, emitToInfluencer, emitToAdmin }

async function createAndEmit({
  brandId = null,
  influencerId = null,
  adminId = null,

  brandIds = null,
  influencerIds = null,
  adminIds = null,

  type,
  title,
  message = '',
  entityType = null,
  entityId = null,
  actionPath = null, // string OR { brand, influencer, admin }
}) {
  if (!type || !title) {
    throw new Error('createAndEmit: type and title are required');
  }

  // normalize recipients into arrays
  const bIds = [
    ...(brandId ? [brandId] : []),
    ...(Array.isArray(brandIds) ? brandIds : []),
  ]
    .filter(Boolean)
    .map((v) => String(v));

  const iIds = [
    ...(influencerId ? [influencerId] : []),
    ...(Array.isArray(influencerIds) ? influencerIds : []),
  ]
    .filter(Boolean)
    .map((v) => String(v));

  const aIds = [
    ...(adminId ? [adminId] : []),
    ...(Array.isArray(adminIds) ? adminIds : []),
  ]
    .filter(Boolean)
    .map((v) => String(v));

  // dedupe
  const uniqueBrandIds = Array.from(new Set(bIds));
  const uniqueInfluencerIds = Array.from(new Set(iIds));
  const uniqueAdminIds = Array.from(new Set(aIds));

  if (!uniqueBrandIds.length && !uniqueInfluencerIds.length && !uniqueAdminIds.length) {
    throw new Error('createAndEmit: provide at least one recipient (brandId/influencerId/adminId)');
  }

  const resolveActionPath = (kind) => {
    if (!actionPath) return null;
    if (typeof actionPath === 'string') return actionPath;

    if (typeof actionPath === 'object') {
      if (kind === 'brand') return actionPath.brand || null;
      if (kind === 'influencer') return actionPath.influencer || null;
      if (kind === 'admin') return actionPath.admin || null;
    }
    return null;
  };

  // build docs to insert (one row per recipient)
  const docsToInsert = [
    ...uniqueBrandIds.map((id) => ({
      brandId: id,
      influencerId: null,
      adminId: null,
      type,
      title,
      message,
      entityType,
      entityId,
      actionPath: resolveActionPath('brand'),
    })),
    ...uniqueInfluencerIds.map((id) => ({
      brandId: null,
      influencerId: id,
      adminId: null,
      type,
      title,
      message,
      entityType,
      entityId,
      actionPath: resolveActionPath('influencer'),
    })),
    ...uniqueAdminIds.map((id) => ({
      brandId: null,
      influencerId: null,
      adminId: id,
      type,
      title,
      message,
      entityType,
      entityId,
      actionPath: resolveActionPath('admin'),
    })),
  ];

  const created = await Notification.insertMany(docsToInsert, { ordered: true });

  // emit socket events (best-effort)
  try {
    for (const doc of created) {
      const payload = doc.toObject ? doc.toObject() : doc;

      if (payload.brandId && typeof sockets.emitToBrand === 'function') {
        sockets.emitToBrand(String(payload.brandId), 'notification.new', payload);
      }
      if (payload.influencerId && typeof sockets.emitToInfluencer === 'function') {
        sockets.emitToInfluencer(String(payload.influencerId), 'notification.new', payload);
      }
      if (payload.adminId && typeof sockets.emitToAdmin === 'function') {
        sockets.emitToAdmin(String(payload.adminId), 'notification.new', payload);
      }
    }
  } catch (e) {
    console.warn('Socket emit failed:', e.message);
  }

  return created.length === 1 ? created[0] : created;
}

module.exports = { createAndEmit };