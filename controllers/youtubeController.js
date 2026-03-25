'use strict';

require('dotenv').config();
const { fetch, Agent } = require('undici');

const InfluencerProfile = require('../models/youtube');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_TIMEOUT_MS = Number(process.env.YOUTUBE_TIMEOUT_MS || 12000);

const httpAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 60_000,
});

const YT_CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const YT_PLAYLIST_ITEMS = 'https://www.googleapis.com/youtube/v3/playlistItems';
const YT_VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';
const YT_SEARCH = 'https://www.googleapis.com/youtube/v3/search';

const CHANNEL_PARTS = [
  'snippet',
  'statistics',
  'topicDetails',
  'brandingSettings',
  'contentDetails',
  'status',
  'localizations',
];

// ======================================================
// Helpers
// ======================================================

async function searchYouTubeChannels(query, pageToken = '', maxResults = 50) {
  const params = new URLSearchParams();
  params.set('part', 'snippet');
  params.set('q', String(query || '').trim());
  params.set('type', 'channel');
  params.set('maxResults', String(Math.min(50, Math.max(1, Number(maxResults) || 50))));
  params.set('key', YT_API_KEY);

  if (pageToken) params.set('pageToken', pageToken);

  const data = await ytFetch(`${YT_SEARCH}?${params.toString()}`);

  return {
    items: Array.isArray(data?.items) ? data.items : [],
    nextPageToken: data?.nextPageToken || null,
    prevPageToken: data?.prevPageToken || null,
    pageInfo: data?.pageInfo || null,
  };
}

async function searchYouTubeVideos(query, maxResults = 50) {
  const params = new URLSearchParams({
    part: 'snippet',
    q: String(query || '').trim(),
    type: 'video',
    maxResults: String(Math.min(50, Math.max(1, Number(maxResults) || 50))),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_SEARCH}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchChannelsByIds(channelIds = []) {
  const ids = Array.from(
    new Set((channelIds || []).map((x) => String(x || '').trim()).filter(Boolean))
  );

  if (!ids.length) return [];

  const params = new URLSearchParams();
  params.set('part', CHANNEL_PARTS.join(','));
  params.set('id', ids.join(','));
  params.set('key', YT_API_KEY);

  const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchVideosByIds(videoIds = []) {
  const ids = Array.from(new Set(videoIds.filter(Boolean)));
  if (!ids.length) return [];

  const params = new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    id: ids.join(','),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_VIDEOS}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

function normalizeHandle(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  // Handles plain handle, @handle, or URL containing @handle
  const m = s.match(/@([A-Za-z0-9._\-]+)/);
  if (m && m[1]) return `@${m[1]}`;

  if (/^[A-Za-z0-9._\-]+$/.test(s)) return `@${s}`;

  return null;
}

function labelFromWikiUrl(url) {
  try {
    const last = decodeURIComponent(String(url).split('/').pop() || '');
    return last.replace(/_/g, ' ');
  } catch {
    return String(url);
  }
}

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toNum(x) {
  const n = Number(x);
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

function normalizeChannelHandle(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return s.startsWith('@') ? s : `@${s.replace(/^@/, '')}`;
}

async function fetchChannelById(channelId) {
  const params = new URLSearchParams({
    part: CHANNEL_PARTS.join(','),
    id: String(channelId || '').trim(),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
  return data?.items?.[0] || null;
}

async function buildYouTubeProfileData(channel, opts = {}) {
  const inputHandle = opts.inputHandle ? normalizeHandle(opts.inputHandle) : null;
  const inputEmail = typeof opts.email === 'string' ? opts.email.trim().toLowerCase() : null;
  const videosLimit = Math.min(50, Math.max(1, Number(opts.videosLimit) || 15));

  const snippet = channel?.snippet || {};
  const stats = channel?.statistics || {};
  const topic = channel?.topicDetails || {};
  const branding = channel?.brandingSettings || {};
  const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads || null;

  const customUrlRaw = snippet?.customUrl || '';
  const resolvedHandle =
    normalizeHandle(customUrlRaw) ||
    normalizeChannelHandle(customUrlRaw) ||
    inputHandle ||
    null;

  const videos = uploadsPlaylistId
    ? await fetchLatestVideosFromUploads(uploadsPlaylistId, videosLimit)
    : [];

  const computed = computeMetricsFromVideos(videos, 15);

  const topicCategories = Array.isArray(topic.topicCategories) ? topic.topicCategories : [];
  const topicLabels = topicCategories.map(labelFromWikiUrl);

  const bannerUrl = branding?.image?.bannerExternalUrl || null;
  const keywords = branding?.channel?.keywords || '';

  const instagramFromChannel = pickInstagramHandle(snippet.description);
  const instagramFromVideos =
    videos.map((v) => pickInstagramHandle(v?.snippet?.description)).find(Boolean) || null;
  const instagramHandle = instagramFromChannel || instagramFromVideos || null;

  const profileData = {
    platform: 'youtube',
    handle: resolvedHandle,
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

    lastVideos: computed.lastVideos,

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
    ...(inputEmail ? { email: inputEmail } : {}),
  };

  return {
    resolvedHandle,
    profileData,
  };
}

// ======================================================
// HTTP fetch wrapper
// ======================================================
async function ytFetch(url, timeoutMs = YT_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('YouTube API timeout')), timeoutMs);

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

// ======================================================
// YouTube API calls
// ======================================================
async function fetchChannelByHandle(handle) {
  const params = new URLSearchParams({
    part: CHANNEL_PARTS.join(','),
    forHandle: handle,
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
  return data?.items?.[0] || null;
}
function chunkArray(arr = [], size = 50) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function fetchChannelsByIds(ids = []) {
  const uniq = Array.from(
    new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))
  );

  if (!uniq.length) return [];

  const batches = chunkArray(uniq, 50);
  const all = [];

  for (const batch of batches) {
    const params = new URLSearchParams({
      part: CHANNEL_PARTS.join(','),
      id: batch.join(','),
      key: YT_API_KEY,
    });

    const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
    if (Array.isArray(data?.items)) {
      all.push(...data.items);
    }
  }

  return all;
}

async function fetchVideosByIds(ids = []) {
  const uniq = Array.from(
    new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))
  );

  if (!uniq.length) return [];

  const batches = chunkArray(uniq, 50);
  const all = [];

  for (const batch of batches) {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails,statistics,topicDetails,status',
      id: batch.join(','),
      key: YT_API_KEY,
    });

    const data = await ytFetch(`${YT_VIDEOS}?${params.toString()}`);
    if (Array.isArray(data?.items)) {
      all.push(...data.items);
    }
  }

  return all;
}

/**
 * Global keyword search for channels
 */
async function searchChannelsByKeyword(query, limit = 5) {
  const safeLimit = Math.min(25, Math.max(1, Number(limit) || 5));

  const params = new URLSearchParams({
    part: 'snippet',
    q: String(query || '').trim(),
    type: 'channel',
    maxResults: String(safeLimit),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_SEARCH}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * Global keyword search for videos
 */
async function searchVideosByKeyword(query, limit = 12) {
  const safeLimit = Math.min(25, Math.max(1, Number(limit) || 12));

  const params = new URLSearchParams({
    part: 'snippet',
    q: String(query || '').trim(),
    type: 'video',
    order: 'relevance',
    maxResults: String(safeLimit),
    key: YT_API_KEY,
  });

  const data = await ytFetch(`${YT_SEARCH}?${params.toString()}`);
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * Fetch latest uploads. YouTube API maxResults per request is 50.
 */
async function fetchLatestVideosFromUploads(uploadsPlaylistId, limit = 50) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 50));

  // 1) get videoIds from uploads playlist
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

  // 2) fetch details+stats
  const p2 = new URLSearchParams({
    part: 'snippet,contentDetails,statistics,topicDetails,status',
    id: ids.join(','),
    key: YT_API_KEY,
  });

  const v = await ytFetch(`${YT_VIDEOS}?${p2.toString()}`);
  return Array.isArray(v?.items) ? v.items : [];
}

// ======================================================
// Compute metrics
// ======================================================
function computeMetricsFromVideos(videos = [], sampleSize = 15) {
  const rows = videos
    .map((v) => {
      const st = v?.statistics || {};
      const sn = v?.snippet || {};
      const cd = v?.contentDetails || {};

      return {
        videoId: v?.id || null,
        title: sn?.title || '',
        description: sn?.description || '',
        publishedAt: sn?.publishedAt ? new Date(sn.publishedAt) : null,
        viewCount: toNum(st.viewCount) ?? 0,
        likeCount: toNum(st.likeCount) ?? 0,
        commentCount: toNum(st.commentCount) ?? 0,
        duration: cd?.duration || null,
        thumbnails: sn?.thumbnails || null,
        videoUrl: v?.id ? `https://www.youtube.com/watch?v=${v.id}` : null,
      };
    })
    .filter((r) => r.videoId && r.publishedAt);

  rows.sort((a, b) => b.publishedAt - a.publishedAt);

  const sample = rows.slice(0, Math.max(1, Number(sampleSize) || 15));

  if (!sample.length) {
    return {
      lastVideos: [],
      avgViews: null,
      engagementRate: null,
      postsPerWeek: null,
      avgDaysBetween: null,
      lastUploadAt: null,
      lastVideoId: null,
      lastVideoTitle: null,
    };
  }

  const avgViews = Math.round(sample.reduce((a, r) => a + r.viewCount, 0) / sample.length);

  const erArr = sample
    .map((r) => (r.viewCount > 0 ? (r.likeCount + r.commentCount) / r.viewCount : 0))
    .filter(Number.isFinite);

  const engagementRate = erArr.length
    ? Number((erArr.reduce((a, b) => a + b, 0) / erArr.length).toFixed(6))
    : null;

  let postsPerWeek = null;
  let avgDaysBetween = null;

  if (sample.length >= 2) {
    const newest = sample[0].publishedAt.getTime();
    const oldest = sample[sample.length - 1].publishedAt.getTime();
    const days = Math.max(1, (newest - oldest) / (1000 * 60 * 60 * 24));
    postsPerWeek = Number(((sample.length / days) * 7).toFixed(3));

    const gaps = [];
    for (let i = 0; i < sample.length - 1; i++) {
      gaps.push((sample[i].publishedAt - sample[i + 1].publishedAt) / (1000 * 60 * 60 * 24));
    }
    avgDaysBetween = gaps.length
      ? Number((gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3))
      : null;
  }

  return {
    lastVideos: sample,
    avgViews,
    engagementRate,
    postsPerWeek,
    avgDaysBetween,
    lastUploadAt: sample[0].publishedAt,
    lastVideoId: sample[0].videoId,
    lastVideoTitle: sample[0].title,
  };
}

// ======================================================
// Mapping helpers for GLOBAL SEARCH (read-only, not stored)
// ======================================================
function mapVideoLite(v) {
  const sn = v?.snippet || {};
  const st = v?.statistics || {};

  return {
    videoId: v?.id || null,
    title: sn?.title || '',
    description: sn?.description || '',
    publishedAt: sn?.publishedAt || null,
    channelId: sn?.channelId || null,
    channelTitle: sn?.channelTitle || '',
    thumbnails: sn?.thumbnails || null,
    viewCount: toNum(st?.viewCount),
    likeCount: toNum(st?.likeCount),
    commentCount: toNum(st?.commentCount),
    videoUrl: v?.id ? `https://www.youtube.com/watch?v=${v.id}` : null,
  };
}

function mapChannelLite(ch) {
  const sn = ch?.snippet || {};
  const st = ch?.statistics || {};
  const topic = ch?.topicDetails || {};
  const branding = ch?.brandingSettings || {};

  const topicCategories = Array.isArray(topic.topicCategories) ? topic.topicCategories : [];
  const topicLabels = topicCategories.map(labelFromWikiUrl);

  return {
    channelId: ch?.id || null,
    title: sn?.title || '',
    description: sn?.description || '',
    handle: sn?.customUrl
      ? `@${String(sn.customUrl).replace(/^@/, '')}`
      : null,
    customUrl: sn?.customUrl || null,
    country: sn?.country || null,
    thumbnails: sn?.thumbnails || null,
    subscriberCount: toNum(st?.subscriberCount),
    totalViewCount: toNum(st?.viewCount),
    totalVideoCount: toNum(st?.videoCount),
    topicLabels,
    bannerUrl: branding?.image?.bannerExternalUrl || null,
    channelUrl: ch?.id ? `https://www.youtube.com/channel/${ch.id}` : null,
  };
}



// ======================================================
// Global YouTube search (READ ONLY, no DB storage)
// query: "powerstation reviews"
// returns channels/influencers with matched videos
// ======================================================
async function globalYouTubeSearch(query, opts = {}) {
  const channelLimit = Math.min(50, Math.max(1, Number(opts.channelLimit) || 50));
  const videoLimit = Math.min(50, Math.max(1, Number(opts.videoLimit) || 50));
  const pageToken = String(opts.pageToken || '').trim();

  const [channelSearch, videoSearchItems] = await Promise.all([
    searchYouTubeChannels(query, pageToken, channelLimit),
    searchYouTubeVideos(query, videoLimit),
  ]);

  const channelIdsFromChannelSearch = channelSearch.items
    .map((it) => it?.id?.channelId || it?.snippet?.channelId)
    .filter(Boolean);

  const videoIds = videoSearchItems
    .map((it) => it?.id?.videoId)
    .filter(Boolean);

  const channelIdsFromVideoSearch = videoSearchItems
    .map((it) => it?.snippet?.channelId)
    .filter(Boolean);

  const allChannelIds = Array.from(
    new Set([...channelIdsFromChannelSearch, ...channelIdsFromVideoSearch])
  );

  const [channels, videos] = await Promise.all([
    fetchChannelsByIds(allChannelIds),
    fetchVideosByIds(videoIds),
  ]);

  const videosByChannelId = new Map();

  for (const v of videos) {
    const cid = v?.snippet?.channelId;
    if (!cid) continue;

    const row = {
      videoId: v?.id || null,
      title: v?.snippet?.title || '',
      description: v?.snippet?.description || '',
      publishedAt: v?.snippet?.publishedAt || null,
      channelId: cid,
      channelTitle: v?.snippet?.channelTitle || '',
      thumbnails: v?.snippet?.thumbnails || null,
      viewCount: toNum(v?.statistics?.viewCount),
      likeCount: toNum(v?.statistics?.likeCount),
      commentCount: toNum(v?.statistics?.commentCount),
      videoUrl: v?.id ? `https://www.youtube.com/watch?v=${v.id}` : null,
    };

    if (!videosByChannelId.has(cid)) videosByChannelId.set(cid, []);
    videosByChannelId.get(cid).push(row);
  }

  const directChannelSet = new Set(channelIdsFromChannelSearch);

  const recommendations = channels.map((ch) => {
    const sn = ch?.snippet || {};
    const st = ch?.statistics || {};
    const td = ch?.topicDetails || {};
    const branding = ch?.brandingSettings || {};

    const handle = normalizeHandle(sn?.customUrl || '') || null;
    const topicCategories = Array.isArray(td?.topicCategories) ? td.topicCategories : [];
    const topicLabels = topicCategories.map(labelFromWikiUrl);
    const matchedVideos = (videosByChannelId.get(ch.id) || []).slice(0, 6);

    return {
      channelId: ch.id,
      title: sn?.title || '',
      description: sn?.description || '',
      handle,
      customUrl: sn?.customUrl || null,
      country: sn?.country || null,
      thumbnails: sn?.thumbnails || null,
      subscriberCount: toNum(st?.subscriberCount),
      totalViewCount: toNum(st?.viewCount),
      totalVideoCount: toNum(st?.videoCount),
      topicLabels,
      bannerUrl: branding?.image?.bannerExternalUrl || null,
      channelUrl: handle
        ? `https://www.youtube.com/${handle}`
        : ch.id
          ? `https://www.youtube.com/channel/${ch.id}`
          : null,
      matchedByDirectChannelSearch: directChannelSet.has(ch.id),
      matchedVideos,
      score:
        (directChannelSet.has(ch.id) ? 1000 : 0) +
        (matchedVideos.length * 25) +
        ((toNum(st?.subscriberCount) || 0) / 100000),
    };
  });

  recommendations.sort((a, b) => (b.score || 0) - (a.score || 0));

  return {
    query,
    channelsFound: recommendations.length,
    videoHits: videos.length,
    nextPageToken: channelSearch.nextPageToken || null,
    hasMore: !!channelSearch.nextPageToken,
    recommendations,
  };
}

// ======================================================
// POST /youtube/search
// body: { query }
// Rules:
// - If explicit handle search (@creator) => sync/store in DB
// - Else => global search only, DO NOT store
// ======================================================
exports.searchYouTube = asyncHandler(async (req, res) => {
  if (!YT_API_KEY) {
    return res.status(500).json({
      status: 'error',
      message: 'Missing YOUTUBE_API_KEY',
    });
  }

  const body = req.body || {};
  const rawQuery = cleanStrOrNull(body.query ?? body.search ?? body.keyword);
  const pageToken = cleanStrOrNull(body.pageToken) || '';

  if (!rawQuery) {
    return res.status(400).json({
      status: 'error',
      message: 'query is required',
    });
  }

  const data = await globalYouTubeSearch(rawQuery, {
    channelLimit: body.channelLimit ?? 50,
    videoLimit: body.videoLimit ?? 50,
    pageToken,
  });

  return res.json({
    status: 'ok',
    mode: 'global',
    stored: false,
    query: rawQuery,
    data,
  });
});

// ======================================================
// POST /youtube/profile/sync
// Exact handle sync + store
// ======================================================
exports.syncYouTubeProfile = asyncHandler(async (req, res) => {
  if (!YT_API_KEY) {
    return res.status(500).json({
      status: 'error',
      message: 'Missing YOUTUBE_API_KEY',
    });
  }

  const body = req.body || {};
  const handle = body.handle ? normalizeHandle(body.handle) : null;
  const channelId = cleanStrOrNull(body.channelId);

  if (!handle && !channelId) {
    return res.status(400).json({
      status: 'error',
      message: 'Provide handle or channelId.',
    });
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
  const email = rawEmail ? rawEmail.toLowerCase() : null;

  if (email) {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid email format',
        email: rawEmail,
      });
    }
  }

  const channel = handle
    ? await fetchChannelByHandle(handle)
    : await fetchChannelById(channelId);

  if (!channel) {
    return res.status(404).json({
      status: 'error',
      message: 'Channel not found.',
    });
  }

  const { resolvedHandle, profileData } = await buildYouTubeProfileData(channel, {
    inputHandle: handle,
    email,
    videosLimit: 50,
  });

  if (!resolvedHandle) {
    return res.status(400).json({
      status: 'error',
      message: 'Unable to resolve channel handle for saving.',
    });
  }

  const filter = {
    platform: 'youtube',
    handle: resolvedHandle.toLowerCase(),
  };

  const doc = await InfluencerProfile.findOneAndUpdate(
    filter,
    { $set: profileData },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return res.json({
    status: 'ok',
    mode: 'handle',
    stored: true,
    handle: resolvedHandle,
    handleId: doc.handleId,
    data: doc,
  });
});

// ======================================================
// POST /youtube/profile/update-manual
// body: { handleId OR handle, ...manualFields }
// - Updates ONLY provided manual fields (email included)
// - Supports clearing fields by sending null or "" (except email must be valid or null)
// ======================================================
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

  if ('lastSponsor' in body) $set.lastSponsor = cleanStrOrNull(body.lastSponsor);

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

  if ('topAudienceCountry' in body) $set.topAudienceCountry = cleanStrOrNull(body.topAudienceCountry);

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
    const raw = ('lastContactedAt' in body) ? body.lastContactedAt : body.lastContactedDate;
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

    const uniq = Array.from(new Map(parsed.map((d) => [d.getTime(), d])).values())
      .sort((a, b) => a.getTime() - b.getTime());

    $set.followUpDates = uniq;
  }

  if ('workingHandle' in body) $set.workingHandle = cleanStrOrNull(body.workingHandle);

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

// ======================================================
// POST /youtube/getall
// DB search only (saved influencers)
// ======================================================
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

// ======================================================
// POST /youtube/getall
// Saved DB search + advanced filters
// ======================================================

const SORT_MAP = {
  relevance: { updatedAt: -1 },
  subscribers_desc: { subscriberCount: -1 },
  subscribers_asc: { subscriberCount: 1 },
  avg_views_desc: { avgViewsLast15: -1 },
  avg_views_asc: { avgViewsLast15: 1 },
  engagement_desc: { engagementRateLast15: -1 },
  recent_upload: { lastUploadAt: -1 },
  uploads_per_week: { uploadFrequencyPerWeek: -1 },
  newest: { createdAt: -1 },
};

function buildSubscriberRange(body = {}) {
  const directMin = body.followersMin ?? body.minFollowers ?? body.subscribersMin ?? null;
  const directMax = body.followersMax ?? body.maxFollowers ?? body.subscribersMax ?? null;

  let min = directMin != null && directMin !== '' ? Number(directMin) : null;
  let max = directMax != null && directMax !== '' ? Number(directMax) : null;

  // optional preset support if frontend sends subscriberRange
  const preset = String(body.subscriberRange || '').trim();
  if (preset && (!Number.isFinite(min) && !Number.isFinite(max))) {
    const MAP = {
      '1k_10k': { min: 1_000, max: 10_000 },
      '10k_50k': { min: 10_000, max: 50_000 },
      '50k_100k': { min: 50_000, max: 100_000 },
      '100k_500k': { min: 100_000, max: 500_000 },
      '500k_1m': { min: 500_000, max: 1_000_000 },
      '1m_5m': { min: 1_000_000, max: 5_000_000 },
      '5m_10m': { min: 5_000_000, max: 10_000_000 },
      '10m_plus': { min: 10_000_000, max: null },
    };
    if (MAP[preset]) {
      min = MAP[preset].min;
      max = MAP[preset].max;
    }
  }

  return {
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
  };
}

function buildAvgViewsMin(body = {}) {
  const raw = body.avgViewsMin ?? body.averageViewsMin ?? null;
  const n = raw != null && raw !== '' ? Number(raw) : null;
  return Number.isFinite(n) ? n : null;
}

function buildLastUploadDays(body = {}) {
  const raw = body.lastUploadDays ?? body.lastUploadWindowDays ?? null;
  const n = raw != null && raw !== '' ? Number(raw) : null;
  return Number.isFinite(n) && n > 0 ? n : null;
}

exports.getAllInfluencers = asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};

    const _escapeRegex =
      typeof escapeRegex === 'function'
        ? escapeRegex
        : (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '20', 10)));
    const skip = (page - 1) * limit;

    const search = typeof body.search === 'string' ? body.search.trim() : '';

    const sortKey = String(body.sortBy || 'relevance').trim();
    const sort = SORT_MAP[sortKey] || SORT_MAP.relevance;

    const includeRaw = String(body.includeRaw ?? 'false').toLowerCase() === 'true';
    const includeVideos = String(body.includeVideos ?? 'false').toLowerCase() === 'true';

    const { min: followersMin, max: followersMax } = buildSubscriberRange(body);
    const avgViewsMin = buildAvgViewsMin(body);
    const lastUploadDays = buildLastUploadDays(body);

    const countryRaw = body.country ?? null;
    const countriesRaw = body.countries ?? null;

    const categoryRaw = body.category ?? null;
    const categoriesRaw = body.categories ?? null;

    const baseQuery = { platform: 'youtube' };
    const and = [];

    // -----------------------------
    // Subscribers range
    // -----------------------------
    if (Number.isFinite(followersMin) || Number.isFinite(followersMax)) {
      const range = {};
      if (Number.isFinite(followersMin)) range.$gte = followersMin;
      if (Number.isFinite(followersMax)) range.$lte = followersMax;
      and.push({ subscriberCount: range });
    }

    // -----------------------------
    // Avg views minimum
    // -----------------------------
    if (Number.isFinite(avgViewsMin)) {
      and.push({ avgViewsLast15: { $gte: avgViewsMin } });
    }

    // -----------------------------
    // Last upload window
    // -----------------------------
    if (Number.isFinite(lastUploadDays)) {
      const after = new Date(Date.now() - lastUploadDays * 24 * 60 * 60 * 1000);
      and.push({ lastUploadAt: { $gte: after } });
    }

    // -----------------------------
    // Country
    // Stored country is typically code like US / IN
    // -----------------------------
    const countries = Array.isArray(countriesRaw)
      ? countriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const country = typeof countryRaw === 'string' ? countryRaw.trim() : '';

    if (countries.length) {
      const rxList = countries.map((c) => new RegExp(`^${_escapeRegex(c)}$`, 'i'));
      and.push({ country: { $in: rxList } });
    } else if (country) {
      and.push({ country: new RegExp(`^${_escapeRegex(country)}$`, 'i') });
    }

    // -----------------------------
    // Category
    // Match topic labels/categories + content text for things like Review/Unboxing/Tutorial
    // -----------------------------
    const categories = Array.isArray(categoriesRaw)
      ? categoriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const category = typeof categoryRaw === 'string' ? categoryRaw.trim() : '';

    const categoryTerms = categories.length ? categories : category ? [category] : [];

    if (categoryTerms.length) {
      const rxList = categoryTerms.map((c) => new RegExp(_escapeRegex(c), 'i'));

      and.push({
        $or: [
          { topicLabels: { $in: rxList } },
          { topicCategories: { $in: rxList } },
          { title: { $in: rxList } },
          { description: { $in: rxList } },
          { keywords: { $in: rxList } },
        ],
      });
    }

    // -----------------------------
    // Search
    // -----------------------------
    if (search) {
      const needleRaw = search;
      const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

      const rxRaw = _escapeRegex(needleRaw);
      const rxNoAt = _escapeRegex(needleNoAt);

      const handleRx = new RegExp(rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`, 'i');
      const plainRx = new RegExp(rxNoAt, 'i');

      and.push({
        $or: [
          { email: plainRx },
          { handle: handleRx },
          { title: plainRx },
          { channelId: plainRx },
          { instagramHandle: plainRx },
          { handleId: plainRx },
          { lastSponsor: plainRx },
          { topAudienceCountry: plainRx },
          { workingHandle: plainRx },
          { description: plainRx },
          { keywords: plainRx },
          { topicLabels: plainRx },
          { topicCategories: plainRx },
        ],
      });
    }

    const query = { ...baseQuery };
    if (and.length) query.$and = and;

    const projection = {
      __v: 0,
      ...(includeRaw ? {} : { rawChannel: 0 }),
      ...(includeVideos ? {} : { lastVideos: 0 }),
      rawPlaylists: 0,
    };

    const [total, items] = await Promise.all([
      InfluencerProfile.countDocuments(query),
      InfluencerProfile.find(query)
        .sort(sort)
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
      sortBy: sortKey,
      search: search || '',
      filters: {
        followersMin: Number.isFinite(followersMin) ? followersMin : null,
        followersMax: Number.isFinite(followersMax) ? followersMax : null,
        avgViewsMin: Number.isFinite(avgViewsMin) ? avgViewsMin : null,
        lastUploadDays: Number.isFinite(lastUploadDays) ? lastUploadDays : null,
        country: country || null,
        countries: countries.length ? countries : null,
        category: category || null,
        categories: categories.length ? categories : null,
      },
      data: items,
    });
  } catch (err) {
    console.error('getAllInfluencers error:', err);
    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Failed to fetch influencers.',
    });
  }
});

// ======================================================
// PATCH email only if empty
// ======================================================
exports.patchInfluencerEmail = asyncHandler(async (req, res) => {
  const handle = normalizeHandle(req.body.handle);
  const email = (req.body.email || '').trim().toLowerCase();

  if (!handle) {
    return res.status(400).json({
      status: 'error',
      message: 'Valid handle required',
    });
  }

  if (!email) {
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

// ======================================================
// CSV export
// ======================================================
exports.exportInfluencersCsv = asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};
    const MAX_EXPORT = 100_000;

    const handleIdsRaw = body.handleIds ?? body.ids ?? null;
    const handleIds = Array.isArray(handleIdsRaw)
      ? handleIdsRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const limitRaw = body.limit ?? body.downloadLimit ?? body.count ?? 500;
    const limitFromBody = Math.min(MAX_EXPORT, Math.max(1, parseInt(String(limitRaw), 10) || 500));
    const limit = handleIds.length ? Math.min(MAX_EXPORT, handleIds.length) : limitFromBody;

    const _escapeRegex =
      typeof escapeRegex === 'function'
        ? escapeRegex
        : (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const search = typeof body.search === 'string' ? body.search.trim() : '';
    const sortBy = ALLOWED_SORT.has(String(body.sortBy)) ? String(body.sortBy) : 'createdAt';
    const sortOrder = String(body.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;

    const followersMinRaw = body.followersMin ?? body.minFollowers ?? body.followers_from ?? null;
    const followersMaxRaw = body.followersMax ?? body.maxFollowers ?? body.followers_to ?? null;

    const countryRaw = body.country ?? null;
    const countriesRaw = body.countries ?? null;

    const categoryRaw = body.category ?? null;
    const categoriesRaw = body.categories ?? null;

    const baseQuery = { platform: 'youtube' };
    const and = [];

    const followersMin = followersMinRaw != null && followersMinRaw !== '' ? Number(followersMinRaw) : null;
    const followersMax = followersMaxRaw != null && followersMaxRaw !== '' ? Number(followersMaxRaw) : null;

    if (Number.isFinite(followersMin) || Number.isFinite(followersMax)) {
      const range = {};
      if (Number.isFinite(followersMin)) range.$gte = followersMin;
      if (Number.isFinite(followersMax)) range.$lte = followersMax;
      and.push({ subscriberCount: range });
    }

    const countries = Array.isArray(countriesRaw)
      ? countriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const country = typeof countryRaw === 'string' ? countryRaw.trim() : '';

    if (countries.length) {
      const rxList = countries.map((c) => new RegExp(`^${_escapeRegex(c)}$`, 'i'));
      and.push({ country: { $in: rxList } });
    } else if (country) {
      and.push({ country: new RegExp(`^${_escapeRegex(country)}$`, 'i') });
    }

    const categories = Array.isArray(categoriesRaw)
      ? categoriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const category = typeof categoryRaw === 'string' ? categoryRaw.trim() : '';

    if (categories.length) {
      const rxList = categories.map((c) => new RegExp(_escapeRegex(c), 'i'));
      and.push({
        $or: [{ topicLabels: { $in: rxList } }, { topicCategories: { $in: rxList } }],
      });
    } else if (category) {
      const rx = new RegExp(_escapeRegex(category), 'i');
      and.push({
        $or: [{ topicLabels: rx }, { topicCategories: rx }],
      });
    }

    if (search) {
      const needleRaw = search;
      const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

      const rxRaw = _escapeRegex(needleRaw);
      const rxNoAt = _escapeRegex(needleNoAt);

      const handleRx = new RegExp(rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`, 'i');
      const plainRx = new RegExp(rxNoAt, 'i');

      and.push({
        $or: [
          { email: plainRx },
          { handle: handleRx },
          { title: plainRx },
          { channelId: plainRx },
          { instagramHandle: plainRx },
          { handleId: plainRx },
          { lastSponsor: plainRx },
          { topAudienceCountry: plainRx },
          { workingHandle: plainRx },
        ],
      });
    }

    const query = { ...baseQuery };

    if (handleIds.length) {
      query.handleId = { $in: handleIds };
    }

    if (and.length) query.$and = and;

    const items = await InfluencerProfile.find(query)
      .sort({ [sortBy]: sortOrder })
      .limit(limit)
      .select({
        __v: 0,
        rawChannel: 0,
        rawPlaylists: 0,
      })
      .lean();

    const dash = '—';

    const csvEscape = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const fmt = (v) => {
      if (v == null || v === '') return dash;
      return String(v);
    };

    const fmtNum = (v) => {
      if (v == null || Number.isNaN(Number(v))) return dash;
      return String(v);
    };

    const fmtPercent = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dash;
      return `${(n * 100).toFixed(2)}%`;
    };

    const fmtBool = (v) => {
      if (v === true) return 'Yes';
      if (v === false) return 'No';
      return dash;
    };

    const fmtDateOnly = (v) => {
      if (!v) return dash;
      const d = v instanceof Date ? v : new Date(v);
      if (Number.isNaN(d.getTime())) return dash;
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };

    const ytLink = (doc) => (doc?.handle ? `https://www.youtube.com/${doc.handle}` : dash);

    const igLink = (doc) => {
      const h = doc?.instagramHandle ? String(doc.instagramHandle).trim() : '';
      if (!h) return dash;
      const username = h.startsWith('@') ? h.slice(1) : h;
      return `https://www.instagram.com/${username}`;
    };

    const ttLink = () => dash;

    const niche = (doc) => {
      const labels = Array.isArray(doc?.topicLabels) ? doc.topicLabels : [];
      return labels[0] ? String(labels[0]) : dash;
    };

    const subNiche = (doc) => {
      const labels = Array.isArray(doc?.topicLabels) ? doc.topicLabels : [];
      return labels[1] ? String(labels[1]) : dash;
    };

    const followups = (doc) => {
      const arr = Array.isArray(doc?.followUpDates) ? doc.followUpDates : [];
      const dates = arr
        .map((x) => (x instanceof Date ? x : new Date(x)))
        .filter((d) => d && !Number.isNaN(d.getTime()))
        .sort((a, b) => b.getTime() - a.getTime());

      return {
        f1: dates[0] ? fmtDateOnly(dates[0]) : dash,
        f2: dates[1] ? fmtDateOnly(dates[1]) : dash,
      };
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

    const lines = [];
    lines.push(header.map(csvEscape).join(','));

    items.forEach((doc, idx) => {
      const fu = followups(doc);

      const row = [
        idx + 1,
        fmt(doc.title),
        fmt(doc.handle),
        fmt(doc.email),
        dash,
        ytLink(doc),
        igLink(doc),
        ttLink(doc),
        fmt(doc.country),
        fmt(doc.defaultLanguage),
        niche(doc),
        subNiche(doc),
        fmtNum(doc.subscriberCount),
        fmtNum(doc.avgViewsLast15),
        fmtPercent(doc.engagementRateLast15),
        doc.uploadFrequencyPerWeek != null ? String(doc.uploadFrequencyPerWeek) : dash,
        fmt(doc.lastSponsor),
        fmtBool(doc.managedByAgency),
        fmt(doc.topAudienceCountry),
        doc.averageAudienceAge != null ? String(doc.averageAudienceAge) : dash,
        dash,
        fmtDateOnly(doc.lastContactedAt),
        fmt(doc.workingHandle),
        fu.f1,
        fu.f2,
        dash,
        dash,
        dash,
      ];

      lines.push(row.map(csvEscape).join(','));
    });

    const csv = lines.join('\n');

    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(
      ts.getHours()
    ).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="influencers_${stamp}.csv"`);

    return res.status(200).send(csv);
  } catch (err) {
    console.error('exportInfluencersCsv error:', err);
    return res.status(400).json({
      status: 'error',
      message: err?.message || 'Failed to export influencers.',
    });
  }
});

exports.previewYouTubeProfile = asyncHandler(async (req, res) => {
  if (!YT_API_KEY) {
    return res.status(500).json({
      status: 'error',
      message: 'Missing YOUTUBE_API_KEY',
    });
  }

  const body = req.body || {};
  const handle = body.handle ? normalizeHandle(body.handle) : null;
  const channelId = cleanStrOrNull(body.channelId);
  const videosLimit = Math.min(50, Math.max(1, Number(body.videosLimit) || 15));

  if (!handle && !channelId) {
    return res.status(400).json({
      status: 'error',
      message: 'Provide handle or channelId.',
    });
  }

  const channel = handle
    ? await fetchChannelByHandle(handle)
    : await fetchChannelById(channelId);

  if (!channel) {
    return res.status(404).json({
      status: 'error',
      message: 'Channel not found.',
    });
  }

  const { resolvedHandle, profileData } = await buildYouTubeProfileData(channel, {
    inputHandle: handle,
    videosLimit,
  });

  return res.json({
    status: 'ok',
    mode: 'preview',
    stored: false,
    data: {
      ...profileData,
      handle: resolvedHandle,
    },
  });
});