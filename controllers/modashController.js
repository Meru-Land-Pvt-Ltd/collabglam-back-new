// controllers/modashController.js
'use strict';

require('dotenv').config();
const { fetch } = require('undici');
const mongoose = require('mongoose');

const ModashProfile = require('../models/modash');
const Influencer = require('../models/influencer'); // kept for future use
const { ensureBrandQuota } = require('../utils/quota');
const BrandProfileView = require('../models/brandProfileView');

/* -------------------------------------------------------------------------- */
/*                              Config & constants                            */
/* -------------------------------------------------------------------------- */

const MODASH_API_KEY = process.env.MODASH_API_KEY;
const MODASH_BASE_URL =
  process.env.MODASH_BASE_URL || 'https://api.modash.io/v1';
const MODASH_AUTH_HEADER = (process.env.MODASH_AUTH_HEADER || '').toLowerCase();

if (!MODASH_API_KEY) {
  throw new Error('MODASH_API_KEY is missing. Add it to your environment.');
}

const ALLOWED_PLATFORMS = new Set(['instagram', 'youtube', 'tiktok']);
const DEFAULT_YT_SORT = { field: 'followers', direction: 'desc' };
const YT_ALLOWED_AGE = new Set([18, 25, 35, 45, 65]);

/* -------------------------------------------------------------------------- */
/*                               Small helpers                                */
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

function extractYouTubeHandleFromUrl(u) {
  if (!u) return undefined;
  const m = u.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i);
  return m ? m[1] : undefined;
}

function pickPrimarySrc(item) {
  return (
    (item && (item.profile || item.channel || item.creator || item.user)) || item
  );
}

/* -------------------------------------------------------------------------- */
/*                             Auth header logic                              */
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
  if (
    MODASH_AUTH_HEADER === 'accesstoken' ||
    MODASH_AUTH_HEADER === 'accessToken'
  )
    return 'accesstoken';
  if (/^bearer\s+/i.test(MODASH_API_KEY)) return 'authorization';
  return 'x-api-key';
}

function fallbackKinds(primary) {
  const all = ['x-api-key', 'authorization', 'accesstoken'];
  return [primary, ...all.filter((k) => k !== primary)];
}

/* -------------------------------------------------------------------------- */
/*                             Low-level Modash calls                         */
/* -------------------------------------------------------------------------- */

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
          (json && (json.message || json.error)) ||
          `Modash ${res.status} ${res.statusText}`
        );
        err.status = res.status;
        err.response = json || undefined;

        if (res.status === 403) {
          // try next header kind
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
/*                           Normalization helpers                            */
/* -------------------------------------------------------------------------- */

function normalizeReportData(reportJSON) {
  const rootProfile = (reportJSON && reportJSON.profile) || {};
  const prof = rootProfile.profile || rootProfile || {};

  const rawUserId =
    prof.userId ||
    rootProfile.userId ||
    prof.id ||
    prof.channelId ||
    prof.profileId ||
    prof.secUid ||
    null;

  const profileUserId = rawUserId ? cleanStr(rawUserId) : null;

  const normalized = {
    profile: {
      userId: profileUserId,
      username: prof.username || prof.handle || null,
      fullname: prof.fullname || prof.fullName || prof.title || null,
      handle: prof.handle || (prof.username ? `@${prof.username}` : undefined),
      url: prof.url || null,
      picture: prof.picture || prof.avatar || null,
      followers: toNum(prof.followers),
      engagements: toNum(prof.engagements),
      engagementRate: toNum(prof.engagementRate),
      averageViews: toNum(prof.averageViews || prof.avgViews),
    },

    isPrivate: !!rootProfile.isPrivate,
    isVerified: !!rootProfile.isVerified,
    accountType: rootProfile.accountType || null,
    secUid: rootProfile.secUid || null,

    city: rootProfile.city || null,
    state: rootProfile.state || null,
    country: rootProfile.country || null,
    ageGroup: rootProfile.ageGroup || null,
    gender: rootProfile.gender || null,
    language: rootProfile.language || null,

    statsByContentType: rootProfile.statsByContentType || null,
    stats: rootProfile.stats || null,

    recentPosts: Array.isArray(rootProfile.recentPosts)
      ? rootProfile.recentPosts
      : [],
    popularPosts: Array.isArray(rootProfile.popularPosts)
      ? rootProfile.popularPosts
      : [],

    postsCount: toNum(rootProfile.postsCount || rootProfile.postsCounts),
    avgLikes: toNum(rootProfile.avgLikes),
    avgComments: toNum(rootProfile.avgComments),
    avgViews: toNum(rootProfile.avgViews),
    avgReelsPlays: toNum(rootProfile.avgReelsPlays),
    totalLikes: toNum(rootProfile.totalLikes),
    totalViews: toNum(rootProfile.totalViews),

    bio: rootProfile.description || rootProfile.bio || '',

    categories: [],
    hashtags: rootProfile.hashtags || [],
    mentions: rootProfile.mentions || [],
    brandAffinity: rootProfile.brandAffinity || [],

    audience: rootProfile.audience || null,
    audienceCommenters: rootProfile.audienceCommenters || null,
    lookalikes:
      rootProfile.lookalikes || rootProfile.audienceLookalikes || [],

    sponsoredPosts: rootProfile.sponsoredPosts || [],
    paidPostPerformance: toNum(rootProfile.paidPostPerformance),
    paidPostPerformanceViews: toNum(rootProfile.paidPostPerformanceViews),
    sponsoredPostsMedianViews: toNum(rootProfile.sponsoredPostsMedianViews),
    sponsoredPostsMedianLikes: toNum(rootProfile.sponsoredPostsMedianLikes),
    nonSponsoredPostsMedianViews: toNum(
      rootProfile.nonSponsoredPostsMedianViews
    ),
    nonSponsoredPostsMedianLikes: toNum(
      rootProfile.nonSponsoredPostsMedianLikes
    ),

    audienceExtra: rootProfile.audienceExtra || null,

    providerRaw: reportJSON,
  };

  return normalized;
}

function trimProviderRaw(providerRaw) {
  if (!providerRaw || typeof providerRaw !== 'object') return providerRaw;

  const clone = deepClone(providerRaw);
  if (clone && clone.profile) {
    const base = clone.profile.profile || clone.profile;

    const limitPosts = (arr, max = 50) =>
      Array.isArray(arr) ? arr.slice(0, max) : arr;

    base.recentPosts = limitPosts(base.recentPosts);
    base.popularPosts = limitPosts(base.popularPosts);
  }

  return clone;
}

function mapReportToModashDoc(normalized, platform, opts = {}) {
  const prof = normalized.profile || {};
  const { influencerId, userId } = opts;
  const canonicalUserId = userId || prof.userId;

  const doc = {
    provider: platform,
    userId: canonicalUserId,

    username: prof.username,
    fullname: prof.fullname,
    handle: prof.handle,
    url: prof.url,
    picture: prof.picture,

    followers: prof.followers,
    engagements: prof.engagements,
    engagementRate: prof.engagementRate,
    averageViews: prof.averageViews,

    isPrivate: normalized.isPrivate,
    isVerified: normalized.isVerified,
    accountType: normalized.accountType,
    secUid: normalized.secUid,

    city: normalized.city,
    state: normalized.state,
    country: normalized.country,
    ageGroup: normalized.ageGroup,
    gender: normalized.gender,
    language: normalized.language,

    statsByContentType: normalized.statsByContentType,
    stats: normalized.stats,
    recentPosts: normalized.recentPosts,
    popularPosts: normalized.popularPosts,

    postsCount: normalized.postsCount,
    avgLikes: normalized.avgLikes,
    avgComments: normalized.avgComments,
    avgViews: normalized.avgViews,
    avgReelsPlays: normalized.avgReelsPlays,
    totalLikes: normalized.totalLikes,
    totalViews: normalized.totalViews,

    bio: normalized.bio,

    categories: normalized.categories || [],
    hashtags: normalized.hashtags || [],
    mentions: normalized.mentions || [],
    brandAffinity: normalized.brandAffinity || [],

    audience: normalized.audience,
    audienceCommenters: normalized.audienceCommenters,
    lookalikes: normalized.lookalikes || [],

    sponsoredPosts: normalized.sponsoredPosts || [],
    paidPostPerformance: normalized.paidPostPerformance,
    paidPostPerformanceViews: normalized.paidPostPerformanceViews,
    sponsoredPostsMedianViews: normalized.sponsoredPostsMedianViews,
    sponsoredPostsMedianLikes: normalized.sponsoredPostsMedianLikes,
    nonSponsoredPostsMedianViews: normalized.nonSponsoredPostsMedianViews,
    nonSponsoredPostsMedianLikes: normalized.nonSponsoredPostsMedianLikes,

    audienceExtra: normalized.audienceExtra,

    providerRaw: trimProviderRaw(normalized.providerRaw),
  };

  if (influencerId) {
    doc.influencerId = influencerId;
  }

  return doc;
}

/* -------------------------------------------------------------------------- */
/*                        DB upsert / cache helpers                           */
/* -------------------------------------------------------------------------- */

async function upsertModashProfileFromReport(normalized, platform, opts = {}) {
  const prof = normalized.profile || {};
  const influencerId = opts.influencerId || null;
  const userIdFromRequest = cleanStr(opts.userIdFromRequest || '');

  const rawCanonicalId =
    cleanStr(prof.userId) ||
    userIdFromRequest ||
    cleanStr(prof.secUid) ||
    cleanStr(prof.username) ||
    null;

  if (!rawCanonicalId) {
    console.warn('[upsertModashProfile] No usable userId; skipping save', {
      platform,
      profUserId: prof.userId,
      userIdFromRequest,
      username: prof.username,
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
    const saved = await ModashProfile.findOneAndUpdate(
      filter,
      update,
      options
    );

    console.log(
      `[upsertModashProfile] Upserted ${platform} profile for userId: ${canonicalUserId}`
    );
    return saved;
  } catch (err) {
    if (err && err.code === 11000) {
      console.error(
        '[upsertModashProfile] Duplicate key on { userId, provider }. This usually means there is an old or conflicting unique index (e.g. influencer_1_provider_1).',
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
    doc = await ModashProfile.findOne({
      provider: platform,
      userId,
    }).lean();
  }

  if (!doc && influencerId) {
    doc = await ModashProfile.findOne({
      provider: platform,
      influencerId,
    }).lean();
  }

  if (!doc || !doc.providerRaw) return null;

  return {
    providerRaw: doc.providerRaw,
    lastFetchedAt: doc.lastFetchedAt || doc.updatedAt || doc.createdAt || null,
  };
}

/* -------------------------------------------------------------------------- */
/*                        Search result normalization                         */
/* -------------------------------------------------------------------------- */

function normalizeSearchItem(item, platform) {
  const src = pickPrimarySrc(item);

  const url = firstNonEmpty(
    src && src.url,
    src && src.channelUrl,
    src && src.profileUrl
  );

  const derivedHandleFromUrl = extractYouTubeHandleFromUrl(url);

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

  return {
    userId,
    username,
    fullname:
      (src &&
        (src.fullName ||
          src.fullname ||
          src.display_name ||
          src.title ||
          src.name)) ||
      '',
    followers:
      toNum(
        src &&
        (src.followers ||
          src.followerCount ||
          (src.stats && src.stats.followers))
      ) || 0,
    engagementRate: toNum(
      src &&
      (src.engagementRate ||
        (src.stats && src.stats.engagementRate))
    ) || 0,
    engagements: toNum(
      src &&
      (src.engagements ||
        (src.stats && (src.stats.avgEngagements || src.stats.avgLikes)))
    ),
    averageViews: toNum(
      src &&
      (src.averageViews ||
        (src.stats && src.stats.avgViews) ||
        src.avgViews)
    ),
    picture:
      (src &&
        (src.picture ||
          src.avatar ||
          src.profilePicUrl ||
          src.thumbnail ||
          src.channelThumbnailUrl)) || undefined,
    url,
    isVerified: Boolean(src && (src.isVerified || src.verified)),
    isPrivate: Boolean(src && src.isPrivate),
    platform,
  };
}

function betterSearchResult(a, b) {
  if (a.isVerified !== b.isVerified) return a.isVerified ? a : b;
  if (!!a.username !== !!b.username) return a.username ? a : b;
  if ((a.followers || 0) !== (b.followers || 0)) {
    return (a.followers || 0) > (b.followers || 0) ? a : b;
  }
  if ((a.engagementRate || 0) !== (b.engagementRate || 0)) {
    return (a.engagementRate || 0) > (b.engagementRate || 0) ? a : b;
  }
  if ((a.engagements || 0) !== (b.engagements || 0)) {
    return (a.engagements || 0) > (b.engagements || 0) ? a : b;
  }
  if (!!a.url !== !!b.url) return a.url ? a : b;
  if (!!a.picture !== !!b.picture) return a.picture ? a : b;
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

async function recordBrandProfileView({
  brandId,
  platform,
  userId,
  influencerId,
  periodKey,
  at,
}) {
  if (!brandId || !platform || !userId || !periodKey) return;

  const now = at || new Date();

  const filter = { brandId, platform, userId, periodKey };

  // Fields that only need to be set when the doc is first created
  const setOnInsert = {
    brandId,
    platform,
    userId,
    periodKey,
    firstViewedAt: now,
  };

  // Fields we always want to touch
  const update = {
    $setOnInsert: setOnInsert,
    $set: {
      lastViewedAt: now,
    },
  };

  // Only put influencerId in ONE operator to avoid conflicts
  if (influencerId) {
    update.$set.influencerId = influencerId;
  }

  try {
    await BrandProfileView.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
    });
  } catch (err) {
    console.error(
      '[recordBrandProfileView] Failed to record profile view:',
      err
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                          /api/modash/users                                 */
/* -------------------------------------------------------------------------- */

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

async function frontendUsers(req, res) {
  try {
    const qParam = cleanStr(req.query.q || '');
    const queries = qParam
      .split(',')
      .map((s) => s.replace(/^@/, '').trim().toLowerCase())
      .filter(Boolean);

    const platformsParam = cleanStr(req.query.platforms || '');
    const platforms = platformsParam
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((p) => ALLOWED_PLATFORMS.has(p));

    const strict = req.query.strict === '1' || req.query.strict === 'true';
    const matchMode = cleanStr(req.query.match || 'exact-first').toLowerCase();

    if (!queries.length || !platforms.length) {
      return res.status(400).json({
        error:
          'Provide ?q=<handle>[,handle...]&platforms=instagram,tiktok,youtube',
      });
    }

    const collected = [];

    for (const p of platforms) {
      for (const q of queries) {
        const data = await modashGET(`/${p}/users`, {
          limit: 10,
          query: q,
        });

        const users = Array.isArray(data && data.users) ? data.users : [];

        for (const raw of users) {
          // Try to reuse any URL that Modash gives us
          const rawUrl = cleanStr(
            raw.url || raw.channelUrl || raw.profileUrl || ''
          );

          // Derive handle from Modash data or from URL
          const handleFromUrl = extractYouTubeHandleFromUrl(rawUrl);
          const baseHandle = cleanStr(
            raw.handle ||
            raw.username ||
            handleFromUrl ||
            ''
          );
          const username = baseHandle.replace(/^@/, ''); // normalized handle
          const handle = username;

          // Engagement metrics (will be undefined if Modash /users doesn't provide them;
          // Express/JSON will simply omit undefined keys)
          const engagementRate = toNum(
            raw.engagementRate ||
            (raw.stats && raw.stats.engagementRate)
          );

          const engagements = toNum(
            raw.engagements ||
            (raw.stats &&
              (raw.stats.avgEngagements || raw.stats.avgLikes))
          );

          const averageViews = toNum(
            raw.averageViews ||
            (raw.stats && raw.stats.avgViews)
          );

          // Final URL: prefer Modash URL, otherwise build from handle
          let url = rawUrl;
          if (!url && username) {
            url =
              p === 'instagram'
                ? `https://instagram.com/${username}`
                : p === 'tiktok'
                  ? `https://www.tiktok.com/@${username}`
                  : `https://www.youtube.com/@${username}`;
          }

          const u = {
            platform: p,
            userId: raw.userId,
            username,                  // always our normalized handle
            handle,                    // same as username for frontend
            fullname: raw.fullname,
            followers: toNum(raw.followers),
            engagementRate,            // NEW
            engagements,               // NEW (avg engagements / likes)
            averageViews,              // NEW
            isVerified: !!raw.isVerified,
            isPrivate: !!raw.isPrivate,
            picture: raw.picture,
            url: url || undefined,     // avoid "https://www.youtube.com/@"
          };

          // If we still don't have username OR URL, skip this broken item
          if (!u.username && !u.url) {
            continue;
          }

          const s = scoreForQuery(u, q);
          collected.push({ ...u, __score: s });
        }
      }
    }

    let results = dedupeByBest(collected);

    if (strict) {
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
      const sDiff = (b.__score || 0) - (a.__score || 0);
      if (sDiff !== 0) return sDiff;
      if (!!b.isVerified !== !!a.isVerified) return b.isVerified ? 1 : -1;
      const af = a.followers || 0;
      const bf = b.followers || 0;
      if (bf !== af) return bf - af;
      return String(a.username || '').localeCompare(
        String(b.username || '')
      );
    });

    if (!strict && matchMode === 'exact') {
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

    const safeResults = results.map(({ __score, ...rest }) => rest);

    return res.json({ results: safeResults });
  } catch (err) {
    const raw = (err && err.message) || '';
    const isSensitive = /api token|developer section|modash|authorization|bearer|modash_api_key/i.test(
      String(raw)
    );
    const safe = isSensitive ? 'Lookup failed' : raw || 'Lookup failed';
    const status = (err && err.status) || 400;
    return res.status(status).json({ error: safe });
  }
}

/* -------------------------------------------------------------------------- */
/*                        /api/modash/search                                  */
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

  if (aud.age && aud.ageRange) {
    delete aud.ageRange;
  }

  if (Array.isArray(infl.filterOperations)) {
    delete infl.filterOperations;
  }

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

async function frontendSearch(req, res) {
  try {
    const payload = req.body || {};
    const brandId = payload.brandId || payload.brand_id;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required for search' });
    }

    try {
      await ensureBrandQuota(brandId, 'searches_per_month', 1);
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
      return res
        .status(400)
        .json({ error: 'Provide { brandId, platforms, body }' });
    }

    const responses = [];

    for (const p of platforms) {
      const platform = String(p || '').toLowerCase();
      if (!ALLOWED_PLATFORMS.has(platform)) {
        return res
          .status(400)
          .json({ error: `Unsupported platform: ${platform}` });
      }

      const firstBody = buildPlatformBody(platform, body);
      let data = await modashPOST(`/${platform}/search`, firstBody);

      const enableFallback = (process.env.MODASH_YT_FALLBACK || '1') !== '0';
      if (platform === 'youtube' && enableFallback && Number((data && data.total) || 0) === 0) {
        const retryBody = buildPlatformBody(platform, body, { relax: true });
        try {
          const retryData = await modashPOST(
            `/${platform}/search`,
            retryBody
          );
          if (retryData && Number((retryData && retryData.total) || 0) > 0) {
            data = retryData;
          }
        } catch {
          // ignore
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
    const total = responses.reduce(
      (sum, r) => sum + Number((r.data && r.data.total) || 0),
      0
    );

    return res.json({
      results: merged,
      total,
      unique: merged.length,
    });
  } catch (err) {
    const raw = (err && err.message) || '';
    const isSensitive = /api token|developer section|modash|authorization|bearer|modash_api_key/i.test(
      String(raw)
    );
    const safe = isSensitive ? 'Search failed' : raw || 'Search failed';
    const status = (err && err.status) || 400;
    return res.status(status).json({ error: safe });
  }
}

/* -------------------------------------------------------------------------- */
/*                      /api/modash/report                                    */
/* -------------------------------------------------------------------------- */

function toCalcMethod(input) {
  if (!input) return 'median';
  return String(input).toLowerCase() === 'average' ? 'average' : 'median';
}

async function frontendReport(req, res) {
  try {
    const brandId = cleanStr(req.query.brandId || req.query.brand_id || '');
    const adminId = cleanStr(req.query.adminId || req.query.admin_id || '');

    // ✅ Admin override: if adminId exists, skip subscription/quota checks
    const isAdmin = !!adminId;

    // ✅ Require either brandId or adminId
    if (!brandId && !adminId) {
      return res.status(400).json({
        error: 'brandId or adminId is required for profile views',
      });
    }

    const platform = cleanStr(req.query.platform || '').toLowerCase();
    const userId = cleanStr(req.query.userId || '');
    const calculationMethod = toCalcMethod(req.query.calculationMethod);
    const influencerId =
      cleanStr(req.query.influencerId || req.query.influencer_id || '') || null;

    const forceFresh =
      req.query.force === '1' ||
      req.query.force === 'true' ||
      req.query.refresh === '1' ||
      req.query.refresh === 'true';

    if (!platform || !ALLOWED_PLATFORMS.has(platform)) {
      return res.status(400).json({
        error: 'platform must be instagram|tiktok|youtube',
      });
    }

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // ---------------------------------------------------------
    // 0) Compute monthly periodKey & check if already viewed
    //    ✅ Only for BRAND users (not admin)
    // ---------------------------------------------------------
    const now = new Date();
    const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    let alreadyViewedThisPeriod = false;

    if (!isAdmin && brandId) {
      try {
        const existingView = await BrandProfileView.findOne({
          brandId,
          platform,
          userId,
          periodKey,
        }).lean();
        alreadyViewedThisPeriod = !!existingView;
      } catch (e) {
        console.error('[frontendReport] Failed to check BrandProfileView:', e.message);
      }
    }

    // ---------------------------------------------------------
    // Quota enforcement – only for FIRST view this month
    // ✅ Only for BRAND users (not admin)
    // ---------------------------------------------------------
    if (!isAdmin && brandId && !alreadyViewedThisPeriod) {
      try {
        await ensureBrandQuota(brandId, 'profile_views_per_month', 1);
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

    // ---------------------------------------------------------
    // 1) Cache
    // ---------------------------------------------------------
    if (!forceFresh) {
      try {
        const cached = await findCachedReport({
          platform,
          userId,
          influencerId,
        });

        if (cached && cached.providerRaw) {
          console.log(`[frontendReport] ✓ Returning cached report for ${platform}/${userId}`);

          const out = Object.assign({}, cached.providerRaw);

          if (cached.lastFetchedAt) {
            const d = new Date(cached.lastFetchedAt);
            if (!isNaN(d.getTime())) out._lastFetchedAt = d.toISOString();
          }

          // ✅ Record view only for BRAND (not admin)
          if (!isAdmin && brandId) {
            await recordBrandProfileView({
              brandId,
              platform,
              userId,
              influencerId,
              periodKey,
              at: now,
            });
          }

          return res.json(out);
        }
      } catch (cacheErr) {
        console.error('[frontendReport] ✗ Cache lookup failed:', cacheErr.message);
      }
    }

    // ---------------------------------------------------------
    // 2) Fresh from Modash
    // ---------------------------------------------------------
    console.log(`[frontendReport] Fetching fresh report from Modash API for ${platform}/${userId}`);

    let reportJSON;
    try {
      reportJSON = await modashGET(
        `/${platform}/profile/${encodeURIComponent(userId)}/report`,
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
        // ignore
      }

      const status = (apiErr && apiErr.status) ? apiErr.status : 502;
      return res.status(status).json({ error: safeMsg });
    }

    const fetchedAt = new Date();

    // ---------------------------------------------------------
    // 3) Save normalized copy in ModashProfile cache (existing logic)
    // ---------------------------------------------------------
    try {
      console.log('[frontendReport] Normalizing and saving report to database');
      const normalized = normalizeReportData(reportJSON);

      await upsertModashProfileFromReport(normalized, platform, {
        userIdFromRequest: userId,
        influencerId,
      });

      console.log(`[frontendReport] Successfully saved report for ${platform}/${userId}`);
    } catch (saveErr) {
      console.error('[frontendReport] Failed to save Modash profile to database:', saveErr);
    }

    // ---------------------------------------------------------
    // 4) Return + mark profile as viewed for this month
    // ✅ Only for BRAND (not admin)
    // ---------------------------------------------------------
    const out = Object.assign({}, reportJSON, {
      _lastFetchedAt: fetchedAt.toISOString(),
    });

    if (!isAdmin && brandId) {
      await recordBrandProfileView({
        brandId,
        platform,
        userId,
        influencerId,
        periodKey,
        at: fetchedAt,
      });
    }

    return res.json(out);
  } catch (err) {
    console.error('[frontendReport] ✗ Unexpected error:', err);
    const raw = (err && err.message) || '';
    return res.status(500).json({ error: raw || 'Internal error' });
  }
}


/* -------------------------------------------------------------------------- */
/*                       Legacy resolveProfile + search                       */
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
    .concat(
      Array.isArray(result && result.lookalikes) ? result.lookalikes : []
    );

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
    followers:
      typeof prof.followers === 'number' ? prof.followers : null,
    picture: prof.picture || null,
    url: prof.url || null,
  };
}

async function resolveProfile(req, res) {
  try {
    let platform = (req.body && req.body.platform) || '';
    let username = (req.body && req.body.username) || '';

    platform = cleanStr(platform).toLowerCase();
    username = cleanStr(username);
    if (username.startsWith('@')) username = username.slice(1);

    if (!ALLOWED_PLATFORMS.has(platform)) {
      return res.status(400).json({
        message: 'platform must be instagram | youtube | tiktok',
      });
    }
    if (!username) {
      return res
        .status(400)
        .json({ message: 'username (handle) is required' });
    }

    let reportJSON = null;
    let userIdResolved = null;

    // Try direct
    try {
      reportJSON = await getReportLegacy(platform, username);
      userIdResolved =
        (reportJSON &&
          reportJSON.profile &&
          (reportJSON.profile.userId ||
            (reportJSON.profile.profile &&
              reportJSON.profile.profile.userId))) ||
        null;
    } catch (e) {
      if (e && e.status === 403) {
        return res.status(403).json({
          message:
            'Forbidden from Modash. Verify your API key / header type and plan.',
          details: e.response || undefined,
        });
      }
      if (!e || (e.status !== 404 && e.status !== 400)) throw e;
    }

    // Fallback via search
    if (!reportJSON) {
      const hit = await searchForUsername(platform, username);
      if (!hit || !hit.userId) {
        return res
          .status(404)
          .json({ message: 'No profile found for that username' });
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

    // Save asynchronously
    (async () => {
      try {
        await upsertModashProfileFromReport(normalized, platform, {
          userIdFromRequest: userIdResolved || username,
        });
      } catch (saveErr) {
        console.error(
          '[resolveProfile] Failed to save profile:',
          saveErr.message
        );
      }
    })();

    return res.json({
      message: 'ok',
      provider: platform,
      userId:
        userIdResolved ||
        (normalized.profile && normalized.profile.userId) ||
        null,
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
    return res
      .status(500)
      .json({ message: (e && e.message) || 'Modash error' });
  }
}

async function legacySearch(req, res) {
  try {
    const platform = cleanStr((req.body && req.body.platform) || '').toLowerCase();
    if (!ALLOWED_PLATFORMS.has(platform)) {
      return res.status(400).json({
        message: 'platform must be instagram | youtube | tiktok',
      });
    }

    const body = Object.assign({}, req.body);
    delete body.platform;

    const data = await modashPOST(`/${platform}/search`, body || {});
    return res.json(data);
  } catch (e) {
    if (e && e.status === 403) {
      return res.status(403).json({
        message: 'Forbidden from Modash',
        details: e.response || undefined,
      });
    }
    return res
      .status(500)
      .json({ message: (e && e.message) || 'Modash error' });
  }
}


function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function influencerTierFromFollowers(followers) {
  const f = Number(followers || 0);

  if (f < 10_000) return { key: 'nano', label: 'Nano (0-10K)' };
  if (f < 100_000) return { key: 'micro', label: 'Micro (10K-100K)' };
  if (f < 500_000) return { key: 'mid', label: 'Mid (100K-500K)' };
  if (f < 1_000_000) return { key: 'macro', label: 'Macro (500K-1M)' };
  return { key: 'mega', label: 'Mega (1M+)' };
}

function groupCategories(categoryLinks) {
  const links = Array.isArray(categoryLinks) ? categoryLinks : [];
  const catMap = new Map(); // categoryId -> {categoryId, categoryName, subcategories:[]}

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
    // ✅ single provider OR multiple platforms
    const provider = cleanStr(req.query.provider || req.query.platform || "").toLowerCase();
    const platformsRaw = cleanStr(req.query.platforms || "").trim();

    // ✅ support q OR search
    const qRaw = cleanStr(req.query.q || req.query.search || "");
    const influencerId = cleanStr(req.query.influencerId || req.query.influencer_id || "");

    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));

    const sortKey = cleanStr(req.query.sort || "updatedAt").toLowerCase();
    const dirParam = cleanStr(req.query.dir || "desc").toLowerCase();
    const dir = dirParam === "asc" ? 1 : -1;

    // ---------- FILTER ----------
    const filter = {};

    // ✅ provider / platforms handling (matches your frontend params)
    if (provider) {
      if (!ALLOWED_PLATFORMS.has(provider)) {
        return res.status(400).json({ error: "provider must be instagram|tiktok|youtube" });
      }
      filter.provider = provider;
    } else if (platformsRaw) {
      const platforms = platformsRaw
        .split(",")
        .map((x) => cleanStr(x).toLowerCase())
        .filter(Boolean)
        .filter((x) => ALLOWED_PLATFORMS.has(x));

      if (platforms.length) filter.provider = { $in: platforms };
    }

    if (influencerId) filter.influencerId = influencerId;

    // Followers Min / Max
    const followersMinRaw =
      req.query.followersMin ??
      req.query.followers_min ??
      req.query.minFollowers ??
      req.query.min_followers;

    const followersMaxRaw =
      req.query.followersMax ??
      req.query.followers_max ??
      req.query.maxFollowers ??
      req.query.max_followers;

    const toNumber = (v) => {
      if (v === undefined || v === null || v === "") return null;
      const s = String(v).trim().toLowerCase().replace(/,/g, "");
      if (/^\d+(\.\d+)?k$/.test(s)) return Number(s.replace("k", "")) * 1000;
      if (/^\d+(\.\d+)?m$/.test(s)) return Number(s.replace("m", "")) * 1000000;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };

    let min = toNumber(followersMinRaw);
    let max = toNumber(followersMaxRaw);

    if (min !== null || max !== null) {
      if (min !== null && max !== null && min > max) [min, max] = [max, min];
      filter.followers = {};
      if (min !== null) filter.followers.$gte = min;
      if (max !== null) filter.followers.$lte = max;
    }

    // Country (supports: country=India OR country=India,USA)
    const countryRaw = cleanStr(req.query.country || req.query.countries || "").trim();
    if (countryRaw) {
      const countries = countryRaw
        .split(",")
        .map((c) => cleanStr(c).trim())
        .filter(Boolean);

      const toExactRx = (c) => new RegExp(`^${escapeRegex(c)}$`, "i");

      filter.country = countries.length === 1 ? toExactRx(countries[0]) : { $in: countries.map(toExactRx) };
    }

    // ✅✅ Category filter (FIXED: NO $elemMatch)
    // Works if `category` is: string OR array of strings
    const categoryParam =
      req.query.category ??
      req.query.categories ??
      req.query.niche ??
      req.query.niches ??
      req.query.category_name ??
      req.query.categoryName;

    if (categoryParam) {
      const rawList = Array.isArray(categoryParam) ? categoryParam : String(categoryParam).split(",");

      const categories = rawList
        .map((c) => cleanStr(c).trim())
        .filter(Boolean);

      if (categories.length) {
        const toExactRx = (c) => new RegExp(`^${escapeRegex(c)}$`, "i");

        // ✅ simplest + correct:
        // - if category is string => regex matches
        // - if category is array => ANY element matching regex works
        filter.category = categories.length === 1 ? toExactRx(categories[0]) : { $in: categories.map(toExactRx) };
      }
    }

    // ✅ SEARCH
    if (qRaw) {
      const q = qRaw.trim();
      const qNoAt = q.replace(/^@/, "").trim();

      const rx = new RegExp(escapeRegex(q), "i");
      const rxNoAt = qNoAt ? new RegExp(escapeRegex(qNoAt), "i") : null;

      filter.$or = [
        { username: rx },
        { fullname: rx },
        { handle: rx },
        { url: rx },
        { userId: rx },
        { influencerId: rx },
        ...(rxNoAt ? [{ username: rxNoAt }, { handle: rxNoAt }] : []),
      ];
    }
    // ---------- /FILTER ----------

    // Keep list payload light
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

      country: 1,
      state: 1,
      city: 1,
      gender: 1,
      ageGroup: 1,
      language: 1,

      category: 1, // ✅ included

      influencerId: 1,
      influencer: 1,

      createdAt: 1,
      updatedAt: 1,
    };

    const sort = (() => {
      if (sortKey === "followers") return { followers: dir, updatedAt: -1 };
      if (sortKey === "createdat") return { createdAt: dir };
      return { updatedAt: dir };
    })();

    const [results, total] = await Promise.all([
      ModashProfile.find(filter).select(projection).sort(sort).skip(page * limit).limit(limit).lean(),
      ModashProfile.countDocuments(filter),
    ]);

    return res.json({ page, limit, total, results });
  } catch (err) {
    console.error("[getSavedInfluencers] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}

async function getRandomInfluencers(req, res) {
  try {
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));

    const provider = cleanStr(req.query.provider || req.query.platform || '').toLowerCase();
    if (provider && !ALLOWED_PLATFORMS.has(provider)) {
      return res.status(400).json({ error: 'provider must be instagram|tiktok|youtube' });
    }

    // optional filters
    const minFollowers = Number.isFinite(Number(req.query.minFollowers)) ? Number(req.query.minFollowers) : undefined;
    const maxFollowers = Number.isFinite(Number(req.query.maxFollowers)) ? Number(req.query.maxFollowers) : undefined;

    // require linked to your Influencer (either influencer ObjectId or influencerId string)
    const requireLinked = (cleanStr(req.query.requireLinked || '0') === '1');

    // require categories to exist
    const requireCategories = (cleanStr(req.query.requireCategories || '0') === '1');

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

        tier, // {key,label}

        categories: groupCategories(r.categories),

        picture: cleanStr(r.picture) || null,
        url: cleanStr(r.url) || null,
        isVerified: !!r.isVerified,
        isPrivate: !!r.isPrivate,

        stats: {
          engagementRate: (typeof r.engagementRate === 'number' ? r.engagementRate : null),
          engagements: (typeof r.engagements === 'number' ? r.engagements : null),
          averageViews: (typeof r.averageViews === 'number' ? r.averageViews : null),
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

    const MAX_EXPORT = 100_000;

    // ✅ selected export
    const idsRaw = body.modashIds ?? body.ids ?? body.selectedIds ?? null;
    const selectedIds = Array.isArray(idsRaw)
      ? idsRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    // ✅ limit export
    const limitRaw = body.limit ?? body.downloadLimit ?? body.count ?? 1000;
    const limitFromBody = Math.min(MAX_EXPORT, Math.max(1, parseInt(String(limitRaw), 10) || 1000));
    const limit = selectedIds.length ? Math.min(MAX_EXPORT, selectedIds.length) : limitFromBody;

    // filters (no pagination)
    const provider = cleanStr(body.provider || body.platform || '').toLowerCase();
    const qRaw = cleanStr(body.q || body.search || '');
    const influencerId = cleanStr(body.influencerId || body.influencer_id || '');

    const minFollowers = Number.isFinite(Number(body.minFollowers)) ? Number(body.minFollowers) : undefined;
    const maxFollowers = Number.isFinite(Number(body.maxFollowers)) ? Number(body.maxFollowers) : undefined;

    const requireLinked = cleanStr(body.requireLinked || '0') === '1';
    const requireCategories = cleanStr(body.requireCategories || '0') === '1';

    // sort
    const sortKey = cleanStr(body.sort || body.sortBy || 'updatedAt').toLowerCase();
    const dirParam = cleanStr(body.dir || body.sortOrder || 'desc').toLowerCase();
    const dir = dirParam === 'asc' ? 1 : -1;

    const filter = {};

    if (provider) {
      if (!ALLOWED_PLATFORMS.has(provider)) {
        return res.status(400).json({ error: 'provider must be instagram|tiktok|youtube' });
      }
      filter.provider = provider;
    }

    if (influencerId) filter.influencerId = influencerId;

    // ✅ selection filter by _id
    if (selectedIds.length) {
      const objIds = selectedIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      if (!objIds.length) {
        return res.status(400).json({ error: 'No valid modashIds provided.' });
      }
      filter._id = { $in: objIds };
    }

    // followers range
    if (minFollowers !== undefined || maxFollowers !== undefined) {
      filter.followers = {};
      if (minFollowers !== undefined) filter.followers.$gte = minFollowers;
      if (maxFollowers !== undefined) filter.followers.$lte = maxFollowers;
    }

    // require linked
    if (requireLinked) {
      filter.$or = [
        { influencer: { $exists: true, $ne: null } },
        { influencerId: { $exists: true, $ne: '' } },
      ];
    }

    // require categories
    if (requireCategories) {
      filter['categories.0'] = { $exists: true };
    }

    // search like getSavedInfluencers
    if (qRaw) {
      const q = qRaw.trim();
      const qNoAt = q.replace(/^@/, '').trim();

      const rx = new RegExp(escapeRegex(q), 'i');
      const rxNoAt = qNoAt ? new RegExp(escapeRegex(qNoAt), 'i') : null;

      const orSearch = [
        { username: rx },
        { fullname: rx },
        { handle: rx },
        { url: rx },
        { userId: rx },
        { influencerId: rx },
        ...(rxNoAt ? [{ username: rxNoAt }, { handle: rxNoAt }] : []),
      ];

      if (filter.$or && Array.isArray(filter.$or)) {
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: filter.$or });
        filter.$and.push({ $or: orSearch });
        delete filter.$or;
      } else {
        filter.$or = orSearch;
      }
    }

    const sort = (() => {
      if (sortKey === 'followers') return { followers: dir, updatedAt: -1 };
      if (sortKey === 'createdat') return { createdAt: dir };
      return { updatedAt: dir };
    })();

    // ✅ projection (+categories for niche/sub-niche)
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

    let items = await ModashProfile.find(filter)
      .select(projection)
      .sort(sort)
      .limit(limit)
      .lean();

    // preserve selection order if selectedIds passed
    if (selectedIds.length) {
      const rank = new Map(selectedIds.map((id, idx) => [String(id), idx]));
      items.sort((a, b) => {
        const ra = rank.get(String(a._id)) ?? 999999;
        const rb = rank.get(String(b._id)) ?? 999999;
        return ra - rb;
      });
    }

    // ---------------- CSV helpers
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
          ? rawUrl || (doc.userId ? `https://www.youtube.com/channel/${doc.userId}` : (u ? `https://www.youtube.com/@${u}` : dash))
          : dash;

      const ig =
        prov === 'instagram'
          ? rawUrl || (u ? `https://www.instagram.com/${u}` : dash)
          : dash;

      const tt =
        prov === 'tiktok'
          ? rawUrl || (u ? `https://www.tiktok.com/@${u}` : dash)
          : dash;

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

    // ---------------- ✅ CollabGlam header format
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

    const lines = [];
    lines.push(header.map(csvEscape).join(','));

    items.forEach((doc, idx) => {
      const links = getLinks(doc);

      const row = [
        idx + 1,
        fmt(doc.fullname),               // Handle Title
        fmt(getHandleAt(doc)),           // Influencer Handle
        dash,                            // Email (not in ModashProfile)
        dash,                            // Phone
        fmt(links.yt),                   // YouTube link
        fmt(links.ig),                   // Instagram link
        fmt(links.tt),                   // TikTok link
        fmt(doc.country),                // Country/Region
        fmt(getLang(doc)),               // Language
        fmt(getNiche(doc)),              // Niche
        fmt(getSubNiche(doc)),           // Sub-Niche
        fmtNum(doc.followers),           // Follower count
        fmtNum(doc.averageViews),        // Avg Views (best available)
        fmtPercent(doc.engagementRate),  // Engagement Rate
        dash,                            // Upload Frequency
        dash,                            // Last Sponsor
        dash,                            // Managed by Any Agency
        dash,                            // Top Audience Country
        dash,                            // Average Audience Age
        dash,                            // CollabGlam Demographics link
        dash,                            // Last Contacted Date
        fmt(getHandleAt(doc)),           // Last Working Handle
        dash,                            // Last 1st followup date
        dash,                            // Last 2nd followup date
        dash,                            // Status
        dash,                            // Reply
        dash,                            // Notes
      ];

      lines.push(row.map(csvEscape).join(','));
    });

    const csv = lines.join('\n');

    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(
      ts.getHours()
    ).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="modash_saved_${stamp}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[exportSavedInfluencersCsv] Error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to export CSV' });
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Exports                                  */
/* -------------------------------------------------------------------------- */

module.exports = {
  // New frontend APIs
  frontendUsers,
  frontendSearch,
  frontendReport,

  // Legacy endpoints
  resolveProfile,
  search: legacySearch,

  // Helper functions (if needed elsewhere)
  normalizeReportData,
  upsertModashProfileFromReport,
  findCachedReport,
  getSavedInfluencers,
  getRandomInfluencers,
  exportSavedInfluencersCsv,
};
