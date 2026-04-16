'use strict';

require('dotenv').config();
const { fetch } = require('undici');
const mongoose = require('mongoose');
const {
  canShowSensitiveFromRequest,
  sanitizeModashReportForViewer,
  sanitizeModashDocForViewer,
} = require('../utils/emailRedactor');
const ModashProfile = require('../models/modash');
const Influencer = require('../models/influencer'); // kept for future compatibility
const BrandProfileView = require('../models/brandProfileView');
const { ensureBrandQuota } = require('../utils/quota');

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

const MODASH_API_KEY = process.env.MODASH_API_KEY;
const MODASH_BASE_URL = process.env.MODASH_BASE_URL || 'https://api.modash.io/v1';
const MODASH_AUTH_HEADER = cleanStr(process.env.MODASH_AUTH_HEADER || 'authorization').toLowerCase();

if (!MODASH_API_KEY) {
  throw new Error('MODASH_API_KEY is missing. Add it to your environment.');
}

const ALLOWED_PLATFORMS = new Set(['instagram', 'youtube', 'tiktok']);
const DEFAULT_YT_SORT = { field: 'followers', direction: 'desc' };
const YT_ALLOWED_AGE = new Set([18, 25, 35, 45, 65]);
const MAX_LIST_LIMIT = 100;
const MAX_RANDOM_LIMIT = 50;
const MAX_EXPORT_LIMIT = 100000;

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function firstNonEmpty() {
  for (const v of arguments) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) return t;
    }
  }
  return undefined;
}

function deepClone(x) {
  if (!x || typeof x !== 'object') return x;
  return JSON.parse(JSON.stringify(x));
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function uniqStrings(values = []) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    const clean = cleanStr(value);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }

  return out;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactCI(value) {
  return new RegExp(`^${escapeRegex(cleanStr(value))}$`, 'i');
}

function containsCI(value) {
  return new RegExp(escapeRegex(cleanStr(value)), 'i');
}

function parseMultiValue(input) {
  if (input === undefined || input === null) return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  return uniqStrings(
    raw
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => cleanStr(entry))
      .filter(Boolean)
  );
}

function parseFlexibleNumber(v) {
  if (v === undefined || v === null || v === '') return null;

  const s = String(v).trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?k$/.test(s)) return Number(s.replace('k', '')) * 1000;
  if (/^\d+(\.\d+)?m$/.test(s)) return Number(s.replace('m', '')) * 1000000;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parsePagination(pageInput, limitInput, opts = {}) {
  const page = Math.max(0, parseInt(String(pageInput ?? opts.page ?? 0), 10) || 0);
  const rawLimit = parseInt(String(limitInput ?? opts.limit ?? 20), 10);
  const maxLimit = opts.maxLimit || MAX_LIST_LIMIT;
  const limit = Math.min(maxLimit, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));
  return { page, limit };
}

function buildLocationLabel(city, state, country) {
  return uniqStrings([city, state, country]).join(', ');
}

function extractYouTubeHandleFromUrl(u) {
  if (!u) return undefined;
  const m = u.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i);
  return m ? m[1] : undefined;
}

function pickPrimarySrc(item) {
  return (item && (item.profile || item.channel || item.creator || item.user)) || item;
}

function pickPicture(src) {
  return firstNonEmpty(
    src && src.picture,
    src && src.avatar,
    src && src.profilePicUrl,
    src && src.thumbnail,
    src && src.channelThumbnailUrl,
    src && src.profilePicture,
    src && src.image,
    src && src.photo
  );
}

function extractCountry(src) {
  return firstNonEmpty(
    src && src.country,
    src && src.location && src.location.country,
    src && src.audience && src.audience.country,
    src && src.audience && src.audience.topCountry,
    src && src.geo && src.geo.country
  );
}

function extractState(src) {
  return firstNonEmpty(
    src && src.state,
    src && src.region,
    src && src.location && src.location.state,
    src && src.location && src.location.region
  );
}

function extractCity(src) {
  return firstNonEmpty(src && src.city, src && src.location && src.location.city);
}

function extractBio(src) {
  return firstNonEmpty(
    src && src.bio,
    src && src.description,
    src && src.about,
    src && src.summary,
    src && src.introduction,
    src && src.profile && src.profile.bio,
    src && src.profile && src.profile.description
  );
}

function extractLanguage(src) {
  const raw = (src && src.language) || (src && src.audience && src.audience.language) || null;
  if (!raw) return undefined;
  if (typeof raw === 'string') return cleanStr(raw);
  if (typeof raw === 'object') return firstNonEmpty(raw.name, raw.code, raw.label);
  return undefined;
}

function normalizeCategoryObjects(input) {
  const list = asArray(input);
  const out = [];

  for (const entry of list) {
    if (!entry) continue;

    if (typeof entry === 'string') {
      const name = cleanStr(entry);
      if (!name) continue;
      out.push({
        categoryId: null,
        categoryName: name,
        subcategoryId: null,
        subcategoryName: null,
      });
      continue;
    }

    const categoryName = firstNonEmpty(
      entry.categoryName,
      entry.name,
      entry.title,
      entry.label,
      entry.vertical,
      entry.topic
    );

    const subcategoryName = firstNonEmpty(
      entry.subcategoryName,
      entry.subName,
      entry.subcategory,
      entry.childName
    );

    if (!categoryName && !subcategoryName) continue;

    out.push({
      categoryId: entry.categoryId || null,
      categoryName: categoryName || null,
      subcategoryId: entry.subcategoryId || null,
      subcategoryName: subcategoryName || null,
    });
  }

  return out;
}

function extractCategories(src) {
  const raw = []
    .concat(asArray(src && src.categories))
    .concat(asArray(src && src.categoryLinks))
    .concat(asArray(src && src.category))
    .concat(asArray(src && src.interests))
    .concat(asArray(src && src.niches))
    .concat(asArray(src && src.topics))
    .concat(asArray(src && src.tags))
    .concat(asArray(src && src.profile && src.profile.categories))
    .concat(asArray(src && src.profile && src.profile.categoryLinks));

  const normalized = normalizeCategoryObjects(raw);
  const deduped = [];
  const seen = new Set();

  for (const item of normalized) {
    const key = `${cleanStr(item.categoryName).toLowerCase()}|${cleanStr(item.subcategoryName).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function categoryNamesFromObjects(categories) {
  const out = [];

  for (const item of asArray(categories)) {
    if (!item) continue;

    if (typeof item === 'string') {
      const value = cleanStr(item);
      if (value) out.push(value);
      continue;
    }

    const categoryName = cleanStr(item.categoryName || item.name || '');
    const subcategoryName = cleanStr(item.subcategoryName || item.subName || item.subcategory || '');

    if (categoryName) out.push(categoryName);
    if (subcategoryName) out.push(subcategoryName);
  }

  return uniqStrings(out);
}

function buildPublicProfileUrl(platform, username, rawUrl, userId) {
  const cleanUsername = cleanStr(username).replace(/^@/, '');
  const cleanUrl = cleanStr(rawUrl);
  const cleanUserId = cleanStr(userId);

  if (platform === 'youtube') {
    if (cleanUsername) return `https://www.youtube.com/@${cleanUsername}`;
    if (cleanUrl) return cleanUrl;
    if (cleanUserId) return `https://www.youtube.com/channel/${cleanUserId}`;
    return undefined;
  }

  if (platform === 'instagram') {
    if (cleanUrl) return cleanUrl;
    if (cleanUsername) return `https://www.instagram.com/${cleanUsername}`;
    return undefined;
  }

  if (platform === 'tiktok') {
    if (cleanUrl) return cleanUrl;
    if (cleanUsername) return `https://www.tiktok.com/@${cleanUsername}`;
    return undefined;
  }

  return cleanUrl || undefined;
}

function mergeSearchItem(base, extra) {
  const next = { ...base };

  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (!Array.isArray(next[key]) || !next[key].length) {
        next[key] = value;
      }
      continue;
    }

    if (next[key] === undefined || next[key] === null || next[key] === '') {
      next[key] = value;
    }
  }

  if ((!next.location || !cleanStr(next.location)) && (next.city || next.state || next.country)) {
    next.location = buildLocationLabel(next.city, next.state, next.country);
  }

  if ((!next.category || !cleanStr(next.category)) && Array.isArray(next.categories) && next.categories.length) {
    next.category = next.categories[0];
  }

  if ((!next.primaryCategory || !cleanStr(next.primaryCategory)) && Array.isArray(next.categories) && next.categories.length) {
    next.primaryCategory = next.categories[0];
  }

  return next;
}

function mapDocToListFields(doc) {
  const categories = categoryNamesFromObjects(doc && doc.categories);

  return {
    bio: cleanStr(doc && doc.bio) || undefined,
    country: cleanStr(doc && doc.country) || undefined,
    state: cleanStr(doc && doc.state) || undefined,
    city: cleanStr(doc && doc.city) || undefined,
    location:
      buildLocationLabel(
        cleanStr(doc && doc.city),
        cleanStr(doc && doc.state),
        cleanStr(doc && doc.country)
      ) || undefined,
    language: extractLanguage(doc),
    categories,
    category: categories[0] || undefined,
    primaryCategory: categories[0] || undefined,
    picture: cleanStr(doc && doc.picture) || undefined,
    url: cleanStr(doc && doc.url) || undefined,
    fullname: cleanStr(doc && doc.fullname) || undefined,
    handle: cleanStr(doc && doc.handle) || undefined,
    username: cleanStr(doc && doc.username) || undefined,
    isVerified: typeof doc?.isVerified === 'boolean' ? doc.isVerified : undefined,
    isPrivate: typeof doc?.isPrivate === 'boolean' ? doc.isPrivate : undefined,
  };
}

function normalizePlatform(platform) {
  const p = cleanStr(platform).toLowerCase();
  return ALLOWED_PLATFORMS.has(p) ? p : '';
}

function normalizePlatforms(inputSingle, inputMulti) {
  const single = normalizePlatform(inputSingle);
  if (single) return [single];

  const multi = parseMultiValue(inputMulti)
    .map((x) => normalizePlatform(x))
    .filter(Boolean);

  return uniqStrings(multi);
}

function buildSafeErrorMessage(err, fallback) {
  const raw = (err && err.message) || '';
  const isSensitive =
    /api token|developer section|modash|authorization|bearer|modash_api_key|marketer\.modash\.io/i.test(
      String(raw)
    );
  return isSensitive ? fallback : raw || fallback;
}

/* -------------------------------------------------------------------------- */
/*                             Country aliases                                */
/* -------------------------------------------------------------------------- */

const COUNTRY_ALIASES = {
  US: ['US', 'USA', 'United States', 'United States of America'],
  IN: ['IN', 'India'],
  GB: ['GB', 'UK', 'United Kingdom', 'Great Britain'],
  CA: ['CA', 'Canada'],
  AU: ['AU', 'Australia'],
  NZ: ['NZ', 'New Zealand'],
  IE: ['IE', 'Ireland'],
  DE: ['DE', 'Germany'],
  FR: ['FR', 'France'],
  IT: ['IT', 'Italy'],
  ES: ['ES', 'Spain'],
  NL: ['NL', 'Netherlands'],
  BE: ['BE', 'Belgium'],
  CH: ['CH', 'Switzerland'],
  AT: ['AT', 'Austria'],
  SE: ['SE', 'Sweden'],
  NO: ['NO', 'Norway'],
  DK: ['DK', 'Denmark'],
  FI: ['FI', 'Finland'],
  PL: ['PL', 'Poland'],
  CZ: ['CZ', 'Czechia', 'Czech Republic'],
  PT: ['PT', 'Portugal'],
  RO: ['RO', 'Romania'],
  GR: ['GR', 'Greece'],
  TR: ['TR', 'Turkey'],
  UA: ['UA', 'Ukraine'],
  RU: ['RU', 'Russia'],
  BR: ['BR', 'Brazil'],
  AR: ['AR', 'Argentina'],
  CL: ['CL', 'Chile'],
  CO: ['CO', 'Colombia'],
  MX: ['MX', 'Mexico'],
  PE: ['PE', 'Peru'],
  ZA: ['ZA', 'South Africa'],
  NG: ['NG', 'Nigeria'],
  EG: ['EG', 'Egypt'],
  KE: ['KE', 'Kenya'],
  SA: ['SA', 'Saudi Arabia'],
  AE: ['AE', 'United Arab Emirates', 'UAE'],
  IL: ['IL', 'Israel'],
  SG: ['SG', 'Singapore'],
  MY: ['MY', 'Malaysia'],
  ID: ['ID', 'Indonesia'],
  PH: ['PH', 'Philippines'],
  TH: ['TH', 'Thailand'],
  VN: ['VN', 'Vietnam'],
  JP: ['JP', 'Japan'],
  KR: ['KR', 'South Korea'],
  HK: ['HK', 'Hong Kong'],
  TW: ['TW', 'Taiwan'],
  CN: ['CN', 'China'],
  PK: ['PK', 'Pakistan'],
  BD: ['BD', 'Bangladesh'],
  LK: ['LK', 'Sri Lanka'],
  NP: ['NP', 'Nepal'],
};

const COUNTRY_ALIAS_LOOKUP = (() => {
  const out = Object.create(null);
  for (const aliases of Object.values(COUNTRY_ALIASES)) {
    for (const alias of aliases) {
      out[cleanStr(alias).toLowerCase()] = aliases;
    }
  }
  return out;
})();

function normalizeCountryTokens(values = []) {
  const out = [];
  const seen = new Set();

  for (const raw of values) {
    const clean = cleanStr(raw);
    if (!clean) continue;

    const aliases = COUNTRY_ALIAS_LOOKUP[clean.toLowerCase()] || [clean];
    for (const alias of aliases) {
      const normalized = cleanStr(alias);
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*                             Auth / Modash HTTP                             */
/* -------------------------------------------------------------------------- */

function headerVariant(kind, rawKey) {
  const key = cleanStr(rawKey);
  const bearerToken = key.replace(/^bearer\s+/i, '');
  const h = { 'content-type': 'application/json' };

  if (kind === 'authorization') {
    h.authorization = `Bearer ${bearerToken}`;
  } else if (kind === 'accesstoken') {
    h.accesstoken = bearerToken;
  } else {
    h['x-api-key'] = key;
  }

  return h;
}

function primaryHeaderKind() {
  if (MODASH_AUTH_HEADER === 'authorization') return 'authorization';
  if (MODASH_AUTH_HEADER === 'accesstoken' || MODASH_AUTH_HEADER === 'accessToken') {
    return 'accesstoken';
  }
  if (/^bearer\s+/i.test(MODASH_API_KEY)) return 'authorization';
  return 'x-api-key';
}

function fallbackKinds(primary) {
  const all = ['x-api-key', 'authorization', 'accesstoken'];
  return [primary, ...all.filter((k) => k !== primary)];
}

function toQuery(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function modashRequest({ method, path, query, body }) {
  const url = `${MODASH_BASE_URL}${path}${toQuery(query)}`;
  const kinds = fallbackKinds(primaryHeaderKind());

  let lastErr;
  for (const kind of kinds) {
    try {
      const res = await fetch(url, {
        method,
        headers: headerVariant(kind, MODASH_API_KEY),
        body: body ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!res.ok) {
        const err = new Error(
          (json && (json.message || json.error)) || `Modash ${res.status} ${res.statusText}`
        );
        err.status = res.status;
        err.response = json || undefined;

        if (res.status === 401 || res.status === 403) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      return json;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('Unknown Modash error');
}

async function modashGET(path, query) {
  return modashRequest({ method: 'GET', path, query });
}

async function modashPOST(path, body) {
  return modashRequest({ method: 'POST', path, body });
}

/* -------------------------------------------------------------------------- */
/*                         Search item normalization                          */
/* -------------------------------------------------------------------------- */

function normalizeSearchItem(item, platform) {
  const src = pickPrimarySrc(item);

  const rawUrl = firstNonEmpty(src && src.url, src && src.channelUrl, src && src.profileUrl);
  const derivedHandleFromUrl = extractYouTubeHandleFromUrl(rawUrl);

  const rawUsername = firstNonEmpty(
    src && src.username,
    src && src.handle,
    src && src.channelHandle,
    src && src.slug,
    src && src.customUrl,
    src && src.vanityUrl,
    derivedHandleFromUrl
  );

  const username = rawUsername ? rawUsername.replace(/^@/, '') : undefined;
  const userId =
    cleanStr(
      (item && item.userId) ||
      (src && src.userId) ||
      (src && src.id) ||
      (src && src.channelId) ||
      (src && src.profileId)
    ) || undefined;

  const categories = categoryNamesFromObjects(extractCategories(src));
  const country = extractCountry(src);
  const state = extractState(src);
  const city = extractCity(src);

  return {
    userId,
    username,
    handle: username || undefined,
    fullname:
      (src &&
        (src.fullName || src.fullname || src.display_name || src.title || src.name)) ||
      '',
    followers:
      toNum(src && (src.followers || src.followerCount || (src.stats && src.stats.followers))) || 0,
    engagementRate:
      toNum(src && (src.engagementRate || (src.stats && src.stats.engagementRate))) || 0,
    engagements: toNum(
      src && (src.engagements || (src.stats && (src.stats.avgEngagements || src.stats.avgLikes)))
    ),
    averageViews: toNum(
      src && (src.averageViews || (src.stats && src.stats.avgViews) || src.avgViews)
    ),
    picture: pickPicture(src) || undefined,
    url: buildPublicProfileUrl(platform, username, rawUrl, userId),
    isVerified: Boolean(src && (src.isVerified || src.verified)),
    isPrivate: Boolean(src && src.isPrivate),
    platform,

    bio: extractBio(src) || undefined,
    country: country || undefined,
    state: state || undefined,
    city: city || undefined,
    location: buildLocationLabel(city, state, country) || undefined,
    language: extractLanguage(src) || undefined,
    categories,
    category: categories[0] || undefined,
    primaryCategory: categories[0] || undefined,
  };
}

function betterSearchResult(a, b) {
  if (a.isVerified !== b.isVerified) return a.isVerified ? a : b;
  if (!!a.username !== !!b.username) return a.username ? a : b;
  if (!!a.picture !== !!b.picture) return a.picture ? a : b;
  if (!!a.bio !== !!b.bio) return a.bio ? a : b;
  if (!!a.country !== !!b.country) return a.country ? a : b;
  if ((a.categories?.length || 0) !== (b.categories?.length || 0)) {
    return (a.categories?.length || 0) > (b.categories?.length || 0) ? a : b;
  }
  if ((a.followers || 0) !== (b.followers || 0)) return (a.followers || 0) > (b.followers || 0) ? a : b;
  if ((a.engagementRate || 0) !== (b.engagementRate || 0)) {
    return (a.engagementRate || 0) > (b.engagementRate || 0) ? a : b;
  }
  if ((a.engagements || 0) !== (b.engagements || 0)) return (a.engagements || 0) > (b.engagements || 0) ? a : b;
  if (!!a.url !== !!b.url) return a.url ? a : b;
  return a;
}

function dedupeSearchItems(items) {
  const map = new Map();
  for (const it of items) {
    const keyBase =
      (it.userId && String(it.userId).toLowerCase()) ||
      (it.username && String(it.username).toLowerCase()) ||
      (it.url && String(it.url).toLowerCase());

    if (!keyBase) continue;

    const key = `${it.platform}:${keyBase}`;
    const prev = map.get(key);
    map.set(key, prev ? betterSearchResult(prev, it) : it);
  }
  return Array.from(map.values());
}

function scoreForQuery(u, qLower) {
  const uname = String(u.username || u.handle || '').toLowerCase();
  const full = String(u.fullname || '').toLowerCase();
  const url = String(u.url || '').toLowerCase();

  if (uname === qLower) return 100;
  if (url.indexOf(`/@${qLower}`) !== -1) return 95;
  if (full === qLower) return 90;
  if (uname.startsWith(qLower)) return 70;
  if (full.startsWith(qLower)) return 60;
  if (uname.indexOf(qLower) !== -1) return 45;
  if (full.indexOf(qLower) !== -1) return 35;
  return 10;
}

function dedupeByBest(items) {
  const map = new Map();
  for (const it of items) {
    const uname = String(it.username || it.handle || '').toLowerCase();
    const key = `${it.platform}:${uname}`;
    const prev = map.get(key);
    if (!prev || it.__score > prev.__score) {
      map.set(key, it);
    }
  }
  return Array.from(map.values());
}

async function enrichResultsFromCache(items) {
  if (!Array.isArray(items) || !items.length) return items;

  const providers = uniqStrings(items.map((x) => x.platform));
  const userIds = uniqStrings(items.map((x) => x.userId));
  const usernames = uniqStrings(items.map((x) => x.username));

  const or = [];
  if (userIds.length) or.push({ userId: { $in: userIds } });
  if (usernames.length) or.push({ username: { $in: usernames } });
  if (!or.length) return items;

  const docs = await ModashProfile.find({ provider: { $in: providers }, $or: or })
    .select({
      provider: 1,
      userId: 1,
      username: 1,
      fullname: 1,
      handle: 1,
      url: 1,
      picture: 1,
      bio: 1,
      country: 1,
      state: 1,
      city: 1,
      language: 1,
      categories: 1,
      isVerified: 1,
      isPrivate: 1,
    })
    .lean();

  const byId = new Map();
  const byUsername = new Map();

  for (const doc of docs) {
    const keyById = `${cleanStr(doc.provider).toLowerCase()}:${cleanStr(doc.userId).toLowerCase()}`;
    const keyByUsername = `${cleanStr(doc.provider).toLowerCase()}:${cleanStr(doc.username).toLowerCase()}`;

    if (cleanStr(doc.userId)) byId.set(keyById, doc);
    if (cleanStr(doc.username)) byUsername.set(keyByUsername, doc);
  }

  return items.map((item) => {
    const keyById = `${cleanStr(item.platform).toLowerCase()}:${cleanStr(item.userId).toLowerCase()}`;
    const keyByUsername = `${cleanStr(item.platform).toLowerCase()}:${cleanStr(item.username).toLowerCase()}`;

    const doc = byId.get(keyById) || byUsername.get(keyByUsername);
    if (!doc) return item;
    return mergeSearchItem(item, mapDocToListFields(doc));
  });
}

/* -------------------------------------------------------------------------- */
/*                              Report helpers                                */
/* -------------------------------------------------------------------------- */

function pickArray() {
  for (const value of arguments) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  for (const value of arguments) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeReportData(reportJSON) {
  const rootProfile = (reportJSON && reportJSON.profile) || {};
  const nestedProfile = rootProfile.profile || {};
  const prof =
    nestedProfile && Object.keys(nestedProfile).length ? nestedProfile : rootProfile;

  const rawUserId =
    prof.userId ||
    rootProfile.userId ||
    prof.id ||
    rootProfile.id ||
    prof.channelId ||
    rootProfile.channelId ||
    prof.profileId ||
    rootProfile.profileId ||
    prof.secUid ||
    rootProfile.secUid ||
    null;

  const profileUserId = rawUserId ? cleanStr(rawUserId) : null;

  const rootCategories = extractCategories(rootProfile);
  const nestedCategories = extractCategories(prof);
  const categories = rootCategories.length ? rootCategories : nestedCategories;

  const cleanUsername = cleanStr(prof.username || prof.handle).replace(/^@/, '') || null;
  const cleanHandle =
    cleanStr(prof.handle) ||
    (cleanUsername ? `@${cleanUsername}` : null);

  return {
    profile: {
      userId: profileUserId,
      username: cleanUsername,
      fullname: prof.fullname || prof.fullName || prof.title || rootProfile.fullname || null,
      handle: cleanHandle,
      url: prof.url || rootProfile.url || null,
      picture: pickPicture(prof) || pickPicture(rootProfile) || null,
      followers: toNum(prof.followers ?? rootProfile.followers),
      engagements: toNum(prof.engagements ?? rootProfile.engagements),
      engagementRate: toNum(prof.engagementRate ?? rootProfile.engagementRate),
      averageViews: toNum(
        prof.averageViews ??
          prof.avgViews ??
          rootProfile.averageViews ??
          rootProfile.avgViews
      ),
    },

    isPrivate:
      typeof rootProfile.isPrivate === 'boolean'
        ? rootProfile.isPrivate
        : typeof prof.isPrivate === 'boolean'
          ? prof.isPrivate
          : null,

    isVerified:
      typeof rootProfile.isVerified === 'boolean'
        ? rootProfile.isVerified
        : typeof prof.isVerified === 'boolean'
          ? prof.isVerified
          : null,

    accountType: rootProfile.accountType || prof.accountType || null,
    secUid: rootProfile.secUid || prof.secUid || null,

    city: extractCity(rootProfile) || extractCity(prof) || null,
    state: extractState(rootProfile) || extractState(prof) || null,
    subdivision:
      firstNonEmpty(rootProfile.subdivision, prof.subdivision) || null,
    country: extractCountry(rootProfile) || extractCountry(prof) || null,
    ageGroup: rootProfile.ageGroup || prof.ageGroup || null,
    gender: rootProfile.gender || prof.gender || null,
    language: rootProfile.language ?? prof.language ?? null,

    contacts: pickArray(rootProfile.contacts, prof.contacts),

    statsByContentType:
      rootProfile.statsByContentType || prof.statsByContentType || null,
    stats: rootProfile.stats || prof.stats || null,

    recentPosts: pickArray(rootProfile.recentPosts, prof.recentPosts),
    popularPosts: pickArray(rootProfile.popularPosts, prof.popularPosts),

    postsCount: toNum(
      rootProfile.postsCount ??
        prof.postsCount ??
        rootProfile.postsCounts ??
        prof.postsCounts
    ),
    postsCounts: toNum(
      rootProfile.postsCounts ??
        prof.postsCounts ??
        rootProfile.postsCount ??
        prof.postsCount
    ),

    avgLikes: toNum(rootProfile.avgLikes ?? prof.avgLikes),
    avgComments: toNum(rootProfile.avgComments ?? prof.avgComments),
    avgViews: toNum(rootProfile.avgViews ?? prof.avgViews),
    avgReelsPlays: toNum(rootProfile.avgReelsPlays ?? prof.avgReelsPlays),
    totalLikes: toNum(rootProfile.totalLikes ?? prof.totalLikes),
    totalViews: toNum(rootProfile.totalViews ?? prof.totalViews),

    bio: extractBio(rootProfile) || extractBio(prof) || '',

    categories,
    hashtags: pickArray(rootProfile.hashtags, prof.hashtags),
    mentions: pickArray(rootProfile.mentions, prof.mentions),
    brandAffinity: pickArray(rootProfile.brandAffinity, prof.brandAffinity),
    interests: pickArray(rootProfile.interests, prof.interests),

    audience: rootProfile.audience || prof.audience || null,
    audienceCommenters:
      rootProfile.audienceCommenters ||
      rootProfile.audienceLikers ||
      prof.audienceCommenters ||
      prof.audienceLikers ||
      null,

    lookalikes: pickArray(
      rootProfile.lookalikes,
      rootProfile.audienceLookalikes,
      prof.lookalikes,
      prof.audienceLookalikes
    ),

    sponsoredPosts: pickArray(rootProfile.sponsoredPosts, prof.sponsoredPosts),
    paidPostPerformance: toNum(
      rootProfile.paidPostPerformance ?? prof.paidPostPerformance
    ),
    paidPostPerformanceViews: toNum(
      rootProfile.paidPostPerformanceViews ?? prof.paidPostPerformanceViews
    ),
    sponsoredPostsMedianViews: toNum(
      rootProfile.sponsoredPostsMedianViews ?? prof.sponsoredPostsMedianViews
    ),
    sponsoredPostsMedianLikes: toNum(
      rootProfile.sponsoredPostsMedianLikes ?? prof.sponsoredPostsMedianLikes
    ),
    nonSponsoredPostsMedianViews: toNum(
      rootProfile.nonSponsoredPostsMedianViews ??
        prof.nonSponsoredPostsMedianViews
    ),
    nonSponsoredPostsMedianLikes: toNum(
      rootProfile.nonSponsoredPostsMedianLikes ??
        prof.nonSponsoredPostsMedianLikes
    ),

    statHistory: pickArray(rootProfile.statHistory, prof.statHistory),
    audienceExtra: rootProfile.audienceExtra || prof.audienceExtra || null,

    providerRaw: reportJSON,
  };
}

function trimProviderRaw(providerRaw) {
  if (!providerRaw || typeof providerRaw !== 'object') return providerRaw;

  const clone = deepClone(providerRaw);
  if (clone && clone.profile) {
    const base = clone.profile.profile || clone.profile;
    const limitPosts = (arr, max = 50) => (Array.isArray(arr) ? arr.slice(0, max) : arr);
    base.recentPosts = limitPosts(base.recentPosts);
    base.popularPosts = limitPosts(base.popularPosts);
  }

  return clone;
}

function mapReportToModashDoc(normalized, platform, opts = {}) {
  const prof = normalized.profile || {};
  const rawRoot = (normalized.providerRaw && normalized.providerRaw.profile) || {};
  const rawNested = rawRoot.profile || {};
  const { influencerId, userId } = opts;

  const canonicalUserId =
    userId ||
    cleanStr(prof.userId) ||
    cleanStr(rawRoot.userId) ||
    cleanStr(rawNested.userId) ||
    null;

  const doc = {
    provider: platform,
    userId: canonicalUserId,

    username:
      prof.username ||
      cleanStr(rawNested.username || rawRoot.username).replace(/^@/, '') ||
      null,

    fullname:
      prof.fullname ||
      rawNested.fullname ||
      rawNested.fullName ||
      rawRoot.fullname ||
      rawRoot.fullName ||
      null,

    handle:
      prof.handle ||
      rawNested.handle ||
      rawRoot.handle ||
      (prof.username ? `@${cleanStr(prof.username).replace(/^@/, '')}` : null),

    url: prof.url || rawNested.url || rawRoot.url || null,
    picture: prof.picture || pickPicture(rawNested) || pickPicture(rawRoot) || null,

    followers: prof.followers ?? toNum(rawNested.followers ?? rawRoot.followers),
    engagements: prof.engagements ?? toNum(rawNested.engagements ?? rawRoot.engagements),
    engagementRate:
      prof.engagementRate ?? toNum(rawNested.engagementRate ?? rawRoot.engagementRate),
    averageViews:
      prof.averageViews ??
      toNum(
        rawNested.averageViews ??
          rawNested.avgViews ??
          rawRoot.averageViews ??
          rawRoot.avgViews
      ),

    isPrivate:
      normalized.isPrivate ??
      rawRoot.isPrivate ??
      rawNested.isPrivate ??
      null,

    isVerified:
      normalized.isVerified ??
      rawRoot.isVerified ??
      rawNested.isVerified ??
      null,

    accountType: normalized.accountType ?? rawRoot.accountType ?? rawNested.accountType,
    secUid: normalized.secUid ?? rawRoot.secUid ?? rawNested.secUid,

    city: normalized.city ?? extractCity(rawRoot) ?? extractCity(rawNested),
    state: normalized.state ?? extractState(rawRoot) ?? extractState(rawNested),
    subdivision:
      normalized.subdivision ??
      firstNonEmpty(rawRoot.subdivision, rawNested.subdivision) ??
      null,
    country:
      normalized.country ?? extractCountry(rawRoot) ?? extractCountry(rawNested),
    ageGroup: normalized.ageGroup ?? rawRoot.ageGroup ?? rawNested.ageGroup,
    gender: normalized.gender ?? rawRoot.gender ?? rawNested.gender,
    language: normalized.language ?? rawRoot.language ?? rawNested.language,

    contacts: pickArray(normalized.contacts, rawRoot.contacts, rawNested.contacts),

    statsByContentType:
      normalized.statsByContentType ??
      rawRoot.statsByContentType ??
      rawNested.statsByContentType,

    stats: normalized.stats ?? rawRoot.stats ?? rawNested.stats,

    recentPosts: pickArray(
      normalized.recentPosts,
      rawRoot.recentPosts,
      rawNested.recentPosts
    ),
    popularPosts: pickArray(
      normalized.popularPosts,
      rawRoot.popularPosts,
      rawNested.popularPosts
    ),

    postsCount:
      normalized.postsCount ??
      toNum(
        rawRoot.postsCount ??
          rawNested.postsCount ??
          rawRoot.postsCounts ??
          rawNested.postsCounts
      ),

    postsCounts:
      normalized.postsCounts ??
      toNum(
        rawRoot.postsCounts ??
          rawNested.postsCounts ??
          rawRoot.postsCount ??
          rawNested.postsCount
      ),

    avgLikes:
      normalized.avgLikes ?? toNum(rawRoot.avgLikes ?? rawNested.avgLikes),
    avgComments:
      normalized.avgComments ??
      toNum(rawRoot.avgComments ?? rawNested.avgComments),
    avgViews:
      normalized.avgViews ?? toNum(rawRoot.avgViews ?? rawNested.avgViews),
    avgReelsPlays:
      normalized.avgReelsPlays ??
      toNum(rawRoot.avgReelsPlays ?? rawNested.avgReelsPlays),
    totalLikes:
      normalized.totalLikes ?? toNum(rawRoot.totalLikes ?? rawNested.totalLikes),
    totalViews:
      normalized.totalViews ?? toNum(rawRoot.totalViews ?? rawNested.totalViews),

    bio: normalized.bio || extractBio(rawRoot) || extractBio(rawNested) || '',

    categories:
      Array.isArray(normalized.categories) && normalized.categories.length
        ? normalized.categories
        : extractCategories(rawRoot).length
          ? extractCategories(rawRoot)
          : extractCategories(rawNested),

    hashtags: pickArray(normalized.hashtags, rawRoot.hashtags, rawNested.hashtags),
    mentions: pickArray(normalized.mentions, rawRoot.mentions, rawNested.mentions),
    brandAffinity: pickArray(
      normalized.brandAffinity,
      rawRoot.brandAffinity,
      rawNested.brandAffinity
    ),
    interests: pickArray(
      normalized.interests,
      rawRoot.interests,
      rawNested.interests
    ),

    audience: normalized.audience ?? rawRoot.audience ?? rawNested.audience,
    audienceCommenters:
      normalized.audienceCommenters ??
      rawRoot.audienceCommenters ??
      rawRoot.audienceLikers ??
      rawNested.audienceCommenters ??
      rawNested.audienceLikers ??
      null,

    lookalikes: pickArray(
      normalized.lookalikes,
      rawRoot.lookalikes,
      rawRoot.audienceLookalikes,
      rawNested.lookalikes,
      rawNested.audienceLookalikes
    ),

    sponsoredPosts: pickArray(
      normalized.sponsoredPosts,
      rawRoot.sponsoredPosts,
      rawNested.sponsoredPosts
    ),

    paidPostPerformance:
      normalized.paidPostPerformance ??
      toNum(rawRoot.paidPostPerformance ?? rawNested.paidPostPerformance),

    paidPostPerformanceViews:
      normalized.paidPostPerformanceViews ??
      toNum(
        rawRoot.paidPostPerformanceViews ??
          rawNested.paidPostPerformanceViews
      ),

    sponsoredPostsMedianViews:
      normalized.sponsoredPostsMedianViews ??
      toNum(
        rawRoot.sponsoredPostsMedianViews ??
          rawNested.sponsoredPostsMedianViews
      ),

    sponsoredPostsMedianLikes:
      normalized.sponsoredPostsMedianLikes ??
      toNum(
        rawRoot.sponsoredPostsMedianLikes ??
          rawNested.sponsoredPostsMedianLikes
      ),

    nonSponsoredPostsMedianViews:
      normalized.nonSponsoredPostsMedianViews ??
      toNum(
        rawRoot.nonSponsoredPostsMedianViews ??
          rawNested.nonSponsoredPostsMedianViews
      ),

    nonSponsoredPostsMedianLikes:
      normalized.nonSponsoredPostsMedianLikes ??
      toNum(
        rawRoot.nonSponsoredPostsMedianLikes ??
          rawNested.nonSponsoredPostsMedianLikes
      ),

    statHistory: pickArray(
      normalized.statHistory,
      rawRoot.statHistory,
      rawNested.statHistory
    ),

    audienceExtra:
      normalized.audienceExtra ??
      rawRoot.audienceExtra ??
      rawNested.audienceExtra,

    providerRaw: trimProviderRaw(normalized.providerRaw),
  };

  if (influencerId) doc.influencerId = influencerId;
  return doc;
}

async function upsertModashProfileFromReport(normalized, platform, opts = {}) {
  const prof = normalized.profile || {};
  const rawRoot = (normalized.providerRaw && normalized.providerRaw.profile) || {};
  const rawNested = rawRoot.profile || {};
  const influencerId = opts.influencerId || null;
  const userIdFromRequest = cleanStr(opts.userIdFromRequest || '');

  const rawCanonicalId =
    cleanStr(prof.userId) ||
    cleanStr(rawRoot.userId) ||
    cleanStr(rawNested.userId) ||
    userIdFromRequest ||
    cleanStr(normalized.secUid) ||
    cleanStr(rawRoot.secUid) ||
    cleanStr(rawNested.secUid) ||
    cleanStr(prof.username) ||
    cleanStr(rawNested.username) ||
    cleanStr(rawRoot.username) ||
    null;

  if (!rawCanonicalId) {
    console.warn('[upsertModashProfile] No usable userId; skipping save', {
      platform,
      profUserId: prof.userId || rawRoot.userId || rawNested.userId,
      userIdFromRequest,
      username: prof.username || rawNested.username || rawRoot.username,
    });
    return null;
  }

  const canonicalUserId = rawCanonicalId;
  normalized.profile = normalized.profile || {};
  normalized.profile.userId = canonicalUserId;

  const doc = mapReportToModashDoc(normalized, platform, {
    influencerId,
    userId: canonicalUserId,
  });

  const filter = { provider: platform, userId: canonicalUserId };
  const update = { $set: doc };
  const options = { upsert: true, new: true, setDefaultsOnInsert: true };

  try {
    const saved = await ModashProfile.findOneAndUpdate(filter, update, options);
    console.log(
      `[upsertModashProfile] Upserted ${platform} profile for userId: ${canonicalUserId}`
    );
    return saved;
  } catch (err) {
    if (err && err.code === 11000) {
      console.error(
        '[upsertModashProfile] Duplicate key on { userId, provider }. Check conflicting legacy unique indexes.',
        err.keyPattern,
        err.keyValue
      );
    } else {
      console.error('[upsertModashProfile] Error saving to database:', err);
    }
    throw err;
  }
}

async function findCachedReport({ platform, userId, influencerId }) {
  let doc = null;

  if (userId) {
    doc = await ModashProfile.findOne({ provider: platform, userId }).lean();
  }

  if (!doc && influencerId) {
    doc = await ModashProfile.findOne({ provider: platform, influencerId }).lean();
  }

  if (!doc || !doc.providerRaw) return null;

  return {
    providerRaw: doc.providerRaw,
    lastFetchedAt: doc.lastFetchedAt || doc.updatedAt || doc.createdAt || null,
  };
}

function toCalcMethod(input) {
  if (!input) return 'median';
  return String(input).toLowerCase() === 'average' ? 'average' : 'median';
}

/* -------------------------------------------------------------------------- */
/*                           Quota / view helpers                             */
/* -------------------------------------------------------------------------- */

async function recordBrandProfileView({ brandId, platform, userId, influencerId, periodKey, at }) {
  if (!brandId || !platform || !userId || !periodKey) return;

  const now = at || new Date();
  const filter = { brandId, platform, userId, periodKey };

  const setOnInsert = {
    brandId,
    platform,
    userId,
    periodKey,
    firstViewedAt: now,
  };

  const update = {
    $setOnInsert: setOnInsert,
    $set: { lastViewedAt: now },
  };

  if (influencerId) update.$set.influencerId = influencerId;

  try {
    await BrandProfileView.findOneAndUpdate(filter, update, { upsert: true, new: true });
  } catch (err) {
    console.error('[recordBrandProfileView] Failed to record profile view:', err);
  }
}

async function ensureSearchQuota(brandId) {
  await ensureBrandQuota(brandId, 'influencer_search_per_month', 1);
}

async function ensureProfileQuota(brandId) {
  await ensureBrandQuota(brandId, 'influencer_profile_views_per_month', 1);
}

/* -------------------------------------------------------------------------- */
/*                           Search body helpers                              */
/* -------------------------------------------------------------------------- */

function sanitizeYouTubeBody(original, opts) {
  const b = deepClone(original || {});
  b.page = b.page != null ? b.page : 0;

  if (!b.sort || !b.sort.field) {
    b.sort = Object.assign({}, b.sort || {}, DEFAULT_YT_SORT);
  }

  if (!b.filter) b.filter = {};
  if (!b.filter.influencer) b.filter.influencer = {};
  if (!b.filter.audience) b.filter.audience = {};

  const infl = b.filter.influencer;
  const aud = b.filter.audience;

  if (typeof infl.lastposted === 'number' && infl.lastposted < 30) {
    infl.lastposted = 30;
  }

  if (infl.age) {
    const min = infl.age.min;
    const max = infl.age.max;
    if ((min && !YT_ALLOWED_AGE.has(min)) || (max && !YT_ALLOWED_AGE.has(max))) {
      delete infl.age;
    }
  }

  if (aud.age && aud.ageRange) delete aud.ageRange;
  if (Array.isArray(infl.filterOperations)) delete infl.filterOperations;

  if (opts && opts.relax) {
    delete b.filter.audience;
    delete infl.followersGrowthRate;
    delete infl.views;
    delete infl.engagements;
    if (typeof infl.lastposted === 'number') delete infl.lastposted;
    b.sort = { field: 'followers', direction: 'desc' };
  }

  return b;
}

function buildPlatformBody(platform, body, opts) {
  if (platform !== 'youtube') {
    const copy = deepClone(body || {});
    copy.page = copy.page != null ? copy.page : 0;
    return copy;
  }
  return sanitizeYouTubeBody(body, { relax: opts && opts.relax });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function pickPostStatNumber(post, keys = []) {
  const stats = (post && post.stats) || {};
  for (const key of keys) {
    const value = stats[key];
    const num = toNum(value);
    if (num !== undefined && num >= 0) return num;
  }
  return undefined;
}

function normalizeAiSearchItem(item, platform) {
  const username = cleanStr(item && item.username).replace(/^@/, '') || undefined;
  const userId = cleanStr(item && item.userId) || undefined;
  const matchedPosts = Array.isArray(item && item.matchedPosts) ? item.matchedPosts : [];
  const recentPosts = Array.isArray(item && item.recentPosts) ? item.recentPosts : [];

  const viewsFromMatched = matchedPosts
    .map((post) =>
      pickPostStatNumber(post, ['viewsCount', 'playsCount', 'videoViewsCount', 'views', 'plays'])
    )
    .filter((num) => num !== undefined);

  const averageViews = viewsFromMatched.length
    ? Math.round(viewsFromMatched.reduce((sum, num) => sum + num, 0) / viewsFromMatched.length)
    : undefined;

  const category = cleanStr(item && item.accountCategory) || undefined;

  return {
    userId,
    username,
    handle: username || undefined,
    fullname: cleanStr(item && item.fullName) || '',
    followers: toNum(item && item.followersCount) || 0,
    engagementRate: toNum(item && item.engagementRate) || 0,
    engagements: undefined,
    averageViews,
    picture: cleanStr(item && item.profilePicture) || undefined,
    url: buildPublicProfileUrl(platform, username, '', userId),
    isVerified: false,
    isPrivate: false,
    platform,
    bio: undefined,
    country: undefined,
    state: undefined,
    city: undefined,
    location: undefined,
    language: undefined,
    categories: category ? [category] : [],
    category,
    primaryCategory: category,
    matchedPosts,
    recentPosts,
    accountCategory: category,
    searchType: 'ai',
    source: 'ai',
    aiMatchedPostsCount: matchedPosts.length,
  };
}

function buildAiSearchBody(platform, payload = {}) {
  const ai = payload.ai || {};
  const filters = deepClone(ai.filters || payload.filters || {});

  if (Array.isArray(ai.brands) && ai.brands.length) {
    filters.brands = ai.brands;
  }

  return {
    page: ai.page != null ? ai.page : payload.page != null ? payload.page : 0,
    query: cleanStr(ai.query || payload.query || ''),
    filters,
  };
}

function collectStandardSearchItems(platform, data) {
  const bag = []
    .concat(Array.isArray(data && data.results) ? data.results : [])
    .concat(Array.isArray(data && data.items) ? data.items : [])
    .concat(Array.isArray(data && data.influencers) ? data.influencers : [])
    .concat(Array.isArray(data && data.directs) ? data.directs : [])
    .concat(Array.isArray(data && data.lookalikes) ? data.lookalikes : [])
    .concat(Array.isArray(data && data.users) ? data.users : [])
    .concat(Array.isArray(data && data.channels) ? data.channels : []);

  return bag.map((item) => {
    const normalized = normalizeSearchItem(item, platform);
    normalized.searchType = 'standard';
    normalized.source = 'standard';
    return normalized;
  });
}

async function runStandardPlatformSearch(platform, body) {
  const firstBody = buildPlatformBody(platform, body);
  let data = await modashPOST(`/${platform}/search`, firstBody);

  const enableFallback = (process.env.MODASH_YT_FALLBACK || '1') !== '0';
  if (platform === 'youtube' && enableFallback && Number((data && data.total) || 0) === 0) {
    const retryBody = buildPlatformBody(platform, body, { relax: true });
    try {
      const retryData = await modashPOST(`/${platform}/search`, retryBody);
      if (retryData && Number((retryData && retryData.total) || 0) > 0) {
        data = retryData;
      }
    } catch {
      // ignore youtube fallback retry errors
    }
  }

  return {
    platform,
    kind: 'standard',
    data,
    total: Number((data && data.total) || 0),
    results: collectStandardSearchItems(platform, data),
  };
}

async function runAiPlatformSearch(platform, payload) {
  const body = buildAiSearchBody(platform, payload);
  const data = await modashPOST(`/ai/${platform}/text-search`, body);
  const profiles = Array.isArray(data && data.profiles) ? data.profiles : [];

  return {
    platform,
    kind: 'ai',
    data,
    total: Number((data && data.total) || 0),
    results: profiles.map((item) => normalizeAiSearchItem(item, platform)),
  };
}

function sortUnifiedResults(items = []) {
  return items.slice().sort((a, b) => {
    const aAi = a.searchType === 'ai' ? 1 : 0;
    const bAi = b.searchType === 'ai' ? 1 : 0;
    if (bAi !== aAi) return bAi - aAi;
    if ((b.aiMatchedPostsCount || 0) !== (a.aiMatchedPostsCount || 0)) {
      return (b.aiMatchedPostsCount || 0) - (a.aiMatchedPostsCount || 0);
    }
    if (!!b.isVerified !== !!a.isVerified) return b.isVerified ? 1 : -1;
    if ((b.followers || 0) !== (a.followers || 0)) return (b.followers || 0) - (a.followers || 0);
    if ((b.engagementRate || 0) !== (a.engagementRate || 0)) {
      return (b.engagementRate || 0) - (a.engagementRate || 0);
    }
    return String(a.username || '').localeCompare(String(b.username || ''));
  });
}

function mergeUnifiedSearchItems(items = []) {
  const map = new Map();

  for (const item of items) {
    const keyBase =
      (item.userId && String(item.userId).toLowerCase()) ||
      (item.username && String(item.username).toLowerCase()) ||
      (item.url && String(item.url).toLowerCase());

    if (!keyBase) continue;

    const key = `${item.platform}:${keyBase}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, item);
      continue;
    }

    const primary = betterSearchResult(prev, item);
    const secondary = primary === prev ? item : prev;
    const merged = mergeSearchItem(primary, secondary);

    if (!Array.isArray(merged.matchedPosts) || !merged.matchedPosts.length) {
      merged.matchedPosts = Array.isArray(primary.matchedPosts) && primary.matchedPosts.length
        ? primary.matchedPosts
        : secondary.matchedPosts;
    }

    if (!Array.isArray(merged.recentPosts) || !merged.recentPosts.length) {
      merged.recentPosts = Array.isArray(primary.recentPosts) && primary.recentPosts.length
        ? primary.recentPosts
        : secondary.recentPosts;
    }

    if (!merged.accountCategory) {
      merged.accountCategory = primary.accountCategory || secondary.accountCategory;
    }

    merged.aiMatchedPostsCount = Math.max(
      Number(primary.aiMatchedPostsCount || 0),
      Number(secondary.aiMatchedPostsCount || 0)
    );

    merged.searchType =
      primary.searchType === 'ai' || secondary.searchType === 'ai'
        ? (primary.searchType === 'standard' || secondary.searchType === 'standard' ? 'combined' : 'ai')
        : 'standard';

    merged.source = merged.searchType;
    map.set(key, merged);
  }

  return Array.from(map.values());
}

async function frontendUnifiedSearch(req, res) {
  try {
    const payload = req.body || {};
    const brandId = cleanStr(payload.brandId || payload.brand_id || '');

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required for search' });
    }

    try {
      await ensureSearchQuota(brandId);
    } catch (e) {
      if (e.code === 'QUOTA_EXCEEDED') {
        return res.status(403).json({
          error: 'You have reached your monthly search limit.',
          meta: e.meta,
        });
      }
      throw e;
    }

    const requestedPlatforms = Array.isArray(payload.platforms) && payload.platforms.length
      ? payload.platforms
      : ['instagram', 'youtube', 'tiktok'];

    const platforms = [];
    for (const rawPlatform of requestedPlatforms) {
      const platform = normalizePlatform(rawPlatform);
      if (!platform) {
        return res.status(400).json({ error: `Unsupported platform: ${rawPlatform}` });
      }
      if (!platforms.includes(platform)) platforms.push(platform);
    }

    const searchMode = cleanStr(payload.searchMode || payload.mode || '').toLowerCase();
    const hasStandardBody = !!payload.body;
    const hasAiConfig = !!payload.ai;

    const doStandard =
      searchMode === 'combined' ||
      searchMode === 'all' ||
      searchMode === 'standard' ||
      (!searchMode && hasStandardBody);

    const doAi =
      searchMode === 'combined' ||
      searchMode === 'all' ||
      searchMode === 'ai' ||
      (!searchMode && hasAiConfig);

    if (!doStandard && !doAi) {
      return res.status(400).json({
        error: 'Provide searchMode=standard|ai|combined and body and/or ai payload.',
      });
    }

    if (doStandard && !payload.body) {
      return res.status(400).json({ error: 'body is required for standard search.' });
    }

    if (doAi && !cleanStr(payload?.ai?.query || payload?.query || '')) {
      return res.status(400).json({ error: 'ai.query is required for AI search.' });
    }

    const aiDelayMs = Math.max(
      0,
      parseInt(String(payload.aiDelayMs ?? process.env.MODASH_AI_DELAY_MS ?? 1100), 10) || 0
    );

    const responses = [];

    if (doStandard) {
      for (const platform of platforms) {
        const result = await runStandardPlatformSearch(platform, payload.body);
        responses.push(result);
      }
    }

    if (doAi) {
      let aiCallIndex = 0;
      for (const platform of platforms) {
        if (aiCallIndex > 0 && aiDelayMs > 0) {
          await sleep(aiDelayMs);
        }
        const result = await runAiPlatformSearch(platform, payload);
        responses.push(result);
        aiCallIndex += 1;
      }
    }

    const merged = mergeUnifiedSearchItems(
      responses.flatMap((entry) => Array.isArray(entry.results) ? entry.results : [])
    );

    const cachedEnriched = await enrichResultsFromCache(merged);
    const sortedResults = sortUnifiedResults(cachedEnriched);

    const standardTotal = responses
      .filter((entry) => entry.kind === 'standard')
      .reduce((sum, entry) => sum + Number(entry.total || 0), 0);

    const aiTotal = responses
      .filter((entry) => entry.kind === 'ai')
      .reduce((sum, entry) => sum + Number(entry.total || 0), 0);

    return res.json({
      searchMode: doStandard && doAi ? 'combined' : doAi ? 'ai' : 'standard',
      results: sortedResults,
      total: standardTotal + aiTotal,
      unique: sortedResults.length,
      meta: {
        standardTotal,
        aiTotal,
        platforms,
        aiDelayMs: doAi ? aiDelayMs : 0,
        perPlatform: responses.map((entry) => ({
          platform: entry.platform,
          kind: entry.kind,
          total: entry.total,
          resultCount: Array.isArray(entry.results) ? entry.results.length : 0,
        })),
      },
    });
  } catch (err) {
    const safe = buildSafeErrorMessage(err, 'Unified search failed');
    const status = (err && err.status) || 400;
    return res.status(status).json({ error: safe });
  }
}

/* -------------------------------------------------------------------------- */
/*                              Saved filters                                 */
/* -------------------------------------------------------------------------- */

function buildSavedInfluencerMongoFilter(input = {}) {
  const ands = [];

  const provider = cleanStr(input.provider || input.platform || '').toLowerCase();
  const platforms = parseMultiValue(input.platforms)
    .map((x) => cleanStr(x).toLowerCase())
    .filter((x) => ALLOWED_PLATFORMS.has(x));

  if (provider && provider !== 'all' && ALLOWED_PLATFORMS.has(provider)) {
    ands.push({ provider });
  } else if (platforms.length === 1) {
    ands.push({ provider: platforms[0] });
  } else if (platforms.length > 1) {
    ands.push({ provider: { $in: platforms } });
  }

  const influencerId = cleanStr(input.influencerId || input.influencer_id || '');
  if (influencerId) ands.push({ influencerId });

  const followersMin =
    input.followersMin ?? input.followers_min ?? input.minFollowers ?? input.min_followers;
  const followersMax =
    input.followersMax ?? input.followers_max ?? input.maxFollowers ?? input.max_followers;

  let min = parseFlexibleNumber(followersMin);
  let max = parseFlexibleNumber(followersMax);
  if (min !== null || max !== null) {
    if (min !== null && max !== null && min > max) [min, max] = [max, min];

    const range = {};
    if (min !== null) range.$gte = min;
    if (max !== null) range.$lte = max;
    ands.push({ followers: range });
  }

  const countryTokens = normalizeCountryTokens(parseMultiValue(input.countries || input.country));
  if (countryTokens.length) {
    ands.push({ country: { $in: countryTokens.map(exactCI) } });
  }

  const categories = parseMultiValue(
    input.categories ||
    input.category ||
    input.niche ||
    input.niches ||
    input.category_name ||
    input.categoryName
  );
  if (categories.length) {
    const categoryRegexes = categories.map((x) => containsCI(x));
    ands.push({
      $or: [
        { categories: { $elemMatch: { categoryName: { $in: categoryRegexes } } } },
        { categories: { $elemMatch: { subcategoryName: { $in: categoryRegexes } } } },
      ],
    });
  }

  const requireLinked = cleanStr(input.requireLinked || '0') === '1';
  if (requireLinked) {
    ands.push({
      $or: [
        { influencer: { $exists: true, $ne: null } },
        { influencerId: { $exists: true, $ne: '' } },
      ],
    });
  }

  const requireCategories = cleanStr(input.requireCategories || '0') === '1';
  if (requireCategories) {
    ands.push({ 'categories.0': { $exists: true } });
  }

  const q = cleanStr(input.q || input.search || '');
  if (q) {
    const qNoAt = q.replace(/^@/, '').trim();
    const qRx = containsCI(q);
    const qNoAtRx = qNoAt && qNoAt.toLowerCase() !== q.toLowerCase() ? containsCI(qNoAt) : null;

    const ors = [
      { username: qRx },
      { fullname: qRx },
      { handle: qRx },
      { url: qRx },
      { userId: qRx },
      { influencerId: qRx },
      { bio: qRx },
      { country: qRx },
      { state: qRx },
      { city: qRx },
      { categories: { $elemMatch: { categoryName: qRx } } },
      { categories: { $elemMatch: { subcategoryName: qRx } } },
    ];

    if (qNoAtRx) {
      ors.push({ username: qNoAtRx }, { handle: qNoAtRx });
    }

    ands.push({ $or: ors });
  }

  return ands.length ? { $and: ands } : {};
}

function buildSavedSort(sortKey, dirParam) {
  const dir = cleanStr(dirParam).toLowerCase() === 'asc' ? 1 : -1;
  const sort = cleanStr(sortKey || 'updatedAt').toLowerCase();

  if (sort === 'followers') return { followers: dir, updatedAt: -1 };
  if (sort === 'createdat') return { createdAt: dir };
  return { updatedAt: dir };
}

function mapSavedDoc(doc, canShowSensitive = false) {
  const safe = sanitizeModashDocForViewer(doc, canShowSensitive);
  const categoryNames = categoryNamesFromObjects(safe.categories);

  return {
    ...safe,
    platform: safe.provider,
    category: categoryNames,
    categories: safe.categories || [],
    location: buildLocationLabel(safe.city, safe.state, safe.country) || undefined,
  };
}

function getCategoryStringsFromSearchItem(item) {
  return uniqStrings(
    []
      .concat(asArray(item.categories))
      .concat(asArray(item.category))
      .concat(asArray(item.primaryCategory))
  );
}

function applyLocalSearchFilters(items = [], input = {}) {
  let out = Array.isArray(items) ? items.slice() : [];

  const provider = cleanStr(input.provider || input.platform || '').toLowerCase();
  const platforms = parseMultiValue(input.platforms)
    .map((x) => cleanStr(x).toLowerCase())
    .filter((x) => ALLOWED_PLATFORMS.has(x));

  if (provider && provider !== 'all' && ALLOWED_PLATFORMS.has(provider)) {
    out = out.filter((item) => cleanStr(item.platform).toLowerCase() === provider);
  } else if (platforms.length) {
    out = out.filter((item) => platforms.includes(cleanStr(item.platform).toLowerCase()));
  }

  const followersMin =
    input.followersMin ?? input.followers_min ?? input.minFollowers ?? input.min_followers;
  const followersMax =
    input.followersMax ?? input.followers_max ?? input.maxFollowers ?? input.max_followers;

  let min = parseFlexibleNumber(followersMin);
  let max = parseFlexibleNumber(followersMax);
  if (min !== null || max !== null) {
    if (min !== null && max !== null && min > max) [min, max] = [max, min];

    out = out.filter((item) => {
      const f = Number(item.followers || 0);
      if (min !== null && f < min) return false;
      if (max !== null && f > max) return false;
      return true;
    });
  }

  const countries = normalizeCountryTokens(parseMultiValue(input.countries || input.country)).map((x) => x.toLowerCase());
  if (countries.length) {
    out = out.filter((item) => countries.includes(cleanStr(item.country).toLowerCase()));
  }

  const categories = parseMultiValue(
    input.categories || input.category || input.niche || input.niches || input.category_name || input.categoryName
  ).map((x) => x.toLowerCase());
  if (categories.length) {
    out = out.filter((item) => {
      const hay = getCategoryStringsFromSearchItem(item).map((x) => cleanStr(x).toLowerCase());
      return categories.some((cat) => hay.some((value) => value.includes(cat)));
    });
  }

  const q = cleanStr(input.q || input.search || '').replace(/^@/, '').toLowerCase();
  if (q) {
    out = out.filter((item) => {
      const hay = [
        item.username,
        item.handle,
        item.fullname,
        item.url,
        item.userId,
        item.bio,
        item.country,
        item.state,
        item.city,
        ...getCategoryStringsFromSearchItem(item),
      ]
        .map((x) => cleanStr(x).toLowerCase())
        .filter(Boolean);

      return hay.some((value) => value.includes(q));
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*                               Controllers                                  */
/* -------------------------------------------------------------------------- */

async function frontendUsers(req, res) {
  try {
    const { page, limit } = parsePagination(req.query.page, req.query.limit, {
      page: 0,
      limit: 20,
      maxLimit: MAX_LIST_LIMIT,
    });

    const qParam = cleanStr(req.query.q || '');
    const queries = qParam
      .split(',')
      .map((s) => s.replace(/^@/, '').trim().toLowerCase())
      .filter(Boolean);

    const platforms = normalizePlatforms(req.query.platform, req.query.platforms);
    const effectivePlatforms = platforms.length ? platforms : ['instagram', 'youtube', 'tiktok'];

    const strict = req.query.strict === '1' || req.query.strict === 'true';
    const matchMode = cleanStr(req.query.match || 'exact-first').toLowerCase();

    if (!queries.length) {
      return res.status(400).json({
        error: 'Provide ?q=<handle>[,handle...]',
      });
    }

    const collected = [];

    for (const platform of effectivePlatforms) {
      for (const q of queries) {
        const data = await modashGET(`/${platform}/users`, {
          limit: Math.max(25, limit * 3),
          query: q,
        });

        const users = Array.isArray(data && data.users) ? data.users : [];
        for (const raw of users) {
          const u = normalizeSearchItem(raw, platform);
          if (!u.username && !u.url) continue;
          collected.push({ ...u, __score: scoreForQuery(u, q) });
        }
      }
    }

    let results = dedupeByBest(collected);

    if (strict || matchMode === 'exact') {
      const qset = new Set(queries);
      results = results.filter((u) => {
        const uname = String(u.username || u.handle || '').toLowerCase();
        const url = String(u.url || '').toLowerCase();
        if (qset.has(uname)) return true;
        for (const q of qset) {
          if (url.indexOf(`/@${q}`) !== -1) return true;
        }
        return false;
      });
    }

    results.sort((a, b) => {
      const scoreDiff = (b.__score || 0) - (a.__score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      if (!!b.isVerified !== !!a.isVerified) return b.isVerified ? 1 : -1;
      if ((b.followers || 0) !== (a.followers || 0)) return (b.followers || 0) - (a.followers || 0);
      return String(a.username || '').localeCompare(String(b.username || ''));
    });

    const safeResults = results.map(({ __score, ...rest }) => rest);
    const cachedEnriched = await enrichResultsFromCache(safeResults);
    const filtered = applyLocalSearchFilters(cachedEnriched, req.query);

    const total = filtered.length;
    const paged = filtered.slice(page * limit, page * limit + limit);

    return res.json({ page, limit, total, results: paged });
  } catch (err) {
    const safe = buildSafeErrorMessage(err, 'Lookup failed');
    const status = (err && err.status) || 400;
    return res.status(status).json({ error: safe });
  }
}

async function frontendSearch(req, res) {
  try {
    const payload = req.body || {};
    const brandId = cleanStr(payload.brandId || payload.brand_id || '');

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required for search' });
    }

    try {
      await ensureSearchQuota(brandId);
    } catch (e) {
      if (e.code === 'QUOTA_EXCEEDED') {
        return res.status(403).json({
          error: 'You have reached your monthly search limit.',
          meta: e.meta,
        });
      }
      throw e;
    }

    const platforms = Array.isArray(payload.platforms) ? payload.platforms : [];
    const body = payload.body || {};

    if (!platforms.length || !body) {
      return res.status(400).json({ error: 'Provide { brandId, platforms, body }' });
    }

    const responses = [];

    for (const rawPlatform of platforms) {
      const platform = normalizePlatform(rawPlatform);
      if (!platform) {
        return res.status(400).json({ error: `Unsupported platform: ${rawPlatform}` });
      }

      const firstBody = buildPlatformBody(platform, body);
      let data = await modashPOST(`/${platform}/search`, firstBody);

      const enableFallback = (process.env.MODASH_YT_FALLBACK || '1') !== '0';
      if (platform === 'youtube' && enableFallback && Number((data && data.total) || 0) === 0) {
        const retryBody = buildPlatformBody(platform, body, { relax: true });
        try {
          const retryData = await modashPOST(`/${platform}/search`, retryBody);
          if (retryData && Number((retryData && retryData.total) || 0) > 0) {
            data = retryData;
          }
        } catch {
          // ignore youtube fallback retry errors
        }
      }

      responses.push({ platform, data });
    }

    const collected = [];
    for (const { platform, data } of responses) {
      const bag = []
        .concat(Array.isArray(data && data.results) ? data.results : [])
        .concat(Array.isArray(data && data.items) ? data.items : [])
        .concat(Array.isArray(data && data.influencers) ? data.influencers : [])
        .concat(Array.isArray(data && data.directs) ? data.directs : [])
        .concat(Array.isArray(data && data.lookalikes) ? data.lookalikes : [])
        .concat(Array.isArray(data && data.users) ? data.users : [])
        .concat(Array.isArray(data && data.channels) ? data.channels : []);

      for (const item of bag) {
        collected.push(normalizeSearchItem(item, platform));
      }
    }

    const merged = dedupeSearchItems(collected);
    const cachedEnriched = await enrichResultsFromCache(merged);

    const total = responses.reduce((sum, r) => sum + Number((r.data && r.data.total) || 0), 0);

    return res.json({
      results: cachedEnriched,
      total,
      unique: cachedEnriched.length,
    });
  } catch (err) {
    const safe = buildSafeErrorMessage(err, 'Search failed');
    const status = (err && err.status) || 400;
    return res.status(status).json({ error: safe });
  }
}

async function frontendReport(req, res) {
  try {
    const brandId = cleanStr(req.query.brandId || req.query.brand_id || '');
    const adminId = cleanStr(req.query.adminId || req.query.admin_id || '');
    const isAdmin = !!adminId;
    const canShowSensitive = !!cleanStr(adminId);

    const isProfile =
      req.query.isProfile === '1' ||
      req.query.isProfile === 'true' ||
      req.query.isProfile === true;

    const skipProfileCredit =
      isProfile ||
      req.query.np === '1' ||
      req.query.np === 'true' ||
      req.query.noProfileCredit === '1' ||
      req.query.noProfileCredit === 'true';

    if (!skipProfileCredit && !brandId && !adminId) {
      return res
        .status(400)
        .json({ error: 'brandId or adminId is required for profile views' });
    }

    const platform = normalizePlatform(req.query.platform || '');
    const requestedUserId = cleanStr(req.query.userId || '');
    const calculationMethod = toCalcMethod(req.query.calculationMethod);
    let influencerId =
      cleanStr(req.query.influencerId || req.query.influencer_id || '') || null;

    const forceFresh =
      req.query.force === '1' ||
      req.query.force === 'true' ||
      req.query.refresh === '1' ||
      req.query.refresh === 'true';

    if (!platform) {
      return res
        .status(400)
        .json({ error: 'platform must be instagram|tiktok|youtube' });
    }

    if (!requestedUserId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    let resolvedUserId = requestedUserId;

    if (mongoose.Types.ObjectId.isValid(requestedUserId)) {
      try {
        const localDoc = await ModashProfile.findOne({
          _id: requestedUserId,
          provider: platform,
        })
          .select({
            userId: 1,
            influencerId: 1,
          })
          .lean();

        if (localDoc?.userId) {
          resolvedUserId = cleanStr(localDoc.userId);
          if (!influencerId && localDoc.influencerId) {
            influencerId = cleanStr(localDoc.influencerId);
          }
        }
      } catch (resolveErr) {
        console.error(
          '[frontendReport] Failed to resolve local Modash _id:',
          resolveErr
        );
      }
    }

    const now = new Date();
    const periodKey = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1
    ).padStart(2, '0')}`;

    const shouldChargeProfileView =
      !skipProfileCredit && !isAdmin && !!brandId;

    let alreadyViewedThisPeriod = false;

    if (shouldChargeProfileView) {
      try {
        const existingView = await BrandProfileView.findOne({
          brandId,
          platform,
          userId: resolvedUserId,
          periodKey,
        }).lean();

        alreadyViewedThisPeriod = !!existingView;
      } catch (e) {
        console.error(
          '[frontendReport] Failed to check BrandProfileView:',
          e.message
        );
      }
    }

    if (shouldChargeProfileView && !alreadyViewedThisPeriod) {
      try {
        await ensureProfileQuota(brandId);
      } catch (e) {
        if (e.code === 'QUOTA_EXCEEDED') {
          return res.status(403).json({
            error: 'You have reached your monthly profile view limit.',
            meta: e.meta,
          });
        }
        throw e;
      }
    }

    if (!forceFresh) {
      try {
        const cached = await findCachedReport({
          platform,
          userId: resolvedUserId,
          influencerId,
        });

        if (cached && cached.providerRaw) {
          const out = sanitizeModashReportForViewer(
            Object.assign({}, cached.providerRaw),
            canShowSensitive
          );

          if (cached.lastFetchedAt) {
            const d = new Date(cached.lastFetchedAt);
            if (!isNaN(d.getTime())) {
              out._lastFetchedAt = d.toISOString();
            }
          }

          if (shouldChargeProfileView) {
            await recordBrandProfileView({
              brandId,
              platform,
              userId: resolvedUserId,
              influencerId,
              periodKey,
              at: now,
            });
          }

          return res.json(out);
        }
      } catch (cacheErr) {
        console.error(
          '[frontendReport] Cache lookup failed:',
          cacheErr.message
        );
      }
    }

    let reportJSON;
    try {
      reportJSON = await modashGET(
        `/${platform}/profile/${encodeURIComponent(resolvedUserId)}/report`,
        { calculationMethod }
      );
    } catch (apiErr) {
      const raw = (apiErr && apiErr.message) || '';
      let safeMsg = 'Report unavailable';

      try {
        const errResp = apiErr && apiErr.response;
        const rawMsg = (errResp && (errResp.message || errResp.error)) || raw;
        const isSensitive =
          /api token|developer section|modash|authorization|bearer|modash_api_key|marketer\.modash\.io/i.test(
            String(rawMsg)
          );

        safeMsg = isSensitive ? 'Report unavailable' : rawMsg || safeMsg;
      } catch {
        // ignore parsing errors
      }

      const status = apiErr && apiErr.status ? apiErr.status : 502;
      return res.status(status).json({ error: safeMsg });
    }

    const fetchedAt = new Date();

    try {
      const normalized = normalizeReportData(reportJSON);

      await upsertModashProfileFromReport(normalized, platform, {
        userIdFromRequest: resolvedUserId,
        influencerId,
      });
    } catch (saveErr) {
      console.error(
        '[frontendReport] Failed to save Modash profile to database:',
        saveErr
      );
    }

    const out = sanitizeModashReportForViewer(
      Object.assign({}, reportJSON, {
        _lastFetchedAt: fetchedAt.toISOString(),
      }),
      canShowSensitive
    );

    if (shouldChargeProfileView) {
      await recordBrandProfileView({
        brandId,
        platform,
        userId: resolvedUserId,
        influencerId,
        periodKey,
        at: fetchedAt,
      });
    }

    return res.json(out);
  } catch (err) {
    console.error('[frontendReport] Unexpected error:', err);
    return res
      .status(500)
      .json({ error: (err && err.message) || 'Internal error' });
  }
}

/* -------------------------------------------------------------------------- */
/*                           Legacy resolve/search                            */
/* -------------------------------------------------------------------------- */

async function searchForUsername(platform, username) {
  const clean = cleanStr(username).replace(/^@/, '');
  if (!clean) return null;

  const body = {
    page: 1,
    calculationMethod: 'median',
    sort: { field: 'relevance', direction: 'desc' },
    filter: { influencer: { relevance: [`@${clean}`] } },
  };

  const result = await modashPOST(`/${platform}/search`, body);
  const candidates = []
    .concat(Array.isArray(result && result.directs) ? result.directs : [])
    .concat(Array.isArray(result && result.lookalikes) ? result.lookalikes : []);

  if (!candidates.length) return null;

  const target =
    candidates.find((it) => {
      const prof = (it && it.profile) || {};
      const u = cleanStr(prof.username).toLowerCase();
      const h = cleanStr(prof.handle).toLowerCase().replace(/^@/, '');
      const c = clean.toLowerCase();
      return u === c || h === c;
    }) || candidates[0];

  if (!target) return null;

  const prof = (target && target.profile) || {};
  const id = target.userId || prof.userId;
  if (!id) return null;

  return {
    userId: String(id),
    username: cleanStr(prof.username),
    handle: cleanStr(prof.handle),
    picture: prof.picture,
    url: prof.url,
    followers: prof.followers,
  };
}

async function getReportLegacy(platform, userIdOrHandle) {
  const id = cleanStr(userIdOrHandle);
  return modashGET(`/${platform}/profile/${encodeURIComponent(id)}/report`, {
    calculationMethod: 'median',
  });
}

function buildPreviewFromReport(reportJSON) {
  const p = (reportJSON && reportJSON.profile) || {};
  const prof = p.profile || p;
  return {
    fullname: prof.fullname || null,
    username: prof.username || null,
    followers: typeof prof.followers === 'number' ? prof.followers : null,
    picture: prof.picture || null,
    url: prof.url || null,
  };
}

async function resolveProfile(req, res) {
  try {
    const platform = normalizePlatform((req.body && req.body.platform) || '');
    let username = cleanStr((req.body && req.body.username) || '');
    if (username.startsWith('@')) username = username.slice(1);

    if (!platform) {
      return res.status(400).json({ message: 'platform must be instagram | youtube | tiktok' });
    }
    if (!username) {
      return res.status(400).json({ message: 'username (handle) is required' });
    }

    let reportJSON = null;
    let userIdResolved = null;

    try {
      reportJSON = await getReportLegacy(platform, username);
      userIdResolved =
        (reportJSON &&
          reportJSON.profile &&
          (reportJSON.profile.userId ||
            (reportJSON.profile.profile && reportJSON.profile.profile.userId))) ||
        null;
    } catch (e) {
      if (e && e.status === 403) {
        return res.status(403).json({
          message: 'Forbidden from Modash. Verify your API key / header type and plan.',
          details: e.response || undefined,
        });
      }
      if (!e || (e.status !== 404 && e.status !== 400)) throw e;
    }

    if (!reportJSON) {
      const hit = await searchForUsername(platform, username);
      if (!hit || !hit.userId) {
        return res.status(404).json({ message: 'No profile found for that username' });
      }

      userIdResolved = hit.userId;
      try {
        reportJSON = await getReportLegacy(platform, userIdResolved);
      } catch (e) {
        if (e && e.status === 403) {
          return res.status(403).json({
            message: 'Forbidden from Modash when fetching report.',
            details: e.response || undefined,
          });
        }
        throw e;
      }
    }

    const normalized = normalizeReportData(reportJSON);
    const preview = buildPreviewFromReport(reportJSON);

    (async () => {
      try {
        await upsertModashProfileFromReport(normalized, platform, {
          userIdFromRequest: userIdResolved || username,
        });
      } catch (saveErr) {
        console.error('[resolveProfile] Failed to save profile:', saveErr.message);
      }
    })();

    return res.json({
      message: 'ok',
      provider: platform,
      userId: userIdResolved || (normalized.profile && normalized.profile.userId) || null,
      preview,
      providerRaw: reportJSON,
      data: normalized,
    });
  } catch (e) {
    if (e && e.status === 403) {
      return res.status(403).json({
        message: 'Forbidden from Modash.',
        details: e.response || undefined,
      });
    }

    if (e && e.status === 404) {
      return res.status(404).json({ message: 'No profile found' });
    }

    console.error('resolveProfile error:', e);
    return res.status(500).json({ message: (e && e.message) || 'Modash error' });
  }
}

async function legacySearch(req, res) {
  try {
    const platform = normalizePlatform(cleanStr((req.body && req.body.platform) || ''));
    if (!platform) {
      return res.status(400).json({ message: 'platform must be instagram | youtube | tiktok' });
    }

    const body = Object.assign({}, req.body);
    delete body.platform;

    const data = await modashPOST(`/${platform}/search`, body || {});
    return res.json(data);
  } catch (e) {
    if (e && e.status === 403) {
      return res.status(403).json({ message: 'Forbidden from Modash', details: e.response || undefined });
    }

    return res.status(500).json({ message: (e && e.message) || 'Modash error' });
  }
}

/* -------------------------------------------------------------------------- */
/*                         Saved / random / export                            */
/* -------------------------------------------------------------------------- */

function influencerTierFromFollowers(followers) {
  const f = Number(followers || 0);
  if (f < 10000) return { key: 'nano', label: 'Nano (0-10K)' };
  if (f < 100000) return { key: 'micro', label: 'Micro (10K-100K)' };
  if (f < 500000) return { key: 'mid', label: 'Mid (100K-500K)' };
  if (f < 1000000) return { key: 'macro', label: 'Macro (500K-1M)' };
  return { key: 'mega', label: 'Mega (1M+)' };
}

function groupCategories(categoryLinks) {
  const links = Array.isArray(categoryLinks) ? categoryLinks : [];
  const catMap = new Map();

  for (const c of links) {
    if (!c) continue;

    const categoryId = c.categoryId;
    const categoryName = cleanStr(c.categoryName);
    const subcategoryId = cleanStr(c.subcategoryId);
    const subcategoryName = cleanStr(c.subcategoryName);
    const key = String(categoryId ?? categoryName ?? '');
    if (!key) continue;

    if (!catMap.has(key)) {
      catMap.set(key, {
        categoryId: categoryId ?? null,
        categoryName: categoryName || null,
        subcategories: [],
      });
    }

    if (subcategoryId || subcategoryName) {
      const obj = catMap.get(key);
      const exists = obj.subcategories.some((s) => String(s.subcategoryId) === String(subcategoryId));
      if (!exists) {
        obj.subcategories.push({
          subcategoryId: subcategoryId || null,
          subcategoryName: subcategoryName || null,
        });
      }
    }
  }

  return Array.from(catMap.values());
}

async function getSavedInfluencers(req, res) {
  try {
    const { page, limit } = parsePagination(req.query.page, req.query.limit, {
      page: 0,
      limit: 20,
      maxLimit: MAX_LIST_LIMIT,
    });

    const adminId = cleanStr(req.query.adminId || req.query.admin_id || '');
    const canShowSensitive = canShowSensitiveFromRequest(req, { adminId });

    const filter = buildSavedInfluencerMongoFilter(req.query);
    const sort = buildSavedSort(req.query.sort, req.query.dir);

    const projection = {
      provider: 1,
      userId: 1,
      username: 1,
      fullname: 1,
      handle: 1,
      url: 1,
      picture: 1,
      followers: 1,
      engagements: 1,
      engagementRate: 1,
      averageViews: 1,
      isVerified: 1,
      isPrivate: 1,
      accountType: 1,
      secUid: 1,

      city: 1,
      state: 1,
      subdivision: 1,
      country: 1,
      gender: 1,
      ageGroup: 1,
      language: 1,
      bio: 1,
      description: 1,

      postsCount: 1,
      postsCounts: 1,
      avgLikes: 1,
      avgComments: 1,
      avgViews: 1,
      avgReelsPlays: 1,
      totalLikes: 1,
      totalViews: 1,

      stats: 1,
      statsByContentType: 1,

      categories: 1,
      hashtags: 1,
      mentions: 1,
      brandAffinity: 1,
      interests: 1,
      contacts: 1,

      audience: 1,
      audienceCommenters: 1,
      audienceExtra: 1,
      lookalikes: 1,

      recentPosts: 1,
      popularPosts: 1,
      sponsoredPosts: 1,
      statHistory: 1,

      paidPostPerformance: 1,
      paidPostPerformanceViews: 1,
      sponsoredPostsMedianViews: 1,
      sponsoredPostsMedianLikes: 1,
      nonSponsoredPostsMedianViews: 1,
      nonSponsoredPostsMedianLikes: 1,

      providerRaw: 1,
      influencerId: 1,
      influencer: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    const [docs, total] = await Promise.all([
      ModashProfile.find(filter)
        .select(projection)
        .sort(sort)
        .skip(page * limit)
        .limit(limit)
        .lean(),
      ModashProfile.countDocuments(filter),
    ]);

    return res.json({
      page,
      limit,
      total,
      results: docs.map((doc) => mapSavedDoc(doc, canShowSensitive)),
    });
  } catch (err) {
    console.error('[getSavedInfluencers] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

async function getRandomInfluencers(req, res) {
  try {
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(MAX_RANDOM_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));

    const provider = normalizePlatform(req.query.provider || req.query.platform || '');
    if ((req.query.provider || req.query.platform) && !provider) {
      return res.status(400).json({ error: 'provider must be instagram|tiktok|youtube' });
    }

    const minFollowers = Number.isFinite(Number(req.query.minFollowers)) ? Number(req.query.minFollowers) : undefined;
    const maxFollowers = Number.isFinite(Number(req.query.maxFollowers)) ? Number(req.query.maxFollowers) : undefined;
    const requireLinked = cleanStr(req.query.requireLinked || '0') === '1';
    const requireCategories = cleanStr(req.query.requireCategories || '0') === '1';

    const match = {};
    if (provider) match.provider = provider;

    if (minFollowers !== undefined || maxFollowers !== undefined) {
      match.followers = {};
      if (minFollowers !== undefined) match.followers.$gte = minFollowers;
      if (maxFollowers !== undefined) match.followers.$lte = maxFollowers;
    }

    if (requireLinked) {
      match.$or = [
        { influencer: { $exists: true, $ne: null } },
        { influencerId: { $exists: true, $ne: '' } },
      ];
    }

    if (requireCategories) {
      match['categories.0'] = { $exists: true };
    }

    const pipeline = [
      { $match: match },
      { $sample: { size: limit } },
      {
        $project: {
          _id: 1,
          influencer: 1,
          influencerId: 1,
          provider: 1,
          userId: 1,
          fullname: 1,
          username: 1,
          handle: 1,
          url: 1,
          picture: 1,
          followers: 1,
          engagementRate: 1,
          engagements: 1,
          averageViews: 1,
          isVerified: 1,
          isPrivate: 1,
          country: 1,
          state: 1,
          city: 1,
          categories: 1,
          updatedAt: 1,
        },
      },
    ];

    const rows = await ModashProfile.aggregate(pipeline);
    const results = rows.map((r) => {
      const username = cleanStr(r.username).replace(/^@/, '');
      const handle = cleanStr(r.handle || (username ? `@${username}` : ''));
      const followers = Number(r.followers || 0);
      const tier = influencerTierFromFollowers(followers);

      return {
        ids: {
          modashId: String(r._id),
          influencerObjectId: r.influencer ? String(r.influencer) : null,
          influencerId: cleanStr(r.influencerId) || null,
          userId: cleanStr(r.userId) || null,
        },
        name: cleanStr(r.fullname) || null,
        username: username || null,
        handle: handle || null,
        platform: cleanStr(r.provider) || null,
        followers,
        tier,
        categories: groupCategories(r.categories),
        picture: cleanStr(r.picture) || null,
        url: cleanStr(r.url) || null,
        isVerified: !!r.isVerified,
        isPrivate: !!r.isPrivate,
        stats: {
          engagementRate: typeof r.engagementRate === 'number' ? r.engagementRate : null,
          engagements: typeof r.engagements === 'number' ? r.engagements : null,
          averageViews: typeof r.averageViews === 'number' ? r.averageViews : null,
        },
        location: {
          country: cleanStr(r.country) || null,
          state: cleanStr(r.state) || null,
          city: cleanStr(r.city) || null,
        },
      };
    });

    return res.json({ count: results.length, results });
  } catch (err) {
    console.error('[getRandomInfluencers] Error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

async function exportSavedInfluencersCsv(req, res) {
  try {
    const body = req.body || {};

    const idsRaw = body.modashIds ?? body.ids ?? body.selectedIds ?? null;
    const selectedIds = Array.isArray(idsRaw)
      ? idsRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const requestedLimit = Math.min(
      MAX_EXPORT_LIMIT,
      Math.max(1, parseInt(String(body.limit ?? body.downloadLimit ?? body.count ?? 1000), 10) || 1000)
    );

    const filter = buildSavedInfluencerMongoFilter(body);

    if (selectedIds.length) {
      const objIds = selectedIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      if (!objIds.length) {
        return res.status(400).json({ error: 'No valid modashIds provided.' });
      }

      if (!filter.$and) filter.$and = [];
      filter.$and.push({ _id: { $in: objIds } });
    }

    const sort = buildSavedSort(body.sort || body.sortBy || 'updatedAt', body.dir || body.sortOrder || 'desc');

    const projection = {
      provider: 1,
      userId: 1,
      username: 1,
      fullname: 1,
      handle: 1,
      url: 1,
      followers: 1,
      engagementRate: 1,
      engagements: 1,
      averageViews: 1,
      country: 1,
      language: 1,
      categories: 1,
      createdAt: 1,
      updatedAt: 1,
      influencerId: 1,
    };

    const limit = selectedIds.length ? Math.min(MAX_EXPORT_LIMIT, selectedIds.length) : requestedLimit;

    let items = await ModashProfile.find(filter).select(projection).sort(sort).limit(limit).lean();

    if (selectedIds.length) {
      const rank = new Map(selectedIds.map((id, idx) => [String(id), idx]));
      items.sort((a, b) => {
        const ra = rank.get(String(a._id)) ?? 999999;
        const rb = rank.get(String(b._id)) ?? 999999;
        return ra - rb;
      });
    }

    const dash = '--';
    const csvEscape = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const fmt = (v) => (v == null || v === '' ? dash : String(v));
    const fmtNum = (v) => (v == null || Number.isNaN(Number(v)) ? dash : String(v));
    const fmtPercent = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dash;
      return `${(n * 100).toFixed(2)}%`;
    };

    const getUsernameNoAt = (doc) => cleanStr(doc.username || doc.handle || '').replace(/^@/, '');
    const getHandleAt = (doc) => {
      const u = getUsernameNoAt(doc);
      return u ? `@${u}` : dash;
    };

    const getLang = (doc) => {
      const l = doc.language;
      if (!l) return dash;
      if (typeof l === 'string') return l || dash;
      if (typeof l === 'object') return cleanStr(l.name) || cleanStr(l.code) || dash;
      return dash;
    };

    const getLinks = (doc) => {
      const u = getUsernameNoAt(doc);
      const prov = cleanStr(doc.provider).toLowerCase();
      const rawUrl = cleanStr(doc.url);

      const yt =
        prov === 'youtube'
          ? rawUrl ||
            (doc.userId
              ? `https://www.youtube.com/channel/${doc.userId}`
              : u
                ? `https://www.youtube.com/@${u}`
                : dash)
          : dash;

      const ig = prov === 'instagram' ? rawUrl || (u ? `https://www.instagram.com/${u}` : dash) : dash;
      const tt = prov === 'tiktok' ? rawUrl || (u ? `https://www.tiktok.com/@${u}` : dash) : dash;

      return { yt, ig, tt };
    };

    const getNiche = (doc) => {
      const cats = Array.isArray(doc.categories) ? doc.categories : [];
      const first = cats[0] || null;
      const name = cleanStr(first?.categoryName || first?.name || '');
      return name || dash;
    };

    const getSubNiche = (doc) => {
      const cats = Array.isArray(doc.categories) ? doc.categories : [];
      const first = cats[0] || null;
      const sub = cleanStr(first?.subcategoryName || first?.subName || first?.subcategory || '');
      return sub || dash;
    };

    const header = [
      'Sr. No.',
      'Handle Title',
      'Influencer Handle',
      'Email',
      'Phone',
      'YouTube Handle link',
      'Instagram Handle link',
      'TikTok Handle link',
      'Country/Region',
      'Language',
      'Niche',
      'Sub-Niche',
      'Subscriber/Follower count',
      'Avg Views (last 15 videos)',
      'Engagement Rate',
      'Upload Frequency',
      'Last Sponsor',
      'Managed by Any Agency',
      'Top Audience Country',
      'Average Audience Age',
      'CollabGlam Demographics link',
      'Last Contacted Date',
      'Last Working Handle',
      'Last 1st followup date',
      'Last 2nd followup date',
      'Status',
      'Reply',
      'Notes',
    ];

    const lines = [header.map(csvEscape).join(',')];
    items.forEach((doc, idx) => {
      const links = getLinks(doc);
      const row = [
        idx + 1,
        fmt(doc.fullname),
        fmt(getHandleAt(doc)),
        dash,
        dash,
        fmt(links.yt),
        fmt(links.ig),
        fmt(links.tt),
        fmt(doc.country),
        fmt(getLang(doc)),
        fmt(getNiche(doc)),
        fmt(getSubNiche(doc)),
        fmtNum(doc.followers),
        fmtNum(doc.averageViews),
        fmtPercent(doc.engagementRate),
        dash,
        dash,
        dash,
        dash,
        dash,
        dash,
        dash,
        fmt(getHandleAt(doc)),
        dash,
        dash,
        dash,
        dash,
        dash,
      ];
      lines.push(row.map(csvEscape).join(','));
    });

    const csv = lines.join('\n');
    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="modash_saved_${stamp}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[exportSavedInfluencersCsv] Error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to export CSV' });
  }
}

async function getMediaKitLink(req, res) {
  try {
    const platform = normalizePlatform(req.query.platform || req.body?.platform || '');
    let username = cleanStr(req.query.username || req.body?.username || '').replace(/^@/, '');

    if (!platform) {
      return res.status(400).json({ error: 'platform must be instagram|youtube|tiktok' });
    }

    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    const usernameRx = exactCI(username);
    const handleRx = exactCI(`@${username}`);

    let saved = await ModashProfile.findOne({
      provider: platform,
      $or: [{ username: usernameRx }, { handle: usernameRx }, { handle: handleRx }],
    })
      .select('_id provider userId username handle fullname')
      .lean();

    if (!saved) {
      const hit = await searchForUsername(platform, username);

      if (!hit || !hit.userId) {
        return res.status(404).json({ error: 'Modash profile not found' });
      }

      const reportJSON = await modashGET(
        `/${platform}/profile/${encodeURIComponent(hit.userId)}/report`,
        { calculationMethod: 'median' }
      );

      const normalized = normalizeReportData(reportJSON);

      await upsertModashProfileFromReport(normalized, platform, {
        userIdFromRequest: hit.userId,
      });

      saved = await ModashProfile.findOne({
        provider: platform,
        userId: String(hit.userId),
      })
        .select('_id provider userId username handle fullname')
        .lean();
    }

    if (!saved) {
      return res.status(404).json({ error: 'Unable to create media kit link' });
    }

    const baseUrl = cleanStr(process.env.CAMPAIGN_BASE_URL || 'http://localhost:3000');
    const publicProfileId = encodeURIComponent(cleanStr(saved.userId) || String(saved._id));
    const publicPlatform = encodeURIComponent(cleanStr(saved.provider));
    const link = `${baseUrl}/mediakit/${publicProfileId}?platform=${publicPlatform}&np=1`;

    return res.json({
      success: true,
      data: {
        modashId: String(saved._id),
        userId: cleanStr(saved.userId) || null,
        platform: saved.provider,
        username: saved.username || saved.handle || username,
        link,
      },
    });
  } catch (err) {
    console.error('[getMediaKitLink] Error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to generate media kit link' });
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Exports                                  */
/* -------------------------------------------------------------------------- */

module.exports = {
  frontendUsers,
  frontendSearch,
  frontendUnifiedSearch,
  frontendReport,

  resolveProfile,
  search: legacySearch,

  normalizeReportData,
  upsertModashProfileFromReport,
  findCachedReport,
  getSavedInfluencers,
  getRandomInfluencers,
  exportSavedInfluencersCsv,
  getMediaKitLink,
};