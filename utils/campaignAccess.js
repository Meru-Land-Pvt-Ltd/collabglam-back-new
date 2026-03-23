'use strict';

const mongoose = require('mongoose');
const BrandAssigned = require('../models/brandAssigned');
const Campaign = require('../models/campaign');
const { ROLES } = require('../models/master');

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function uniqIds(values = []) {
  return Array.from(
    new Set(values.map((x) => cleanStr(x)).filter(Boolean))
  );
}

async function getAccessibleBrandIds(actor) {
  const adminId = cleanStr(actor?.adminId);
  const role = cleanStr(actor?.role).toLowerCase();

  if (!adminId) return [];
  if (role === ROLES.SUPER_ADMIN) return null;

  const or = [];

  if (role === ROLES.REVENUE_HEAD) {
    or.push({ RHId: adminId });
    if (mongoose.Types.ObjectId.isValid(adminId)) {
      or.push({ RHId: new mongoose.Types.ObjectId(adminId) });
    }
  }

  if (role === ROLES.BME) {
    or.push({ bdmId: adminId });
    if (mongoose.Types.ObjectId.isValid(adminId)) {
      or.push({ bdmId: new mongoose.Types.ObjectId(adminId) });
    }
  }

  if (role === ROLES.IME) {
    or.push({ idmId: adminId });
    if (mongoose.Types.ObjectId.isValid(adminId)) {
      or.push({ idmId: new mongoose.Types.ObjectId(adminId) });
    }
  }

  if (!or.length) return [];

  const rows = await BrandAssigned.find({
    status: 'active',
    $or: or,
  })
    .select('brandId')
    .lean();

  return uniqIds(rows.map((r) => r.brandId));
}

async function buildCampaignVisibilityFilter(actor) {
  const brandIds = await getAccessibleBrandIds(actor);

  if (brandIds === null) {
    return {};
  }

  return {
    brandId: { $in: brandIds },
  };
}

async function ensureCampaignAccess(actor, campaignId) {
  if (!campaignId || !mongoose.Types.ObjectId.isValid(campaignId)) {
    return null;
  }

  const visibilityFilter = await buildCampaignVisibilityFilter(actor);

  const filter = {
    _id: campaignId,
    ...visibilityFilter,
  };

  return Campaign.findOne(filter).select('_id brandId name').lean();
}

module.exports = {
  getAccessibleBrandIds,
  buildCampaignVisibilityFilter,
  ensureCampaignAccess,
};