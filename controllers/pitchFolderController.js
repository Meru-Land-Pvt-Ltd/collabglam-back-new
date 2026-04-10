'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PitchFolder = require('../models/pitchFolder');
const { AdminModel, ROLES } = require('../models/master');

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
    comments: cleanStr(body.comments),
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
  if (hasOwn(body, 'comments')) item.comments = cleanStr(body.comments);

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
    comments: item.comments,

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
    const id = cleanStr(req.body?.id);
    const title = cleanStr(req.body?.title);
    const description = cleanStr(req.body?.description);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Valid folder id is required' });
    }

    const doc = await findAccessibleFolder(id, req.admin);
    if (!doc) {
      return res.status(404).json({ error: 'Pitch folder not found' });
    }

    if (title) {
      const baseSlug = slugify(title) || `pitch-folder-${Date.now()}`;
      let slug = baseSlug;
      let counter = 1;

      while (
        await PitchFolder.exists({
          _id: { $ne: doc._id },
          slug,
          archivedAt: null,
        })
      ) {
        counter += 1;
        slug = `${baseSlug}-${counter}`;
      }

      doc.title = title;
      doc.slug = slug;
    }

    if (req.body?.description !== undefined) {
      doc.description = description;
    }

    if (hasOwn(req.body, 'brandVisibleItemCount')) {
      doc.brandVisibleItemCount = toNullableInteger(req.body.brandVisibleItemCount);
    }

    if (hasOwn(req.body, 'showFullListToBrand')) {
      doc.showFullListToBrand = !!req.body.showFullListToBrand;
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

    let added = 0;

    for (const user of rawUsers) {
      const handle = cleanStr(user.handle || user.username).replace(/^@/, '');
      const item = {
        provider: normalizeProvider(user.platform || 'youtube'),
        name: cleanStr(user.fullname || user.name),
        handle: handle ? `@${handle}` : '',
        followers: toNullableNumber(user.followers),
        primaryLink: cleanStr(user.url),
        links: uniqStrings([user.url]),
        niche: Array.isArray(user.categories) ? uniqStrings(user.categories) : [],
        email: cleanStr(user.email).toLowerCase(),
        country: cleanStr(user.country),
        selectionReason: '',
        goodFit: false,
        influencerRateCard: '',
        platformRateCard: '',
        rateCardCurrency: 'USD',
        ourFeePct: null,
        comments: '',
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