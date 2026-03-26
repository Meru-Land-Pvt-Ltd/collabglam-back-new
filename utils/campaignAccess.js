'use strict';

const mongoose = require('mongoose');
const BrandAssigned = require('../models/brandAssigned');
const Campaign = require('../models/campaign');
const { ROLES } = require('../models/master');

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function toLower(v) {
  return cleanStr(v).toLowerCase();
}

function isValidObjectId(v) {
  return mongoose.Types.ObjectId.isValid(cleanStr(v));
}

function toObjectId(v) {
  return new mongoose.Types.ObjectId(cleanStr(v));
}

function uniqStrings(values = []) {
  return Array.from(new Set(values.map((x) => cleanStr(x)).filter(Boolean)));
}

function buildIdMatch(field, rawValue) {
  const value = cleanStr(rawValue);
  if (!value) return [];

  const out = [{ [field]: value }];

  if (isValidObjectId(value)) {
    out.push({ [field]: toObjectId(value) });
  }

  return out;
}

function buildManyIdMatch(field, values = []) {
  const cleaned = uniqStrings(values);
  const stringValues = cleaned;
  const objectIdValues = cleaned.filter(isValidObjectId).map(toObjectId);

  const or = [];

  if (stringValues.length) {
    or.push({ [field]: { $in: stringValues } });
  }

  if (objectIdValues.length) {
    or.push({ [field]: { $in: objectIdValues } });
  }

  return or;
}

async function getAccessibleBrandIds(actor) {
  const adminId =
    cleanStr(actor?.adminId) ||
    cleanStr(actor?._id) ||
    cleanStr(actor?.id);

  const role = toLower(actor?.role);

  if (!adminId) return [];
  if (role === toLower(ROLES.SUPER_ADMIN)) return null;

  const or = [];

  if (role === toLower(ROLES.REVENUE_HEAD)) {
    or.push(...buildIdMatch('RHId', adminId));
  }

  if (role === toLower(ROLES.BME)) {
    or.push(...buildIdMatch('bdmId', adminId));
  }

  if (role === toLower(ROLES.IME)) {
    or.push(...buildIdMatch('idmId', adminId));
  }

  if (!or.length) return [];

  const rows = await BrandAssigned.find({
    status: 'active',
    $or: or,
  })
    .select('brandId')
    .lean();

  return uniqStrings(rows.map((row) => row.brandId));
}

async function buildCampaignVisibilityFilter(actor) {
  const brandIds = await getAccessibleBrandIds(actor);

  if (brandIds === null) {
    return {};
  }

  if (!brandIds.length) {
    return { _id: { $in: [] } };
  }

  const brandIdOr = buildManyIdMatch('brandId', brandIds);

  if (!brandIdOr.length) {
    return { _id: { $in: [] } };
  }

  return brandIdOr.length === 1 ? brandIdOr[0] : { $or: brandIdOr };
}

async function ensureCampaignAccess(actor, campaignId) {
  const cleanCampaignId = cleanStr(campaignId);

  if (!cleanCampaignId || !isValidObjectId(cleanCampaignId)) {
    return null;
  }

  const visibilityFilter = await buildCampaignVisibilityFilter(actor);

  return Campaign.findOne({
    _id: toObjectId(cleanCampaignId),
    ...visibilityFilter,
  })
    .select('_id brandId name campaignTitle')
    .lean();
}

async function ensureBrandCampaignAccess(brandId, campaignId) {
  const cleanBrandId = cleanStr(brandId);
  const cleanCampaignId = cleanStr(campaignId);

  if (!cleanBrandId) return null;
  if (!cleanCampaignId || !isValidObjectId(cleanCampaignId)) {
    return null;
  }

  const brandIdOr = buildIdMatch('brandId', cleanBrandId);

  if (!brandIdOr.length) {
    return null;
  }

  return Campaign.findOne({
    _id: toObjectId(cleanCampaignId),
    $or: brandIdOr,
  })
    .select('_id brandId name campaignTitle')
    .lean();
}

module.exports = {
  getAccessibleBrandIds,
  buildCampaignVisibilityFilter,
  ensureCampaignAccess,
  ensureBrandCampaignAccess,
};