'use strict';

require('dotenv').config();
const { fetch, Agent } = require('undici');

const InfluencerProfile = require('../models/youtube');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_TIMEOUT_MS = Number(process.env.YOUTUBE_TIMEOUT_MS || 12000);

const httpAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 60_000,
});

const YT_CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const YT_PLAYLIST_ITEMS = 'https://www.googleapis.com/youtube/v3/playlistItems';
const YT_VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';

const CHANNEL_PARTS = [
  'snippet',
  'statistics',
  'topicDetails',
  'brandingSettings',
  'contentDetails',
  'status',
  'localizations',
];

const MAX_LIST_LIMIT = 200;
const MAX_EXPORT_LIMIT = 100_000;
const DEFAULT_METRIC_VIDEO_LIMIT = 15;
const MAX_VIDEO_FETCH = 50;

const ALLOWED_SORT = new Set([
  'createdAt',
  'updatedAt',
  'syncedAt',
  'subscriberCount',
  'avgViewsLast15',
  'engagementRateLast15',
  'uploadFrequencyPerWeek',
  'lastContactedAt',
]);

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function normalizeHandle(input) {
  const s = cleanStr(input);
  if (!s) return null;

  const m = s.match(/@([A-Za-z0-9._-]+)/);
  if (m && m[1]) return `@${m[1]}`;

  if (/^[A-Za-z0-9._-]+$/.test(s)) return `@${s}`;

  return null;
}

function handleToLower(input) {
  const h = normalizeHandle(input);
  return h ? h.toLowerCase() : null;
}

function labelFromWikiUrl(url) {
  try {
    const last = decodeURIComponent(String(url).split('/').pop() || '');
    return last.replace(/_/g, ' ');
  } catch {
    return String(url || '');
  }
}

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function cleanStrOrNull(v) {
  if (v === null || typeof v === 'undefined') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseDateOrNull(v) {
  if (v === null || v === '' || typeof v === 'undefined') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { __invalid: true };
  return d;
}

function parseBoolOrNull(v) {
  if (v === null || typeof v === 'undefined' || v === '') return null;
  if (typeof v === 'boolean') return v;

  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(s)) return true;
  if (['false', 'no', '0'].includes(s)) return false;
  return { __invalid: true };
}

function parseFlexibleNumber(v) {
  if (v === undefined || v === null || v === '') return null;

  const s = String(v).trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?k$/.test(s)) return Number(s.replace('k', '')) * 1000;
  if (/^\d+(\.\d+)?m$/.test(s)) return Number(s.replace('m', '')) * 1_000_000;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function pickInstagramHandle(text) {
  const t = String(text || '');
  const m =
    t.match(/instagram\.com\/([A-Za-z0-9._]+)/i) ||
    t.match(/\B@([A-Za-z0-9._]{3,})\b/);

  if (!m) return null;
  return `@${String(m[1]).toLowerCase()}`;
}

function parseArrayInput(v) {
  if (Array.isArray(v)) {
    return v.map((x) => cleanStr(x)).filter(Boolean);
  }

  if (typeof v === 'string') {
    return v
      .split(/[,\n]/g)
      .map((x) => cleanStr(x))
      .filter(Boolean);
  }

  return [];
}

function exactCI(value) {
  return new RegExp(`^${escapeRegex(cleanStr(value))}$`, 'i');
}

function containsCI(value) {
  return new RegExp(escapeRegex(cleanStr(value)), 'i');
}

/* -------------------------------------------------------------------------- */
/*                             Country normalization                          */
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
      const v = cleanStr(alias);
      const key = v.toLowerCase();
      if (!v || seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*                              HTTP wrapper                                  */
/* -------------------------------------------------------------------------- */

async function ytFetch(url, timeoutMs = YT_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(
    () => ac.abort(new Error('YouTube API timeout')),
    timeoutMs
  );

  try {
    const r = await fetch(url, {
      dispatcher: httpAgent,
      signal: ac.signal,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`YouTube API ${r.status}: ${txt || r.statusText}`);
    }

    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/* -------------------------------------------------------------------------- */
/*                              YouTube calls                                 */
/* -------------------------------------------------------------------------- */

async function fetchChannelByHandle(handle) {
  const params = new URLSearchParams({
    part: CHANNEL_PARTS.join(','),
    forHandle: handle,
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
  return data?.items?.[0] || null;
}

async function fetchLatestVideosFromUploads(uploadsPlaylistId, limit = 50) {
  const safeLimit = Math.min(
    MAX_VIDEO_FETCH,
    Math.max(1, Number(limit) || MAX_VIDEO_FETCH)
  );

  const params = new URLSearchParams({
    part: 'contentDetails,snippet',
    playlistId: uploadsPlaylistId,
    maxResults: String(safeLimit),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_PLAYLIST_ITEMS}?${params.toString()}`);

  const ids = (data?.items || [])
    .map((it) => it?.contentDetails?.videoId)
    .filter(Boolean);

  if (!ids.length) return [];

  const parts = ['snippet', 'contentDetails', 'statistics', 'topicDetails', 'status'];
  const p2 = new URLSearchParams({
    part: parts.join(','),
    id: ids.join(','),
    key: YT_API_KEY,
  });

  const v = await ytFetch(`${YT_VIDEOS}?${p2.toString()}`);
  return Array.isArray(v?.items) ? v.items : [];
}

/* -------------------------------------------------------------------------- */
/*                             Metric helpers                                 */
/* -------------------------------------------------------------------------- */

function normalizeVideoRow(v) {
  const st = v?.statistics || {};
  const sn = v?.snippet || {};
  const cd = v?.contentDetails || {};

  return {
    videoId: v?.id || null,
    title: sn?.title || '',
    publishedAt: sn?.publishedAt ? new Date(sn.publishedAt) : null,
    viewCount: toNum(st.viewCount) ?? 0,
    likeCount: toNum(st.likeCount) ?? 0,
    commentCount: toNum(st.commentCount) ?? 0,
    duration: cd?.duration || null,
  };
}

function computeMetricsFromVideos(videos = [], metricWindow = DEFAULT_METRIC_VIDEO_LIMIT) {
  const rows = videos
    .map(normalizeVideoRow)
    .filter((r) => r.videoId && r.publishedAt)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  const metricRows = rows.slice(0, Math.max(1, Number(metricWindow) || DEFAULT_METRIC_VIDEO_LIMIT));

  if (!metricRows.length) {
    return {
      storedVideos: [],
      avgViews: null,
      engagementRate: null,
      postsPerWeek: null,
      avgDaysBetween: null,
      lastUploadAt: null,
      lastVideoId: null,
      lastVideoTitle: null,
    };
  }

  const avgViews = Math.round(
    metricRows.reduce((a, r) => a + r.viewCount, 0) / metricRows.length
  );

  const erArr = metricRows
    .map((r) =>
      r.viewCount > 0 ? (r.likeCount + r.commentCount) / r.viewCount : 0
    )
    .filter(Number.isFinite);

  const engagementRate = erArr.length
    ? Number(
        (erArr.reduce((a, b) => a + b, 0) / erArr.length).toFixed(6)
      )
    : null;

  let postsPerWeek = null;
  let avgDaysBetween = null;

  if (metricRows.length >= 2) {
    const newest = metricRows[0].publishedAt.getTime();
    const oldest = metricRows[metricRows.length - 1].publishedAt.getTime();
    const days = Math.max(1, (newest - oldest) / (1000 * 60 * 60 * 24));

    postsPerWeek = Number(((metricRows.length / days) * 7).toFixed(3));

    const gaps = [];
    for (let i = 0; i < metricRows.length - 1; i++) {
      gaps.push(
        (metricRows[i].publishedAt - metricRows[i + 1].publishedAt) /
          (1000 * 60 * 60 * 24)
      );
    }

    avgDaysBetween = gaps.length
      ? Number(
          (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3)
        )
      : null;
  }

  return {
    storedVideos: rows.slice(0, metricWindow),
    avgViews,
    engagementRate,
    postsPerWeek,
    avgDaysBetween,
    lastUploadAt: metricRows[0].publishedAt,
    lastVideoId: metricRows[0].videoId,
    lastVideoTitle: metricRows[0].title,
  };
}

/* -------------------------------------------------------------------------- */
/*                           Shared query builder                             */
/* -------------------------------------------------------------------------- */

function buildInfluencerQuery(input = {}, opts = {}) {
  const and = [{ platform: 'youtube' }];

  const followersMin = parseFlexibleNumber(
    input.followersMin ?? input.minFollowers ?? input.followers_from
  );
  const followersMax = parseFlexibleNumber(
    input.followersMax ?? input.maxFollowers ?? input.followers_to
  );

  if (followersMin !== null || followersMax !== null) {
    const range = {};
    if (followersMin !== null) range.$gte = followersMin;
    if (followersMax !== null) range.$lte = followersMax;
    and.push({ subscriberCount: range });
  }

  const countryValues = normalizeCountryTokens([
    ...parseArrayInput(input.country),
    ...parseArrayInput(input.countries),
  ]);

  if (countryValues.length) {
    and.push({
      country: { $in: countryValues.map(exactCI) },
    });
  }

  const categoryValues = [
    ...parseArrayInput(input.category),
    ...parseArrayInput(input.categories),
  ].filter(Boolean);

  if (categoryValues.length) {
    const rxList = categoryValues.map((c) => containsCI(c));
    and.push({
      $or: [
        { topicLabels: { $in: rxList } },
        { topicCategories: { $in: rxList } },
      ],
    });
  }

  const search = cleanStr(input.search);
  if (search) {
    const needleRaw = search;
    const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

    const rxRaw = escapeRegex(needleRaw);
    const rxNoAt = escapeRegex(needleNoAt);

    const handleRx = new RegExp(
      rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`,
      'i'
    );
    const plainRx = new RegExp(rxNoAt, 'i');

    and.push({
      $or: [
        { email: plainRx },
        { handle: handleRx },
        { title: plainRx },
        { channelId: plainRx },
        { instagramHandle: plainRx },
        { handleId: plainRx },
        { country: plainRx },
        { defaultLanguage: plainRx },
        { lastSponsor: plainRx },
        { topAudienceCountry: plainRx },
        { workingHandle: plainRx },
      ],
    });
  }

  if (Array.isArray(opts.handleIds) && opts.handleIds.length) {
    and.push({
      handleId: { $in: opts.handleIds.map((x) => cleanStr(x)).filter(Boolean) },
    });
  }

  return and.length === 1 ? and[0] : { $and: and };
}

function buildSortSpec(sortBy, sortOrder) {
  const safeSortBy = ALLOWED_SORT.has(String(sortBy)) ? String(sortBy) : 'createdAt';
  const safeSortOrder =
    String(sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;

  if (safeSortBy === 'engagementRateLast15') {
    return {
      sortBy: safeSortBy,
      sortOrder: safeSortOrder,
      mongoSort: {
        engagementRateLast15: safeSortOrder,
        uploadFrequencyPerWeek: -1,
        createdAt: -1,
      },
    };
  }

  if (safeSortBy === 'uploadFrequencyPerWeek') {
    return {
      sortBy: safeSortBy,
      sortOrder: safeSortOrder,
      mongoSort: {
        uploadFrequencyPerWeek: safeSortOrder,
        engagementRateLast15: -1,
        createdAt: -1,
      },
    };
  }

  return {
    sortBy: safeSortBy,
    sortOrder: safeSortOrder,
    mongoSort: { [safeSortBy]: safeSortOrder, createdAt: -1 },
  };
}

function buildProjection({ includeRaw = false, includeVideos = false } = {}) {
  return {
    __v: 0,
    rawPlaylists: 0,
    ...(includeRaw ? {} : { rawChannel: 0 }),
    ...(includeVideos ? {} : { lastVideos: 0 }),
  };
}

/* -------------------------------------------------------------------------- */
/*                             CSV helpers                                    */
/* -------------------------------------------------------------------------- */

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmt(v) {
  return v == null || v === '' ? '—' : String(v);
}

function fmtNum(v) {
  return v == null || Number.isNaN(Number(v)) ? '—' : String(v);
}

function fmtPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function fmtBool(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return '—';
}

function fmtDateOnly(v) {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function ytLink(doc) {
  if (doc?.handle) return `https://www.youtube.com/${doc.handle}`;
  if (doc?.channelId) return `https://www.youtube.com/channel/${doc.channelId}`;
  return '—';
}

function igLink(doc) {
  const h = cleanStr(doc?.instagramHandle);
  if (!h) return '—';
  const username = h.startsWith('@') ? h.slice(1) : h;
  return `https://www.instagram.com/${username}`;
}

function niche(doc) {
  const labels = Array.isArray(doc?.topicLabels) ? doc.topicLabels : [];
  return labels[0] ? String(labels[0]) : '—';
}

function subNiche(doc) {
  const labels = Array.isArray(doc?.topicLabels) ? doc.topicLabels : [];
  return labels[1] ? String(labels[1]) : '—';
}

function followups(doc) {
  const arr = Array.isArray(doc?.followUpDates) ? doc.followUpDates : [];
  const dates = arr
    .map((x) => (x instanceof Date ? x : new Date(x)))
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  return {
    f1: dates[0] ? fmtDateOnly(dates[0]) : '—',
    f2: dates[1] ? fmtDateOnly(dates[1]) : '—',
  };
}

/* -------------------------------------------------------------------------- */
/*                             Controllers                                    */
/* -------------------------------------------------------------------------- */

exports.syncYouTubeProfile = asyncHandler(async (req, res) => {
  if (!YT_API_KEY) {
    return res
      .status(500)
      .json({ status: 'error', message: 'Missing YOUTUBE_API_KEY' });
  }

  const body = req.body || {};
  const handle = normalizeHandle(body.handle);

  if (!handle) {
    return res.status(400).json({
      status: 'error',
      message: 'Valid handle required, e.g. "@mrbeast"',
    });
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
  const email = rawEmail ? rawEmail.toLowerCase() : null;

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid email format',
      email: rawEmail,
    });
  }

  const metricWindow = Math.min(
    MAX_VIDEO_FETCH,
    Math.max(
      1,
      Number(body.metricsVideoLimit || body.videosLimit || DEFAULT_METRIC_VIDEO_LIMIT) ||
        DEFAULT_METRIC_VIDEO_LIMIT
    )
  );

  const channel = await fetchChannelByHandle(handle);
  if (!channel) {
    return res.status(404).json({
      status: 'error',
      message: `No channel found for ${handle}`,
      handle,
    });
  }

  const snippet = channel.snippet || {};
  const stats = channel.statistics || {};
  const topic = channel.topicDetails || {};
  const branding = channel.brandingSettings || {};
  const uploadsPlaylistId =
    channel?.contentDetails?.relatedPlaylists?.uploads || null;

  const videos = uploadsPlaylistId
    ? await fetchLatestVideosFromUploads(
        uploadsPlaylistId,
        Math.max(metricWindow, DEFAULT_METRIC_VIDEO_LIMIT)
      )
    : [];

  const computed = computeMetricsFromVideos(videos, metricWindow);

  const topicCategories = Array.isArray(topic.topicCategories)
    ? topic.topicCategories
    : [];
  const topicLabels = topicCategories.map(labelFromWikiUrl);

  const bannerUrl = branding?.image?.bannerExternalUrl || null;
  const keywords = branding?.channel?.keywords || '';

  const instagramFromChannel = pickInstagramHandle(snippet.description);
  const instagramFromVideos =
    videos
      .map((v) => pickInstagramHandle(v?.snippet?.description))
      .find(Boolean) || null;

  const instagramHandle =
    instagramFromChannel || instagramFromVideos || null;

  const handleLower = handle.toLowerCase();
  const filter = { platform: 'youtube', handle: handleLower };

  const update = {
    platform: 'youtube',
    handle: handleLower,
    channelId: channel.id,

    title: snippet.title || '',
    description: snippet.description || '',
    country: snippet.country || null,
    defaultLanguage: snippet.defaultLanguage || null,
    thumbnails: snippet.thumbnails || null,

    keywords,
    bannerUrl,

    topicCategories,
    topicLabels,

    subscriberCount: toNum(stats.subscriberCount),
    totalViewCount: toNum(stats.viewCount),
    totalVideoCount: toNum(stats.videoCount),

    lastVideos: computed.storedVideos,

    avgViewsLast15: computed.avgViews,
    engagementRateLast15: computed.engagementRate,
    uploadFrequencyPerWeek: computed.postsPerWeek,
    avgDaysBetweenUploads: computed.avgDaysBetween,

    lastUploadAt: computed.lastUploadAt,
    lastVideoId: computed.lastVideoId,
    lastVideoTitle: computed.lastVideoTitle,

    instagramHandle,

    rawChannel: channel,
    syncedAt: new Date(),
    updatedAt: new Date(),

    ...(email ? { email } : {}),
  };

  const doc = await InfluencerProfile.findOneAndUpdate(
    filter,
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return res.json({
    status: 'ok',
    handle,
    handleId: doc.handleId,
    data: doc,
  });
});

exports.updateInfluencerManualFields = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const handleId = cleanStrOrNull(body.handleId);
  const handle = body.handle ? normalizeHandle(body.handle) : null;

  if (!handleId && !handle) {
    return res.status(400).json({
      status: 'error',
      message: 'Provide handleId OR handle.',
    });
  }

  const filter = handleId
    ? { handleId }
    : { platform: 'youtube', handle: String(handle).toLowerCase() };

  const $set = {};

  if ('email' in body) {
    const email = cleanStrOrNull(body.email);

    if (email === null) {
      $set.email = null;
    } else {
      const emailLc = email.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid email format.',
        });
      }
      $set.email = emailLc;
    }
  }

  if ('lastSponsor' in body) {
    $set.lastSponsor = cleanStrOrNull(body.lastSponsor);
  }

  if ('managedByAgency' in body) {
    const b = parseBoolOrNull(body.managedByAgency);
    if (b && b.__invalid) {
      return res.status(400).json({
        status: 'error',
        message: 'managedByAgency must be boolean.',
      });
    }
    $set.managedByAgency = b;
  }

  if ('topAudienceCountry' in body) {
    $set.topAudienceCountry = cleanStrOrNull(body.topAudienceCountry);
  }

  if ('averageAudienceAge' in body) {
    const v = body.averageAudienceAge;
    if (v === null || v === '' || typeof v === 'undefined') {
      $set.averageAudienceAge = null;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 120) {
        return res.status(400).json({
          status: 'error',
          message: 'averageAudienceAge must be 0-120.',
        });
      }
      $set.averageAudienceAge = n;
    }
  }

  if ('lastContactedAt' in body || 'lastContactedDate' in body) {
    const raw =
      'lastContactedAt' in body
        ? body.lastContactedAt
        : body.lastContactedDate;

    const d = parseDateOrNull(raw);
    if (d && d.__invalid) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid lastContactedAt date.',
      });
    }
    $set.lastContactedAt = d;
  }

  if ('followUpDates' in body) {
    const arr = Array.isArray(body.followUpDates) ? body.followUpDates : [];
    const parsed = [];

    for (const x of arr) {
      const d = parseDateOrNull(x);
      if (d && d.__invalid) {
        return res.status(400).json({
          status: 'error',
          message: 'followUpDates contains invalid date.',
        });
      }
      if (d) parsed.push(d);
    }

    const uniq = Array.from(
      new Map(parsed.map((d) => [d.getTime(), d])).values()
    ).sort((a, b) => a.getTime() - b.getTime());

    $set.followUpDates = uniq;
  }

  if ('workingHandle' in body) {
    $set.workingHandle = cleanStrOrNull(body.workingHandle);
  }

  if (Object.keys($set).length === 0) {
    const existing = await InfluencerProfile.findOne(filter).lean();
    if (!existing) {
      return res.status(404).json({
        status: 'error',
        message: 'Influencer not found. Run sync API first.',
      });
    }
    return res.json({
      status: 'ok',
      handleId: existing.handleId,
      data: existing,
    });
  }

  $set.updatedAt = new Date();

  const doc = await InfluencerProfile.findOneAndUpdate(
    filter,
    { $set },
    { new: true }
  ).lean();

  if (!doc) {
    return res.status(404).json({
      status: 'error',
      message: 'Influencer not found. Run sync API first.',
    });
  }

  return res.json({
    status: 'ok',
    handleId: doc.handleId,
    data: doc,
  });
});

exports.getAllInfluencers = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const page = Math.max(1, parseInt(body.page ?? '1', 10) || 1);
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, parseInt(body.limit ?? '20', 10) || 20)
  );
  const skip = (page - 1) * limit;

  const includeRaw =
    String(body.includeRaw ?? 'false').toLowerCase() === 'true';
  const includeVideos =
    String(body.includeVideos ?? 'false').toLowerCase() === 'true';

  const { sortBy, sortOrder, mongoSort } = buildSortSpec(
    body.sortBy,
    body.sortOrder
  );

  const query = buildInfluencerQuery(body);
  const projection = buildProjection({ includeRaw, includeVideos });

  const [total, items] = await Promise.all([
    InfluencerProfile.countDocuments(query),
    InfluencerProfile.find(query)
      .sort(mongoSort)
      .skip(skip)
      .limit(limit)
      .select(projection)
      .lean(),
  ]);

  return res.json({
    status: 'ok',
    page,
    limit,
    total,
    hasNext: page * limit < total,
    sortBy,
    sortOrder: sortOrder === 1 ? 'asc' : 'desc',
    search: cleanStr(body.search || ''),
    filters: {
      followersMin:
        parseFlexibleNumber(
          body.followersMin ?? body.minFollowers ?? body.followers_from
        ) ?? null,
      followersMax:
        parseFlexibleNumber(
          body.followersMax ?? body.maxFollowers ?? body.followers_to
        ) ?? null,
      countries:
        normalizeCountryTokens([
          ...parseArrayInput(body.country),
          ...parseArrayInput(body.countries),
        ]) || null,
      categories:
        [
          ...parseArrayInput(body.category),
          ...parseArrayInput(body.categories),
        ] || null,
    },
    data: items,
  });
});

exports.patchInfluencerEmail = asyncHandler(async (req, res) => {
  const handle = normalizeHandle(req.body.handle);
  const email = cleanStr(req.body.email).toLowerCase();

  if (!handle) {
    return res.status(400).json({
      status: 'error',
      message: 'Valid handle required',
    });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      status: 'error',
      message: 'Valid email required',
    });
  }

  const r = await InfluencerProfile.updateOne(
    {
      platform: 'youtube',
      handle: handle.toLowerCase(),
      $or: [{ email: null }, { email: '' }, { email: { $exists: false } }],
    },
    { $set: { email } }
  );

  return res.json({
    status: 'ok',
    matched: r.matchedCount,
    modified: r.modifiedCount,
  });
});

exports.exportInfluencersCsv = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const handleIds = Array.isArray(body.handleIds)
    ? body.handleIds.map((x) => cleanStr(x)).filter(Boolean)
    : [];

  const requestedLimit = Math.min(
    MAX_EXPORT_LIMIT,
    Math.max(1, parseInt(String(body.limit ?? body.downloadLimit ?? body.count ?? 500), 10) || 500)
  );

  const limit = handleIds.length
    ? Math.min(MAX_EXPORT_LIMIT, handleIds.length)
    : requestedLimit;

  const { sortBy, sortOrder, mongoSort } = buildSortSpec(
    body.sortBy,
    body.sortOrder
  );

  const query = buildInfluencerQuery(body, { handleIds });

  const items = await InfluencerProfile.find(query)
    .sort(mongoSort)
    .limit(limit)
    .select({
      __v: 0,
      rawChannel: 0,
      rawPlaylists: 0,
    })
    .lean();

  if (handleIds.length) {
    const rank = new Map(handleIds.map((id, idx) => [String(id), idx]));
    items.sort((a, b) => {
      const ra = rank.get(String(a.handleId)) ?? 999999;
      const rb = rank.get(String(b.handleId)) ?? 999999;
      return ra - rb;
    });
  }

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
    const fu = followups(doc);

    const row = [
      idx + 1,
      fmt(doc.title),
      fmt(doc.handle),
      fmt(doc.email),
      '—',
      ytLink(doc),
      igLink(doc),
      '—',
      fmt(doc.country),
      fmt(doc.defaultLanguage),
      niche(doc),
      subNiche(doc),
      fmtNum(doc.subscriberCount),
      fmtNum(doc.avgViewsLast15),
      fmtPercent(doc.engagementRateLast15),
      doc.uploadFrequencyPerWeek != null
        ? String(doc.uploadFrequencyPerWeek)
        : '—',
      fmt(doc.lastSponsor),
      fmtBool(doc.managedByAgency),
      fmt(doc.topAudienceCountry),
      doc.averageAudienceAge != null
        ? String(doc.averageAudienceAge)
        : '—',
      '—',
      fmtDateOnly(doc.lastContactedAt),
      fmt(doc.workingHandle),
      fu.f1,
      fu.f2,
      '—',
      '—',
      '—',
    ];

    lines.push(row.map(csvEscape).join(','));
  });

  const csv = lines.join('\n');

  const ts = new Date();
  const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(
    2,
    '0'
  )}${String(ts.getDate()).padStart(2, '0')}_${String(
    ts.getHours()
  ).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(
    ts.getSeconds()
  ).padStart(2, '0')}`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="influencers_${stamp}.csv"`
  );

  return res.status(200).send(csv);
});