'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PitchFolder = require('../models/pitchFolder');
const { AdminModel, ROLES } = require('../models/master');
const InfluencerProfile = require('../models/youtube');

const ALLOWED_PROVIDERS = ['instagram', 'youtube', 'tiktok'];
const MEDIA_KIT_REQUEST_STATUSES = ['none', 'requested', 'approved', 'rejected'];

let s3ClientSingleton = null;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function uniqStrings(values = []) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    const s = cleanStr(value);
    if (!s) continue;

    const key = s.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(s);
  }

  return out;
}

function toNullableNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNullableInteger(v) {
  const n = toNullableNumber(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function slugify(value) {
  return cleanStr(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function getActorAdminId(actor) {
  return actor?.adminId || actor?._id || actor?.id || null;
}

function toDesignation(role) {
  const raw = cleanStr(role).toLowerCase();
  if (!raw) return '';
  return raw
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isSuperAdmin(actor) {
  return cleanStr(actor?.role).toLowerCase() === ROLES.SUPER_ADMIN;
}

function isRevenueHead(actor) {
  return cleanStr(actor?.role).toLowerCase() === ROLES.REVENUE_HEAD;
}

function isIme(actor) {
  return cleanStr(actor?.role).toLowerCase() === ROLES.IME;
}

function canCreateOrManagePitchFolders(actor) {
  if (!actor) return false;
  return isSuperAdmin(actor) || isRevenueHead(actor) || isIme(actor);
}

function normalizeProvider(value) {
  const raw = cleanStr(value).toLowerCase();
  if (raw === 'insta' || raw === 'ig') return 'instagram';
  if (ALLOWED_PROVIDERS.includes(raw)) return raw;
  return 'instagram';
}

function hasStoredMediaKit(mediaKit) {
  return !!cleanStr(mediaKit?.s3Key);
}

function hasMediaKitLink(mediaKitLink) {
  return !!cleanStr(mediaKitLink?.url);
}

function getVisibleMediaKitSource(item) {
  const pdfVisible = hasStoredMediaKit(item?.mediaKit) && !!item?.mediaKit?.showToBrand;
  const linkVisible = hasMediaKitLink(item?.mediaKitLink) && !!item?.mediaKitLink?.showToBrand;

  if (pdfVisible) return 'pdf';
  if (linkVisible) return 'link';
  return '';
}

function getRequestedMediaKitSource(item) {
  const pdfRequested = cleanStr(item?.mediaKit?.requestStatus).toLowerCase() === 'requested';
  const linkRequested = cleanStr(item?.mediaKitLink?.requestStatus).toLowerCase() === 'requested';

  if (pdfRequested) return 'pdf';
  if (linkRequested) return 'link';
  return '';
}

function getPreferredMediaKitSource(item) {
  const visibleSource = getVisibleMediaKitSource(item);
  if (visibleSource) return visibleSource;

  const requestedSource = getRequestedMediaKitSource(item);
  if (requestedSource) return requestedSource;

  if (hasStoredMediaKit(item?.mediaKit)) return 'pdf';
  if (hasMediaKitLink(item?.mediaKitLink)) return 'link';
  return '';
}

function getGenericMediaKitRequestStatus(item) {
  const visibleSource = getVisibleMediaKitSource(item);
  if (visibleSource) return 'approved';

  const pdfStatus = cleanStr(item?.mediaKit?.requestStatus).toLowerCase();
  const linkStatus = cleanStr(item?.mediaKitLink?.requestStatus).toLowerCase();

  if (pdfStatus === 'requested' || linkStatus === 'requested') return 'requested';
  if (pdfStatus === 'rejected' || linkStatus === 'rejected') return 'rejected';
  return 'none';
}

function getGenericMediaKitRequestedAt(item) {
  const candidates = [item?.mediaKit?.requestedAt, item?.mediaKitLink?.requestedAt]
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  return candidates.length ? candidates[0] : null;
}

function ensureSingleSharedMediaKit(item, preferredSource = '') {
  const hasPdf = hasStoredMediaKit(item?.mediaKit);
  const hasLink = hasMediaKitLink(item?.mediaKitLink);

  if (item?.mediaKit?.showToBrand && !hasPdf) {
    item.mediaKit.showToBrand = false;
  }

  if (item?.mediaKitLink?.showToBrand && !hasLink) {
    item.mediaKitLink.showToBrand = false;
  }

  const pdfVisible = hasPdf && !!item?.mediaKit?.showToBrand;
  const linkVisible = hasLink && !!item?.mediaKitLink?.showToBrand;

  if (pdfVisible && linkVisible) {
    if (preferredSource === 'link') {
      item.mediaKit.showToBrand = false;
      if (cleanStr(item?.mediaKit?.requestStatus).toLowerCase() === 'approved') {
        item.mediaKit.requestStatus = 'none';
      }
    } else {
      item.mediaKitLink.showToBrand = false;
      if (cleanStr(item?.mediaKitLink?.requestStatus).toLowerCase() === 'approved') {
        item.mediaKitLink.requestStatus = 'none';
      }
    }
  }
}

function ensureGenericRequestConsistency(item) {
  if (!item.mediaKit) {
    item.mediaKit = normalizeMediaKit(null, null);
  }

  if (!item.mediaKitLink) {
    item.mediaKitLink = normalizeMediaKitLink(null, null);
  }

  if (item.mediaKit.showToBrand) {
    item.mediaKit.requestStatus = 'approved';
  }

  if (item.mediaKitLink.showToBrand) {
    item.mediaKitLink.requestStatus = 'approved';
  }

  ensureSingleSharedMediaKit(item);
}

function setVisibleMediaKitSource(item, source, actorId = null) {
  const reviewedAt = new Date();

  if (!item.mediaKit) {
    item.mediaKit = normalizeMediaKit(null, actorId);
  }

  if (!item.mediaKitLink) {
    item.mediaKitLink = normalizeMediaKitLink(null, actorId);
  }

  if (source === 'pdf') {
    if (!hasStoredMediaKit(item.mediaKit)) {
      throw new Error('No MediaKit PDF uploaded for this influencer yet');
    }

    item.mediaKit.showToBrand = true;
    item.mediaKit.requestStatus = 'approved';
    item.mediaKit.reviewedAt = reviewedAt;
    item.mediaKit.reviewedByAdminId = actorId || null;

    item.mediaKitLink.showToBrand = false;
    item.mediaKitLink.requestStatus = 'none';
    item.mediaKitLink.reviewedAt = reviewedAt;
    item.mediaKitLink.reviewedByAdminId = actorId || null;

    return;
  }

  if (source === 'link') {
    if (!hasMediaKitLink(item.mediaKitLink)) {
      throw new Error('No media kit link generated for this influencer yet');
    }

    item.mediaKitLink.showToBrand = true;
    item.mediaKitLink.requestStatus = 'approved';
    item.mediaKitLink.reviewedAt = reviewedAt;
    item.mediaKitLink.reviewedByAdminId = actorId || null;

    item.mediaKit.showToBrand = false;
    item.mediaKit.requestStatus = 'none';
    item.mediaKit.reviewedAt = reviewedAt;
    item.mediaKit.reviewedByAdminId = actorId || null;

    return;
  }

  item.mediaKit.showToBrand = false;
  item.mediaKit.requestStatus = 'none';
  item.mediaKit.reviewedAt = reviewedAt;
  item.mediaKit.reviewedByAdminId = actorId || null;

  item.mediaKitLink.showToBrand = false;
  item.mediaKitLink.requestStatus = 'none';
  item.mediaKitLink.reviewedAt = reviewedAt;
  item.mediaKitLink.reviewedByAdminId = actorId || null;
}

function markSpecificMediaKitHidden(item, source, actorId = null) {
  const reviewedAt = new Date();

  if (source === 'pdf') {
    if (!item.mediaKit) item.mediaKit = normalizeMediaKit(null, actorId);
    item.mediaKit.showToBrand = false;
    if (cleanStr(item.mediaKit.requestStatus).toLowerCase() === 'approved') {
      item.mediaKit.requestStatus = 'none';
    }
    item.mediaKit.reviewedAt = reviewedAt;
    item.mediaKit.reviewedByAdminId = actorId || null;
    return;
  }

  if (source === 'link') {
    if (!item.mediaKitLink) item.mediaKitLink = normalizeMediaKitLink(null, actorId);
    item.mediaKitLink.showToBrand = false;
    if (cleanStr(item.mediaKitLink.requestStatus).toLowerCase() === 'approved') {
      item.mediaKitLink.requestStatus = 'none';
    }
    item.mediaKitLink.reviewedAt = reviewedAt;
    item.mediaKitLink.reviewedByAdminId = actorId || null;
  }
}

async function buildSharedMediaKitAccess(item) {
  const hasAdded = hasStoredMediaKit(item?.mediaKit) || hasMediaKitLink(item?.mediaKitLink);
  const allowedSource = getVisibleMediaKitSource(item);
  const allowed = !!allowedSource;

  let url = '';

  if (allowedSource === 'pdf') {
    try {
      url = await createMediaKitReadUrl(item.mediaKit.s3Key);
    } catch (err) {
      url = '';
    }
  } else if (allowedSource === 'link') {
    url = item?.mediaKitLink?.url || '';
  }

  const requestStatus = allowed ? 'approved' : getGenericMediaKitRequestStatus(item);

  return {
    hasAdded,
    allowed,
    availableOnRequest: !allowed,
    requestStatus,
    requestedAt: getGenericMediaKitRequestedAt(item),
    buttonLabel: allowed
      ? ''
      : requestStatus === 'requested'
        ? 'Requested'
        : 'Request',
    url: allowed ? url : '',
  };
}

function getS3Bucket() {
  return cleanStr(process.env.AWS_S3_BUCKET || process.env.S3_BUCKET);
}

function getMediaKitS3Client() {
  if (s3ClientSingleton) return s3ClientSingleton;

  const region = cleanStr(process.env.AWS_REGION || process.env.S3_REGION);
  const bucket = getS3Bucket();
  const accessKeyId = cleanStr(process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID);
  const secretAccessKey = cleanStr(process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY);

  if (!region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'S3 is not configured. Please set AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY'
    );
  }

  s3ClientSingleton = new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return s3ClientSingleton;
}

function sanitizeFileName(fileName) {
  const ext = cleanStr(fileName).toLowerCase().endsWith('.pdf') ? '.pdf' : '.pdf';
  const base =
    cleanStr(fileName)
      .replace(/\.pdf$/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/(^-|-$)/g, '') || 'media-kit';

  return `${base}${ext}`;
}

function buildMediaKitS3Key(folderId, fileName) {
  const safeName = sanitizeFileName(fileName);
  return `pitch-folders/${folderId}/media-kits/${Date.now()}-${crypto
    .randomBytes(8)
    .toString('hex')}-${safeName}`;
}

async function createMediaKitUploadUrl({ key, contentType }) {
  const bucket = getS3Bucket();
  const client = getMediaKitS3Client();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn: 900 });
}

async function createMediaKitReadUrl(key) {
  if (!cleanStr(key)) return '';

  const bucket = getS3Bucket();
  const client = getMediaKitS3Client();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return getSignedUrl(client, command, { expiresIn: 3600 });
}

function normalizeMediaKitLink(input, actorId, currentMediaKitLink = null) {
  if (input === null) {
    return {
      url: '',
      generatedAt: null,
      generatedByAdminId: null,
      showToBrand: false,
      requestStatus: 'none',
      requestedAt: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    };
  }

  const source = input && typeof input === 'object' ? input : {};
  const current = currentMediaKitLink || {};

  const url = cleanStr(hasOwn(source, 'url') ? source.url : current.url);

  let generatedAt = hasOwn(source, 'generatedAt') ? source.generatedAt : current.generatedAt;
  generatedAt = generatedAt ? new Date(generatedAt) : null;

  const showToBrand = hasOwn(source, 'showToBrand') ? !!source.showToBrand : !!current.showToBrand;

  let requestStatus = cleanStr(
    hasOwn(source, 'requestStatus') ? source.requestStatus : current.requestStatus
  ).toLowerCase();

  if (!MEDIA_KIT_REQUEST_STATUSES.includes(requestStatus)) {
    requestStatus = 'none';
  }

  let requestedAt = hasOwn(source, 'requestedAt') ? source.requestedAt : current.requestedAt;
  requestedAt = requestedAt ? new Date(requestedAt) : null;

  let reviewedAt = hasOwn(source, 'reviewedAt') ? source.reviewedAt : current.reviewedAt;
  reviewedAt = reviewedAt ? new Date(reviewedAt) : null;

  const reviewedByAdminId =
    hasOwn(source, 'reviewedByAdminId') && mongoose.Types.ObjectId.isValid(String(source.reviewedByAdminId))
      ? new mongoose.Types.ObjectId(String(source.reviewedByAdminId))
      : current.reviewedByAdminId || null;

  if (!url) {
    return {
      url: '',
      generatedAt: null,
      generatedByAdminId: null,
      showToBrand: false,
      requestStatus: 'none',
      requestedAt: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    };
  }

  if (showToBrand) {
    requestStatus = 'approved';
    if (!reviewedAt) reviewedAt = new Date();
  }

  if (requestStatus === 'requested' && !requestedAt) {
    requestedAt = new Date();
  }

  return {
    url,
    generatedAt: generatedAt || current.generatedAt || new Date(),
    generatedByAdminId:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : current.generatedByAdminId || null,
    showToBrand,
    requestStatus,
    requestedAt,
    reviewedAt,
    reviewedByAdminId,
  };
}

function normalizeMediaKit(input, actorId, currentMediaKit = null) {
  if (input === null) {
    return {
      s3Key: '',
      fileName: '',
      mimeType: 'application/pdf',
      size: null,
      uploadedAt: null,
      uploadedByAdminId: null,
      showToBrand: false,
      requestStatus: 'none',
      requestedAt: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    };
  }

  const source = input && typeof input === 'object' ? input : {};
  const current = currentMediaKit || {};

  const s3Key = cleanStr(hasOwn(source, 's3Key') ? source.s3Key : current.s3Key);
  const fileName = cleanStr(hasOwn(source, 'fileName') ? source.fileName : current.fileName);
  const mimeType = cleanStr(hasOwn(source, 'mimeType') ? source.mimeType : current.mimeType) || 'application/pdf';
  const size = hasOwn(source, 'size') ? toNullableNumber(source.size) : toNullableNumber(current.size);

  let uploadedAt = hasOwn(source, 'uploadedAt') ? source.uploadedAt : current.uploadedAt;
  uploadedAt = uploadedAt ? new Date(uploadedAt) : null;

  const showToBrand = hasOwn(source, 'showToBrand') ? !!source.showToBrand : !!current.showToBrand;

  let requestStatus = cleanStr(
    hasOwn(source, 'requestStatus') ? source.requestStatus : current.requestStatus
  ).toLowerCase();

  if (!MEDIA_KIT_REQUEST_STATUSES.includes(requestStatus)) {
    requestStatus = 'none';
  }

  let requestedAt = hasOwn(source, 'requestedAt') ? source.requestedAt : current.requestedAt;
  requestedAt = requestedAt ? new Date(requestedAt) : null;

  let reviewedAt = hasOwn(source, 'reviewedAt') ? source.reviewedAt : current.reviewedAt;
  reviewedAt = reviewedAt ? new Date(reviewedAt) : null;

  const reviewedByAdminId =
    hasOwn(source, 'reviewedByAdminId') && mongoose.Types.ObjectId.isValid(String(source.reviewedByAdminId))
      ? new mongoose.Types.ObjectId(String(source.reviewedByAdminId))
      : current.reviewedByAdminId || null;

  if (!s3Key) {
    return {
      s3Key: '',
      fileName: '',
      mimeType: 'application/pdf',
      size: null,
      uploadedAt: null,
      uploadedByAdminId: null,
      showToBrand: false,
      requestStatus: 'none',
      requestedAt: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    };
  }

  if (showToBrand) {
    requestStatus = 'approved';
    if (!reviewedAt) reviewedAt = new Date();
  }

  if (requestStatus === 'requested' && !requestedAt) {
    requestedAt = new Date();
  }

  return {
    s3Key,
    fileName: fileName || 'media-kit.pdf',
    mimeType: mimeType || 'application/pdf',
    size,
    uploadedAt: uploadedAt || new Date(),
    uploadedByAdminId:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : current.uploadedByAdminId || null,
    showToBrand,
    requestStatus,
    requestedAt,
    reviewedAt,
    reviewedByAdminId,
  };
}

function pushRateCardHistory(item, field, previousValue, newValue, actorId) {
  const prev = cleanStr(previousValue);
  const next = cleanStr(newValue);

  if (prev === next) return;

  if (!Array.isArray(item.rateCardHistory)) {
    item.rateCardHistory = [];
  }

  item.rateCardHistory.push({
    field,
    previousValue: prev,
    newValue: next,
    changedAt: new Date(),
    changedByAdminId:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
  });
}

function normalizeItem(body = {}, actorId = null) {
  const links = Array.isArray(body.links)
    ? uniqStrings(body.links)
    : uniqStrings(String(body.links || '').split(','));

  const primaryLink = cleanStr(body.primaryLink) || (links.length ? links[0] : '');

  const niche = Array.isArray(body.niche)
    ? uniqStrings(body.niche)
    : uniqStrings(String(body.niche || '').split(','));

  const item = {
    provider: normalizeProvider(body.provider),
    name: cleanStr(body.name),
    handle: cleanStr(body.handle).replace(/^@+/, '@'),
    followers: toNullableNumber(body.followers),
    primaryLink,
    links,
    niche,
    email: cleanStr(body.email).toLowerCase(),
    country: cleanStr(body.country),
    selectionReason: cleanStr(body.selectionReason),
    goodFit: !!body.goodFit,
    influencerRateCard: cleanStr(body.influencerRateCard),
    platformRateCard: cleanStr(body.platformRateCard),
    rateCardCurrency: cleanStr(body.rateCardCurrency || 'USD').toUpperCase(),
    rateCardHistory: [],
    ourFeePct: toNullableNumber(body.ourFeePct),
    shippingAddress: cleanStr(body.shippingAddress || body.comments),
    mediaKit: normalizeMediaKit(body.mediaKit, actorId),
    mediaKitLink: normalizeMediaKitLink(body.mediaKitLink, actorId),
    sourcePipelineId:
      body.sourcePipelineId && mongoose.Types.ObjectId.isValid(String(body.sourcePipelineId))
        ? new mongoose.Types.ObjectId(String(body.sourcePipelineId))
        : null,
    updatedByAdmin: actorId || null,
  };

  ensureGenericRequestConsistency(item);
  return item;
}

function applyItemMutations(item, body = {}, actorId = null) {
  if (hasOwn(body, 'provider')) item.provider = normalizeProvider(body.provider);
  if (hasOwn(body, 'name')) item.name = cleanStr(body.name);
  if (hasOwn(body, 'handle')) item.handle = cleanStr(body.handle).replace(/^@+/, '@');
  if (hasOwn(body, 'followers')) item.followers = toNullableNumber(body.followers);

  if (hasOwn(body, 'links')) {
    item.links = Array.isArray(body.links)
      ? uniqStrings(body.links)
      : uniqStrings(String(body.links || '').split(','));
  }

  if (hasOwn(body, 'primaryLink')) {
    item.primaryLink = cleanStr(body.primaryLink);
  } else if (hasOwn(body, 'links') && !cleanStr(item.primaryLink) && item.links.length) {
    item.primaryLink = item.links[0];
  }

  if (hasOwn(body, 'niche')) {
    item.niche = Array.isArray(body.niche)
      ? uniqStrings(body.niche)
      : uniqStrings(String(body.niche || '').split(','));
  }

  if (hasOwn(body, 'email')) item.email = cleanStr(body.email).toLowerCase();
  if (hasOwn(body, 'country')) item.country = cleanStr(body.country);
  if (hasOwn(body, 'selectionReason')) item.selectionReason = cleanStr(body.selectionReason);
  if (hasOwn(body, 'goodFit')) item.goodFit = !!body.goodFit;

  if (hasOwn(body, 'influencerRateCard')) {
    const next = cleanStr(body.influencerRateCard);
    pushRateCardHistory(item, 'influencerRateCard', item.influencerRateCard, next, actorId);
    item.influencerRateCard = next;
  }

  if (hasOwn(body, 'platformRateCard')) {
    const next = cleanStr(body.platformRateCard);
    pushRateCardHistory(item, 'platformRateCard', item.platformRateCard, next, actorId);
    item.platformRateCard = next;
  }

  if (hasOwn(body, 'rateCardCurrency')) {
    item.rateCardCurrency = cleanStr(body.rateCardCurrency || 'USD').toUpperCase();
  }

  if (hasOwn(body, 'ourFeePct')) item.ourFeePct = toNullableNumber(body.ourFeePct);

  if (hasOwn(body, 'shippingAddress') || hasOwn(body, 'comments')) {
    item.shippingAddress = cleanStr(
      hasOwn(body, 'shippingAddress') ? body.shippingAddress : body.comments
    );
  }

  if (hasOwn(body, 'sourcePipelineId')) {
    item.sourcePipelineId =
      body.sourcePipelineId && mongoose.Types.ObjectId.isValid(String(body.sourcePipelineId))
        ? new mongoose.Types.ObjectId(String(body.sourcePipelineId))
        : null;
  }

  if (hasOwn(body, 'mediaKit')) {
    item.mediaKit = normalizeMediaKit(body.mediaKit, actorId, item.mediaKit || null);
  }

  if (hasOwn(body, 'mediaKitLink')) {
    item.mediaKitLink = normalizeMediaKitLink(body.mediaKitLink, actorId, item.mediaKitLink || null);
  }

  if (hasOwn(body, 'removeMediaKit') && !!body.removeMediaKit) {
    item.mediaKit = normalizeMediaKit(null, actorId);
  }

  if (hasOwn(body, 'removeMediaKitLink') && !!body.removeMediaKitLink) {
    item.mediaKitLink = normalizeMediaKitLink(null, actorId);
  }

  const preferredSource =
    hasOwn(body, 'mediaKitLink') && body?.mediaKitLink?.showToBrand
      ? 'link'
      : hasOwn(body, 'mediaKit') && body?.mediaKit?.showToBrand
        ? 'pdf'
        : '';

  ensureSingleSharedMediaKit(item, preferredSource);
  ensureGenericRequestConsistency(item);

  item.updatedByAdmin = actorId || null;
}

function getShareBaseUrl() {
  return process.env.PITCH_FOLDER_SHARE_BASE_URL || 'https://collabglam.com/pitch-folder/shared';
}

function buildCreatorPopulate() {
  return {
    path: 'createdByAdmin',
    select: 'name email proxyEmail role teamType status parentAdmin rootAdmin createdBy',
    populate: [
      { path: 'parentAdmin', select: 'name email role teamType' },
      { path: 'rootAdmin', select: 'name email role teamType' },
      { path: 'createdBy', select: 'name email role teamType' },
    ],
  };
}

function buildUpdatedByPopulate() {
  return {
    path: 'updatedByAdmin',
    select: 'name email proxyEmail role teamType status parentAdmin rootAdmin createdBy',
    populate: [
      { path: 'parentAdmin', select: 'name email role teamType' },
      { path: 'rootAdmin', select: 'name email role teamType' },
      { path: 'createdBy', select: 'name email role teamType' },
    ],
  };
}

function buildSharedByPopulate() {
  return {
    path: 'share.sharedByAdminId',
    select: 'name email role teamType',
  };
}

function serializeMiniAdmin(admin) {
  if (!admin) return null;

  return {
    _id: String(admin._id),
    adminId: String(admin._id),
    name: admin.name || '',
    email: admin.email || '',
    role: cleanStr(admin.role).toLowerCase(),
    designation: toDesignation(admin.role),
    teamType: admin.teamType || null,
  };
}

function serializeAdmin(admin) {
  if (!admin) return null;

  return {
    _id: String(admin._id),
    adminId: String(admin._id),
    name: admin.name || '',
    email: admin.email || '',
    proxyEmail: admin.proxyEmail || '',
    role: cleanStr(admin.role).toLowerCase(),
    designation: toDesignation(admin.role),
    teamType: admin.teamType || null,
    status: cleanStr(admin.status).toLowerCase(),
    parentAdmin: serializeMiniAdmin(admin.parentAdmin),
    rootAdmin: serializeMiniAdmin(admin.rootAdmin),
    createdBy: serializeMiniAdmin(admin.createdBy),
  };
}

function applyFolderSearch(filter, q) {
  if (!q) return filter;

  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  return {
    ...filter,
    $or: [{ title: rx }, { description: rx }, { slug: rx }, { 'items.name': rx }, { 'items.handle': rx }, { 'items.email': rx }],
  };
}

async function getAccessibleCreatorIds(actor) {
  if (!canCreateOrManagePitchFolders(actor)) return [];

  const actorId = getActorAdminId(actor);
  if (!actorId || !mongoose.Types.ObjectId.isValid(String(actorId))) return [];

  const actorObjectId = new mongoose.Types.ObjectId(String(actorId));

  if (isSuperAdmin(actor)) {
    const admins = await AdminModel.find({
      role: { $in: [ROLES.SUPER_ADMIN, ROLES.REVENUE_HEAD, ROLES.IME] },
      status: 'active',
    })
      .select('_id')
      .lean();

    return admins.map((a) => a._id);
  }

  if (isRevenueHead(actor)) {
    const imeAdmins = await AdminModel.find({
      role: ROLES.IME,
      status: 'active',
      parentAdmin: actorObjectId,
    })
      .select('_id')
      .lean();

    return [actorObjectId, ...imeAdmins.map((a) => a._id)];
  }

  if (isIme(actor)) {
    return [actorObjectId];
  }

  return [];
}

async function buildFolderAccessFilter(actor) {
  if (!canCreateOrManagePitchFolders(actor)) return null;

  if (isSuperAdmin(actor)) {
    return { archivedAt: null };
  }

  const creatorIds = await getAccessibleCreatorIds(actor);

  return {
    archivedAt: null,
    createdByAdmin: { $in: creatorIds },
  };
}

async function findAccessibleFolder(folderId, actor) {
  const scope = await buildFolderAccessFilter(actor);
  if (!scope) return null;

  return PitchFolder.findOne({
    _id: folderId,
    ...scope,
  })
    .populate(buildCreatorPopulate())
    .populate(buildUpdatedByPopulate())
    .populate(buildSharedByPopulate())
    .exec();
}

function serializeFolderItemForAdmin(item) {
  return {
    _id: item._id,
    provider: item.provider,
    name: item.name,
    handle: item.handle,
    followers: item.followers,
    primaryLink: item.primaryLink,
    links: item.links || [],
    niche: item.niche || [],
    email: item.email,
    country: item.country,
    selectionReason: item.selectionReason,
    goodFit: item.goodFit,
    influencerRateCard: item.influencerRateCard || '',
    platformRateCard: item.platformRateCard || '',
    rateCardCurrency: item.rateCardCurrency || 'USD',
    ourFeePct: item.ourFeePct,
    shippingAddress: item.shippingAddress || item.comments || '',

    mediaKitAccess: {
      hasAdded: hasStoredMediaKit(item.mediaKit) || hasMediaKitLink(item.mediaKitLink),
      allowed: !!getVisibleMediaKitSource(item),
      visibleSource: getVisibleMediaKitSource(item) || null,
      requestStatus: getGenericMediaKitRequestStatus(item),
      requestedAt: getGenericMediaKitRequestedAt(item),
    },

    mediaKitLink: item.mediaKitLink
      ? {
        url: item.mediaKitLink.url || '',
        generatedAt: item.mediaKitLink.generatedAt || null,
        showToBrand: !!item.mediaKitLink.showToBrand,
        requestStatus: item.mediaKitLink.requestStatus || 'none',
        requestedAt: item.mediaKitLink.requestedAt || null,
        reviewedAt: item.mediaKitLink.reviewedAt || null,
      }
      : null,

    mediaKit: item.mediaKit
      ? {
        s3Key: item.mediaKit.s3Key || '',
        fileName: item.mediaKit.fileName || '',
        mimeType: item.mediaKit.mimeType || 'application/pdf',
        size: item.mediaKit.size,
        uploadedAt: item.mediaKit.uploadedAt || null,
        showToBrand: !!item.mediaKit.showToBrand,
        requestStatus: item.mediaKit.requestStatus || 'none',
        requestedAt: item.mediaKit.requestedAt || null,
        reviewedAt: item.mediaKit.reviewedAt || null,
      }
      : null,

    rateCardHistory: Array.isArray(item.rateCardHistory)
      ? item.rateCardHistory
        .slice()
        .sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime())
        .map((entry) => ({
          _id: entry._id,
          field: entry.field,
          previousValue: entry.previousValue || '',
          newValue: entry.newValue || '',
          changedAt: entry.changedAt || null,
          changedByAdminId: entry.changedByAdminId ? String(entry.changedByAdminId) : null,
        }))
      : [],
    sourcePipelineId: item.sourcePipelineId || null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

async function serializeFolderItemForShared(item) {
  ensureSingleSharedMediaKit(item);
  ensureGenericRequestConsistency(item);

  const mediaKitAccess = await buildSharedMediaKitAccess(item);

  return {
    _id: item._id,
    provider: item.provider,
    name: item.name,
    handle: item.handle,
    followers: item.followers,
    primaryLink: item.primaryLink,
    links: item.links || [],
    niche: item.niche || [],
    email: item.email,
    country: item.country,
    selectionReason: item.selectionReason,
    goodFit: item.goodFit,
    influencerRateCard: item.influencerRateCard || '',
    platformRateCard: item.platformRateCard || '',
    rateCardCurrency: item.rateCardCurrency || 'USD',
    mediaKitAccess,
  };
}

function serializeFolderListItem(doc) {
  return {
    _id: doc._id,
    title: doc.title,
    slug: doc.slug,
    description: doc.description,
    brandVisibleItemCount:
      doc.brandVisibleItemCount === null || doc.brandVisibleItemCount === undefined
        ? Array.isArray(doc.items)
          ? doc.items.length
          : 0
        : doc.brandVisibleItemCount,
    showFullListToBrand: !!doc.showFullListToBrand,
    share: doc.share
      ? {
        token: doc.share.token || '',
        url: doc.share.url || '',
        generatedAt: doc.share.generatedAt || null,
        sharedBy: serializeMiniAdmin(doc.share.sharedByAdminId),
      }
      : {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    itemCount: Array.isArray(doc.items) ? doc.items.length : 0,
    createdBy: serializeAdmin(doc.createdByAdmin),
    updatedBy: serializeAdmin(doc.updatedByAdmin),
  };
}

function serializeFolderDetail(doc) {
  const sortedItems = sortFolderItemsByMediaKitPriority(
    Array.isArray(doc.items) ? doc.items : []
  );

  return {
    _id: doc._id,
    title: doc.title,
    slug: doc.slug,
    description: doc.description,
    brandVisibleItemCount:
      doc.brandVisibleItemCount === null || doc.brandVisibleItemCount === undefined
        ? Array.isArray(doc.items)
          ? doc.items.length
          : 0
        : doc.brandVisibleItemCount,
    showFullListToBrand: !!doc.showFullListToBrand,
    share: doc.share
      ? {
        token: doc.share.token || '',
        url: doc.share.url || '',
        generatedAt: doc.share.generatedAt || null,
        sharedBy: serializeMiniAdmin(doc.share.sharedByAdminId),
      }
      : {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: serializeAdmin(doc.createdByAdmin),
    updatedBy: serializeAdmin(doc.updatedByAdmin),
    items: sortedItems.map(serializeFolderItemForAdmin),
  };
}

async function saveAndHydrateFolder(doc) {
  await doc.save();

  return PitchFolder.findById(doc._id)
    .populate(buildCreatorPopulate())
    .populate(buildUpdatedByPopulate())
    .populate(buildSharedByPopulate())
    .lean();
}

exports.listFolders = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to access pitch folders' });
    }

    const q = cleanStr(req.query.q);
    const baseFilter = await buildFolderAccessFilter(req.admin);

    if (!baseFilter) {
      return res.status(403).json({ error: 'You are not allowed to access pitch folders' });
    }

    const filter = applyFolderSearch(baseFilter, q);

    const docs = await PitchFolder.find(filter)
      .populate(buildCreatorPopulate())
      .populate(buildUpdatedByPopulate())
      .populate(buildSharedByPopulate())
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: docs.map(serializeFolderListItem),
    });
  } catch (err) {
    console.error('[listFolders] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

async function buildUniqueFolderSlug(title, excludeFolderId = null) {
  const baseSlug = slugify(title) || `pitch-folder-${Date.now()}`;
  let slug = baseSlug;
  let counter = 1;

  while (
    await PitchFolder.exists({
      ...(excludeFolderId ? { _id: { $ne: excludeFolderId } } : {}),
      slug,
      archivedAt: null,
    })
  ) {
    counter += 1;
    slug = `${baseSlug}-${counter}`;
  }

  return slug;
}

function resetDuplicatedMediaKitState(mediaKit) {
  const next = normalizeMediaKit(mediaKit || null, null, mediaKit || null);

  if (!hasStoredMediaKit(next)) {
    return normalizeMediaKit(null, null);
  }

  next.showToBrand = false;
  next.requestStatus = 'none';
  next.requestedAt = null;
  next.reviewedAt = null;
  next.reviewedByAdminId = null;

  return next;
}

function resetDuplicatedMediaKitLinkState(mediaKitLink) {
  const next = normalizeMediaKitLink(mediaKitLink || null, null, mediaKitLink || null);

  if (!hasMediaKitLink(next)) {
    return normalizeMediaKitLink(null, null);
  }

  next.showToBrand = false;
  next.requestStatus = 'none';
  next.requestedAt = null;
  next.reviewedAt = null;
  next.reviewedByAdminId = null;

  return next;
}

function cloneFolderItemForTransfer(item, actorId = null) {
  const source = typeof item?.toObject === 'function' ? item.toObject() : item || {};

  const clonedItem = {
    provider: normalizeProvider(source.provider),
    name: cleanStr(source.name),
    handle: cleanStr(source.handle).replace(/^@+/, '@'),
    followers: toNullableNumber(source.followers),

    primaryLink: cleanStr(source.primaryLink),
    links: Array.isArray(source.links) ? uniqStrings(source.links) : [],

    niche: Array.isArray(source.niche) ? uniqStrings(source.niche) : [],
    email: cleanStr(source.email).toLowerCase(),
    country: cleanStr(source.country),

    selectionReason: cleanStr(source.selectionReason),
    goodFit: !!source.goodFit,

    influencerRateCard: cleanStr(source.influencerRateCard),
    platformRateCard: cleanStr(source.platformRateCard),
    rateCardCurrency: cleanStr(source.rateCardCurrency || 'USD').toUpperCase(),

    ourFeePct: toNullableNumber(source.ourFeePct),
    shippingAddress: cleanStr(source.shippingAddress || source.comments),

    mediaKit: normalizeMediaKit(source.mediaKit || null, actorId, source.mediaKit || null),
    mediaKitLink: normalizeMediaKitLink(
      source.mediaKitLink || null,
      actorId,
      source.mediaKitLink || null
    ),

    rateCardHistory: Array.isArray(source.rateCardHistory)
      ? source.rateCardHistory.map((entry) => ({
          field: cleanStr(entry.field),
          previousValue: cleanStr(entry.previousValue),
          newValue: cleanStr(entry.newValue),
          changedAt: entry?.changedAt ? new Date(entry.changedAt) : new Date(),
          changedByAdminId:
            entry?.changedByAdminId &&
            mongoose.Types.ObjectId.isValid(String(entry.changedByAdminId))
              ? new mongoose.Types.ObjectId(String(entry.changedByAdminId))
              : null,
        }))
      : [],

    sourcePipelineId:
      source?.sourcePipelineId &&
      mongoose.Types.ObjectId.isValid(String(source.sourcePipelineId))
        ? new mongoose.Types.ObjectId(String(source.sourcePipelineId))
        : null,

    createdByAdmin:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
    updatedByAdmin:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
  };

  ensureSingleSharedMediaKit(clonedItem);
  ensureGenericRequestConsistency(clonedItem);

  return clonedItem;
}

function cloneFolderItemForDuplicate(item, actorId = null) {
  const source = typeof item?.toObject === 'function' ? item.toObject() : item || {};

  const clonedItem = {
    provider: normalizeProvider(source.provider),
    name: cleanStr(source.name),
    handle: cleanStr(source.handle).replace(/^@+/, '@'),
    followers: toNullableNumber(source.followers),

    primaryLink: cleanStr(source.primaryLink),
    links: Array.isArray(source.links) ? uniqStrings(source.links) : [],

    niche: Array.isArray(source.niche) ? uniqStrings(source.niche) : [],
    email: cleanStr(source.email).toLowerCase(),
    country: cleanStr(source.country),

    selectionReason: cleanStr(source.selectionReason),
    goodFit: false,

    influencerRateCard: cleanStr(source.influencerRateCard),
    platformRateCard: cleanStr(source.platformRateCard),
    rateCardCurrency: cleanStr(source.rateCardCurrency || 'USD').toUpperCase(),

    ourFeePct: toNullableNumber(source.ourFeePct),
    shippingAddress: cleanStr(source.shippingAddress || source.comments),

    mediaKit: resetDuplicatedMediaKitState(source.mediaKit),
    mediaKitLink: resetDuplicatedMediaKitLinkState(source.mediaKitLink),

    rateCardHistory: Array.isArray(source.rateCardHistory)
      ? source.rateCardHistory.map((entry) => ({
        field: cleanStr(entry.field),
        previousValue: cleanStr(entry.previousValue),
        newValue: cleanStr(entry.newValue),
        changedAt: entry?.changedAt ? new Date(entry.changedAt) : new Date(),
        changedByAdminId:
          entry?.changedByAdminId &&
            mongoose.Types.ObjectId.isValid(String(entry.changedByAdminId))
            ? new mongoose.Types.ObjectId(String(entry.changedByAdminId))
            : null,
      }))
      : [],

    sourcePipelineId:
      source?.sourcePipelineId &&
        mongoose.Types.ObjectId.isValid(String(source.sourcePipelineId))
        ? new mongoose.Types.ObjectId(String(source.sourcePipelineId))
        : null,

    createdByAdmin:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
    updatedByAdmin:
      actorId && mongoose.Types.ObjectId.isValid(String(actorId))
        ? new mongoose.Types.ObjectId(String(actorId))
        : null,
  };

  ensureSingleSharedMediaKit(clonedItem);
  ensureGenericRequestConsistency(clonedItem);

  return clonedItem;
}

exports.createFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to create pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const body = req.body || {};

    const title = cleanStr(body.title);
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const baseSlug = slugify(title) || `pitch-folder-${Date.now()}`;
    let slug = baseSlug;
    let counter = 1;

    while (await PitchFolder.exists({ slug, archivedAt: null })) {
      counter += 1;
      slug = `${baseSlug}-${counter}`;
    }

    const initialItems = Array.isArray(body.items)
      ? body.items.map((item) => ({
        ...normalizeItem(item, actorId),
        createdByAdmin: actorId || null,
      }))
      : [];

    const doc = await PitchFolder.create({
      title,
      slug,
      description: cleanStr(body.description),
      brandVisibleItemCount: hasOwn(body, 'brandVisibleItemCount')
        ? toNullableInteger(body.brandVisibleItemCount)
        : null,
      showFullListToBrand: hasOwn(body, 'showFullListToBrand') ? !!body.showFullListToBrand : true,
      items: initialItems,
      createdByAdmin: actorId || null,
      updatedByAdmin: actorId || null,
    });

    const hydrated = await PitchFolder.findById(doc._id)
      .populate(buildCreatorPopulate())
      .populate(buildUpdatedByPopulate())
      .populate(buildSharedByPopulate())
      .lean();

    return res.json({
      success: true,
      message: 'Pitch folder created successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[createFolder] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.getFolderById = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to access pitch folders' });
    }

    const id = cleanStr(req.params.id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);

    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    return res.json({
      success: true,
      data: serializeFolderDetail(doc),
    });
  } catch (err) {
    console.error('[getFolderById] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const body = req.body || {};
    const id = cleanStr(body.id || body.folderId || req.params?.id);

    const hasTitle = hasOwn(body, 'title');
    const hasDescription = hasOwn(body, 'description');
    const hasBrandVisibleItemCount = hasOwn(body, 'brandVisibleItemCount');
    const hasShowFullListToBrand = hasOwn(body, 'showFullListToBrand');

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    if (
      !hasTitle &&
      !hasDescription &&
      !hasBrandVisibleItemCount &&
      !hasShowFullListToBrand
    ) {
      return res.status(400).json({
        error:
          'At least one of title, description, brandVisibleItemCount, or showFullListToBrand must be provided',
      });
    }

    if (hasTitle && !cleanStr(body.title)) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    if (hasTitle) {
      const nextTitle = cleanStr(body.title);
      doc.title = nextTitle;
      doc.slug = await buildUniqueFolderSlug(nextTitle, doc._id);
    }

    if (hasDescription) {
      doc.description = cleanStr(body.description);
    }

    if (hasBrandVisibleItemCount) {
      const rawCount = body.brandVisibleItemCount;

      if (rawCount === '' || rawCount === null || rawCount === undefined) {
        doc.brandVisibleItemCount = null;
      } else {
        const parsedCount = toNullableInteger(rawCount);

        if (parsedCount === null) {
          return res.status(400).json({
            error: 'brandVisibleItemCount must be a non-negative integer or null',
          });
        }

        doc.brandVisibleItemCount = parsedCount;
      }
    }

    if (hasShowFullListToBrand) {
      doc.showFullListToBrand = !!body.showFullListToBrand;
    }

    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Pitch folder updated successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[updateFolder] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.duplicateFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to duplicate pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const body = req.body || {};
    const sourceFolderId = cleanStr(body.folderId || body.id || req.params?.id);

    if (!mongoose.Types.ObjectId.isValid(sourceFolderId)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const sourceDoc = await findAccessibleFolder(sourceFolderId, req.admin);
    if (!sourceDoc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const duplicateTitle = cleanStr(body.title) || `${cleanStr(sourceDoc.title)} Copy`;
    const duplicateSlug = await buildUniqueFolderSlug(duplicateTitle);

    const duplicatedItems = Array.isArray(sourceDoc.items)
      ? sourceDoc.items.map((item) => cloneFolderItemForDuplicate(item, actorId))
      : [];

    const duplicatedFolder = await PitchFolder.create({
      title: duplicateTitle,
      slug: duplicateSlug,
      description: cleanStr(sourceDoc.description),

      // keep folder-level visibility settings
      brandVisibleItemCount:
        sourceDoc.brandVisibleItemCount === null || sourceDoc.brandVisibleItemCount === undefined
          ? null
          : toNullableInteger(sourceDoc.brandVisibleItemCount),

      showFullListToBrand: !!sourceDoc.showFullListToBrand,

      // deep duplicate items
      items: duplicatedItems,

      // never duplicate share token / URL
      share: {
        token: '',
        url: '',
        generatedAt: null,
        sharedByAdminId: null,
      },

      createdByAdmin: actorId || null,
      updatedByAdmin: actorId || null,
    });

    const hydrated = await PitchFolder.findById(duplicatedFolder._id)
      .populate(buildCreatorPopulate())
      .populate(buildUpdatedByPopulate())
      .populate(buildSharedByPopulate())
      .lean();

    return res.json({
      success: true,
      message: 'Pitch folder duplicated successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[duplicateFolder] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.archiveFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to archive pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const id = cleanStr(req.body?.id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    doc.archivedAt = new Date();
    doc.updatedByAdmin = actorId || null;
    await doc.save();

    return res.json({
      success: true,
      message: 'Pitch folder archived successfully',
    });
  } catch (err) {
    console.error('[archiveFolder] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.addFolderItem = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.params.id);

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = {
      ...normalizeItem(req.body || {}, actorId),
      createdByAdmin: actorId || null,
    };

    if (!item.name) {
      return res.status(400).json({ error: 'Influencer name is required' });
    }

    doc.items.push(item);
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Influencer added successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[addFolderItem] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolderItem = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    applyItemMutations(item, req.body || {}, actorId);

    if (!cleanStr(item.name)) {
      return res.status(400).json({ error: 'Influencer name is required' });
    }

    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Influencer updated successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[updateFolderItem] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.deleteFolderItem = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    item.deleteOne();
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Influencer removed successfully',
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[deleteFolderItem] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.getFolderItemMediaKitUploadUrl = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to upload media kits' });
    }

    const folderId = cleanStr(req.body?.folderId);
    const fileName = cleanStr(req.body?.fileName);
    const contentType = cleanStr(req.body?.contentType).toLowerCase() || 'application/pdf';

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({ error: 'Valid folderId is required' });
    }

    const folder = await findAccessibleFolder(folderId, req.admin);
    if (!folder) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    if (contentType !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Only PDF MediaKit uploads are allowed' });
    }

    const safeFileName = sanitizeFileName(fileName);
    const key = buildMediaKitS3Key(folderId, safeFileName);

    const uploadUrl = await createMediaKitUploadUrl({
      key,
      contentType: 'application/pdf',
    });

    return res.json({
      success: true,
      data: {
        key,
        fileName: safeFileName,
        contentType: 'application/pdf',
        uploadUrl,
        expiresIn: 900,
      },
    });
  } catch (err) {
    console.error('[getFolderItemMediaKitUploadUrl] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolderItemMediaKitVisibility = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update media kit visibility' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);
    const showToBrand = !!req.body?.showToBrand;

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    if (showToBrand) {
      setVisibleMediaKitSource(item, 'pdf', actorId);
    } else {
      markSpecificMediaKitHidden(item, 'pdf', actorId);
    }

    item.updatedByAdmin = actorId || null;
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);
    const updatedItem = hydrated.items.find((x) => String(x._id) === String(itemId));

    return res.json({
      success: true,
      message: `MediaKit is now ${showToBrand ? 'visible' : 'hidden'} for brand`,
      data: {
        folderId: hydrated._id,
        itemId,
        mediaKitAccess: updatedItem?.mediaKitAccess || null,
        mediaKit: updatedItem?.mediaKit || null,
      },
    });
  } catch (err) {
    console.error('[updateFolderItemMediaKitVisibility] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolderItemMediaKitApproval = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to approve media kit requests' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);
    const action = cleanStr(req.body?.action).toLowerCase();

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    if (!hasStoredMediaKit(item.mediaKit)) {
      return res.status(400).json({ error: 'No MediaKit PDF uploaded for this influencer yet' });
    }

    if (!item.mediaKit) {
      item.mediaKit = normalizeMediaKit(null, actorId);
    }

    if (action === 'approve') {
      setVisibleMediaKitSource(item, 'pdf', actorId);
    } else {
      item.mediaKit.showToBrand = false;
      item.mediaKit.requestStatus = 'rejected';
      item.mediaKit.reviewedAt = new Date();
      item.mediaKit.reviewedByAdminId = actorId || null;
    }

    item.updatedByAdmin = actorId || null;
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);
    const updatedItem = hydrated.items.find((x) => String(x._id) === String(itemId));

    return res.json({
      success: true,
      message: `MediaKit request ${action}d successfully`,
      data: {
        folderId: hydrated._id,
        itemId,
        mediaKitAccess: updatedItem?.mediaKitAccess || null,
        mediaKit: updatedItem?.mediaKit || null,
      },
    });
  } catch (err) {
    console.error('[updateFolderItemMediaKitApproval] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolderItemMediaKitLinkVisibility = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update media kit link visibility' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);
    const showToBrand = !!req.body?.showToBrand;

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    if (showToBrand) {
      setVisibleMediaKitSource(item, 'link', actorId);
    } else {
      markSpecificMediaKitHidden(item, 'link', actorId);
    }

    item.updatedByAdmin = actorId || null;
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);
    const updatedItem = hydrated.items.find((x) => String(x._id) === String(itemId));

    return res.json({
      success: true,
      message: `Media kit link is now ${showToBrand ? 'visible' : 'hidden'} for brand`,
      data: {
        folderId: hydrated._id,
        itemId,
        mediaKitAccess: updatedItem?.mediaKitAccess || null,
        mediaKitLink: updatedItem?.mediaKitLink || null,
      },
    });
  } catch (err) {
    console.error('[updateFolderItemMediaKitLinkVisibility] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateFolderItemMediaKitLinkApproval = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to approve media kit link requests' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.body?.folderId);
    const itemId = cleanStr(req.body?.itemId);
    const action = cleanStr(req.body?.action).toLowerCase();

    if (!mongoose.Types.ObjectId.isValid(folderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid folderId and itemId are required' });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }

    const doc = await findAccessibleFolder(folderId, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    if (!hasMediaKitLink(item.mediaKitLink)) {
      return res.status(400).json({ error: 'No media kit link generated for this influencer yet' });
    }

    if (!item.mediaKitLink) {
      item.mediaKitLink = normalizeMediaKitLink(null, actorId);
    }

    if (action === 'approve') {
      setVisibleMediaKitSource(item, 'link', actorId);
    } else {
      item.mediaKitLink.showToBrand = false;
      item.mediaKitLink.requestStatus = 'rejected';
      item.mediaKitLink.reviewedAt = new Date();
      item.mediaKitLink.reviewedByAdminId = actorId || null;
    }

    item.updatedByAdmin = actorId || null;
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);
    const updatedItem = hydrated.items.find((x) => String(x._id) === String(itemId));

    return res.json({
      success: true,
      message: `Media kit link request ${action}d successfully`,
      data: {
        folderId: hydrated._id,
        itemId,
        mediaKitAccess: updatedItem?.mediaKitAccess || null,
        mediaKitLink: updatedItem?.mediaKitLink || null,
      },
    });
  } catch (err) {
    console.error('[updateFolderItemMediaKitLinkApproval] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.generateShareLink = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to share pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const id = cleanStr(req.params.id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const url = `${getShareBaseUrl()}/${token}`;

    doc.share = {
      token,
      url,
      generatedAt: new Date(),
      sharedByAdminId: actorId || null,
    };
    doc.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(doc);

    return res.json({
      success: true,
      message: 'Share link generated successfully',
      data: serializeFolderDetail(hydrated).share,
    });
  } catch (err) {
    console.error('[generateShareLink] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.getSharedFolder = async (req, res) => {
  try {
    const token = cleanStr(req.params.token);

    if (!token) {
      return res.status(400).json({ error: 'Share token is required' });
    }

    const doc = await PitchFolder.findOne({
      'share.token': token,
      archivedAt: null,
    }).lean();

    if (!doc) {
      return res.status(404).json({ error: 'Shared pitch folder not found' });
    }

    const allItems = sortFolderItemsByMediaKitPriority(
      Array.isArray(doc.items) ? doc.items : []
    );

    const configuredVisibleCount =
      doc.brandVisibleItemCount === null || doc.brandVisibleItemCount === undefined
        ? allItems.length
        : Math.max(0, Number(doc.brandVisibleItemCount) || 0);

    const itemsToShow = doc.showFullListToBrand
      ? allItems
      : allItems.slice(0, configuredVisibleCount);

    const sharedItems = await Promise.all(
      itemsToShow.map((item) => serializeFolderItemForShared(item))
    );

    return res.json({
      success: true,
      data: {
        _id: doc._id,
        title: doc.title,
        description: doc.description,
        brandVisibleItemCount: configuredVisibleCount,
        showFullListToBrand: !!doc.showFullListToBrand,
        share: doc.share,
        totalItemCount: allItems.length,
        visibleItemCount: sharedItems.length,
        items: sharedItems,
      },
    });
  } catch (err) {
    console.error('[getSharedFolder] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.bulkImportYoutubeToFolder = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({ error: 'You are not allowed to update pitch folders' });
    }

    const actorId = getActorAdminId(req.admin);
    const folderId = cleanStr(req.params.id);
    const rawUsers = Array.isArray(req.body?.rawUsers) ? req.body.rawUsers : [];

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    if (!rawUsers.length) {
      return res.status(400).json({ error: 'rawUsers are required' });
    }

    const folder = await findAccessibleFolder(folderId, req.admin);
    if (!folder) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    const existingKeys = new Set(
      (folder.items || []).map((item) => {
        const provider = normalizeProvider(item.provider);
        const handle = cleanStr(item.handle).replace(/^@/, '').toLowerCase();
        return `${provider}:${handle}`;
      })
    );

    // collect youtube handles / channelIds from incoming raw users
    const importHandles = [];
    const importChannelIds = [];

    for (const user of rawUsers) {
      const handle = cleanStr(user.handle || user.username).replace(/^@/, '');
      const normalizedHandle = handle ? `@${handle}`.toLowerCase() : '';
      const channelId = cleanStr(user.channelId);

      if (normalizedHandle) importHandles.push(normalizedHandle);
      if (channelId) importChannelIds.push(channelId);
    }

    const savedProfiles = await InfluencerProfile.find({
      platform: 'youtube',
      $or: [
        ...(importHandles.length ? [{ handle: { $in: uniqStrings(importHandles) } }] : []),
        ...(importChannelIds.length ? [{ channelId: { $in: uniqStrings(importChannelIds) } }] : []),
      ],
    })
      .select('handle channelId email')
      .lean();

    const savedByHandle = new Map();
    const savedByChannelId = new Map();

    for (const profile of savedProfiles) {
      const handleKey = cleanStr(profile.handle).toLowerCase();
      const channelKey = cleanStr(profile.channelId);

      if (handleKey) savedByHandle.set(handleKey, profile);
      if (channelKey) savedByChannelId.set(channelKey, profile);
    }

    let added = 0;

    for (const user of rawUsers) {
      const handle = cleanStr(user.handle || user.username).replace(/^@/, '');
      const normalizedHandle = handle ? `@${handle}` : '';
      const handleLookupKey = normalizedHandle.toLowerCase();
      const channelId = cleanStr(user.channelId);

      const savedProfile =
        (handleLookupKey && savedByHandle.get(handleLookupKey)) ||
        (channelId && savedByChannelId.get(channelId)) ||
        null;

      const resolvedEmail = cleanStr(user.email || savedProfile?.email).toLowerCase();

      const item = {
        provider: normalizeProvider(user.platform || 'youtube'),
        name: cleanStr(user.fullname || user.name),
        handle: normalizedHandle,
        followers: toNullableNumber(user.followers),
        primaryLink: cleanStr(user.url),
        links: uniqStrings([user.url]),
        niche: Array.isArray(user.categories) ? uniqStrings(user.categories) : [],
        email: resolvedEmail,
        country: cleanStr(user.country),
        selectionReason: '',
        goodFit: false,
        influencerRateCard: '',
        platformRateCard: '',
        rateCardCurrency: 'USD',
        ourFeePct: null,
        shippingAddress: '',
        mediaKit: normalizeMediaKit(null, actorId),
        mediaKitLink: normalizeMediaKitLink(null, actorId),
        createdByAdmin: actorId || null,
        updatedByAdmin: actorId || null,
      };

      if (!item.name) continue;

      const dedupeKey = `${item.provider}:${cleanStr(item.handle).replace(/^@/, '').toLowerCase()}`;

      if (!dedupeKey || existingKeys.has(dedupeKey)) continue;

      folder.items.push(item);
      existingKeys.add(dedupeKey);
      added += 1;
    }

    folder.updatedByAdmin = actorId || null;

    const hydrated = await saveAndHydrateFolder(folder);

    return res.json({
      success: true,
      message: 'Youtube creators imported successfully',
      added,
      total: hydrated?.items?.length || 0,
      data: serializeFolderDetail(hydrated),
    });
  } catch (err) {
    console.error('[bulkImportYoutubeToFolder] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.updateSharedFolderGoodFit = async (req, res) => {
  try {
    const token = cleanStr(req.params.token);
    const itemId = cleanStr(req.params.itemId);
    const goodFit = !!req.body?.goodFit;

    if (!token) {
      return res.status(400).json({ error: 'Share token is required' });
    }

    if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid item id is required' });
    }

    const doc = await PitchFolder.findOne({
      'share.token': token,
      archivedAt: null,
    });

    if (!doc) {
      return res.status(404).json({ error: 'Shared pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    item.goodFit = goodFit;
    await doc.save();

    return res.json({
      success: true,
      message: 'Good fit updated successfully',
      data: {
        _id: item._id,
        goodFit: item.goodFit,
      },
    });
  } catch (err) {
    console.error('[updateSharedFolderGoodFit] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

exports.requestSharedFolderMediaKit = async (req, res) => {
  try {
    const token = cleanStr(req.params.token);
    const itemId = cleanStr(req.params.itemId);

    if (!token) {
      return res.status(400).json({ error: 'Share token is required' });
    }

    if (!itemId || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(400).json({ error: 'Valid item id is required' });
    }

    const doc = await PitchFolder.findOne({
      'share.token': token,
      archivedAt: null,
    });

    if (!doc) {
      return res.status(404).json({ error: 'Shared pitch folder not found' });
    }

    const item = doc.items.id(itemId);
    if (!item) {
      return res.status(404).json({ error: 'Folder item not found' });
    }

    ensureSingleSharedMediaKit(item);
    ensureGenericRequestConsistency(item);

    // if already visible to brand, no need to request
    if (item.mediaKit?.showToBrand || item.mediaKitLink?.showToBrand) {
      return res.json({
        success: true,
        message: 'Media kit is already available',
        data: {
          _id: item._id,
          requestStatus: 'approved',
          requestedAt: getGenericMediaKitRequestedAt(item),
          buttonLabel: '',
        },
      });
    }

    const now = new Date();
    const source = getPreferredMediaKitSource(item);

    // if one source exists, mark request on that source
    if (source === 'pdf') {
      item.mediaKit.requestStatus = 'requested';
      item.mediaKit.requestedAt = now;
    } else if (source === 'link') {
      item.mediaKitLink.requestStatus = 'requested';
      item.mediaKitLink.requestedAt = now;
    } else {
      // nothing added yet, but still allow brand request
      // store a generic request on mediaKit bucket by default
      if (!item.mediaKit) {
        item.mediaKit = normalizeMediaKit(null, null);
      }

      item.mediaKit.requestStatus = 'requested';
      item.mediaKit.requestedAt = now;
    }

    await doc.save();

    return res.json({
      success: true,
      message: 'Media kit request sent successfully',
      data: {
        _id: item._id,
        requestStatus: 'requested',
        requestedAt: getGenericMediaKitRequestedAt(item),
        buttonLabel: 'Requested',
      },
    });
  } catch (err) {
    console.error('[requestSharedFolderMediaKit] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};

function getMediaKitPriorityScore(item) {
  const hasAnyMediaKit = hasStoredMediaKit(item?.mediaKit) || hasMediaKitLink(item?.mediaKitLink);
  const visibleSource = getVisibleMediaKitSource(item);
  const requestStatus = getGenericMediaKitRequestStatus(item);

  if (visibleSource) return 4;
  if (hasAnyMediaKit) return 3;
  if (requestStatus === 'requested') return 2;
  return 1;
}

function sortFolderItemsByMediaKitPriority(items = []) {
  return [...items].sort((a, b) => {
    const scoreDiff = getMediaKitPriorityScore(b) - getMediaKitPriorityScore(a);
    if (scoreDiff !== 0) return scoreDiff;

    return 0;
  });
}

exports.moveFolderItems = async (req, res) => {
  try {
    if (!canCreateOrManagePitchFolders(req.admin)) {
      return res.status(403).json({
        error: 'You are not allowed to move influencers between pitch folders',
      });
    }

    const actorId = getActorAdminId(req.admin);
    const sourceFolderId = cleanStr(req.body?.sourceFolderId || req.body?.folderId);
    const destinationFolderId = cleanStr(req.body?.destinationFolderId);

    const transferType = cleanStr(
      req.body?.transferType || req.body?.mode || 'move'
    ).toLowerCase();

    const isCopyOnly = ['copy', 'copy_move', 'copy-move', 'copyandmove'].includes(
      transferType
    );
    const isDirectMove = ['move', 'direct_move', 'direct-move'].includes(
      transferType
    );

    const itemIds = Array.isArray(req.body?.itemIds)
      ? uniqStrings(req.body.itemIds).filter((id) =>
          mongoose.Types.ObjectId.isValid(String(id))
        )
      : [];

    if (!isCopyOnly && !isDirectMove) {
      return res.status(400).json({
        error:
          'transferType must be one of: copy, move, direct_move, copy_move',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(sourceFolderId)) {
      return res.status(400).json({ error: 'Valid sourceFolderId is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(destinationFolderId)) {
      return res.status(400).json({
        error: 'Valid destinationFolderId is required',
      });
    }

    if (String(sourceFolderId) === String(destinationFolderId)) {
      return res.status(400).json({
        error: 'Source and destination folder cannot be the same',
      });
    }

    if (!itemIds.length) {
      return res.status(400).json({
        error: 'At least one valid itemId is required',
      });
    }

    const sourceFolder = await findAccessibleFolder(sourceFolderId, req.admin);
    if (!sourceFolder) {
      return res.status(404).json({ error: 'Source pitch folder not found' });
    }

    const destinationFolder = await findAccessibleFolder(
      destinationFolderId,
      req.admin
    );
    if (!destinationFolder) {
      return res
        .status(404)
        .json({ error: 'Destination pitch folder not found' });
    }

    const destinationExistingKeys = new Set(
      (destinationFolder.items || []).map((item) => {
        const provider = normalizeProvider(item.provider);
        const handle = cleanStr(item.handle).replace(/^@/, '').toLowerCase();
        return `${provider}:${handle}`;
      })
    );

    const skippedMissingItemIds = [];
    const skippedDuplicateItemIds = [];
    let copiedCount = 0;
    let movedCount = 0;

    for (const itemId of itemIds) {
      const sourceItem = sourceFolder.items.id(itemId);

      if (!sourceItem) {
        skippedMissingItemIds.push(itemId);
        continue;
      }

      const itemKey = `${normalizeProvider(sourceItem.provider)}:${cleanStr(
        sourceItem.handle
      )
        .replace(/^@/, '')
        .toLowerCase()}`;

      if (itemKey && destinationExistingKeys.has(itemKey)) {
        skippedDuplicateItemIds.push(itemId);
        continue;
      }

      if (isCopyOnly) {
        const copiedItem = cloneFolderItemForTransfer(sourceItem, actorId);
        destinationFolder.items.push(copiedItem);
        copiedCount += 1;
      } else {
        const movedItem =
          typeof sourceItem.toObject === 'function'
            ? sourceItem.toObject()
            : { ...sourceItem };

        movedItem.updatedByAdmin = actorId || null;

        destinationFolder.items.push(movedItem);
        sourceItem.deleteOne();
        movedCount += 1;
      }

      if (itemKey) {
        destinationExistingKeys.add(itemKey);
      }
    }

    const processedCount = isCopyOnly ? copiedCount : movedCount;

    if (!processedCount) {
      return res.status(400).json({
        error: `No influencers were ${isCopyOnly ? 'copied' : 'moved'}`,
        data: {
          action: isCopyOnly ? 'copy' : 'move',
          copiedCount,
          movedCount,
          skippedMissingItemIds,
          skippedDuplicateItemIds,
        },
      });
    }

    destinationFolder.updatedByAdmin = actorId || null;
    await destinationFolder.save();

    if (!isCopyOnly) {
      sourceFolder.updatedByAdmin = actorId || null;
      await sourceFolder.save();
    }

    const [sourceHydrated, destinationHydrated] = await Promise.all([
      PitchFolder.findById(sourceFolder._id)
        .populate(buildCreatorPopulate())
        .populate(buildUpdatedByPopulate())
        .populate(buildSharedByPopulate())
        .lean(),
      PitchFolder.findById(destinationFolder._id)
        .populate(buildCreatorPopulate())
        .populate(buildUpdatedByPopulate())
        .populate(buildSharedByPopulate())
        .lean(),
    ]);

    return res.json({
      success: true,
      message: `Selected influencers ${
        isCopyOnly ? 'copied' : 'moved'
      } successfully`,
      data: {
        action: isCopyOnly ? 'copy' : 'move',
        copiedCount,
        movedCount,
        skippedMissingItemIds,
        skippedDuplicateItemIds,
        sourceFolder: serializeFolderDetail(sourceHydrated),
        destinationFolder: serializeFolderListItem(destinationHydrated),
      },
    });
  } catch (err) {
    console.error('[moveFolderItems] Error:', err);
    return res.status(500).json({ error: err?.message || 'Internal error' });
  }
};