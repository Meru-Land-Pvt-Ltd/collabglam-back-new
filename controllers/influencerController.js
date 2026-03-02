// controllers/influencerController.js
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

// Models
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const Category = require('../models/categories');
const Country = require('../models/country');
const Language = require('../models/language');
const VerifyEmail = require('../models/verifyEmail');
const ApplyCampaign = require('../models/applyCampaign');
const Campaign = require('../models/campaign');
// These two are referenced later in updateProfile; include them if you use them
const Audience = require('../models/audience');            // ensure this path exists
const AudienceRange = require('../models/audienceRange');  // ensure this path exists
const Modash = require('../models/modash');
const { linkConversationsForInfluencer } = require('../services/emailLinking');
const { attachExternalEmailToInfluencer } = require('../utils/emailAliases');
const { getFreePlan, computeExpiry } = require("../utils/subscriptionHelper");
const { escapeRegExp } = require('../utils/searchTokens');

const UUIDv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BASE_API_URL = 'https://api.collabglam.com';
const WELCOME_EMAIL_API_URL = `${BASE_API_URL}/emails/send-welcome`;

/* ========================= SMTP / Mailer (brand-style) ========================= */
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const JWT_SECRET = process.env.JWT_SECRET;

const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'CollabGlam';
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'CollabGlam';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

/* ===== Shared professional HTML OTP template (orange/yellow accents) ===== */
const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PREHEADER = (t) => `<div style="display:none;opacity:0;visibility:hidden;overflow:hidden;height:0;width:0;mso-hide:all;">${esc(t)}</div>`;

const WRAP = 'max-width:640px;margin:0 auto;padding:0;background:#f7fafc;color:#0f172a;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;';
const SHELL = 'padding:24px;';
const CARD = 'border-radius:16px;background:#ffffff;border:1px solid #e5e7eb;overflow:hidden;box-shadow:0 8px 20px rgba(17,24,39,0.06);';
const BRAND_BAR = 'padding:18px 20px;background:#ffffff;color:#111827;border-bottom:1px solid #FFE8B7;';
const BRAND_NAME = 'font-weight:900;font-size:15px;letter-spacing:.2px;';
const ACCENT_BAR = 'height:4px;background:linear-gradient(90deg,#FF6A00 0%, #FF8A00 30%, #FF9A00 60%, #FFBF00 100%);';
const HDR = 'padding:20px 24px 6px 24px;font-weight:800;font-size:20px;color:#111827;';
const SUBHDR = 'padding:0 24px 10px 24px;color:#374151;font-size:13px;';
const BODY = 'padding:0 24px 24px 24px;';
const FOOT = 'padding:14px 24px;color:#6b7280;font-size:12px;border-top:1px solid #f1f5f9;background:#fcfcfd;';
const BTN = 'display:inline-block;background:#111827;color:#ffffff;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:800;';
const SMALL = 'color:#6b7280;font-size:12px;';

const CODE_WRAPPER = 'margin-top:12px;margin-bottom:6px;';
const CODE = [
  'display:inline-block',
  'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
  'font-weight:900',
  'font-size:26px',
  'letter-spacing:6px',
  'color:#111827',
  'background:#FFF7E6',
  'border:1px solid #FFE2B3',
  'border-radius:14px',
  'padding:14px 18px',
].join(';');

function otpHtmlTemplate({
  title = 'Your verification code',
  subtitle = 'Use the one-time code below to continue.',
  code,
  minutes = 10,
  ctaHref,
  ctaLabel,
  footerNote = 'If you didn’t request this, you can safely ignore this email.',
  preheader = 'Your one-time verification code',
}) {
  const hasCta = Boolean(ctaHref && ctaLabel);
  return `
 ${PREHEADER(preheader)}
  <div style="${WRAP}">
    <div style="${SHELL}">
      <div style="${CARD}">
        <div style="${BRAND_BAR}">
          <div style="${BRAND_NAME}">${esc(PRODUCT_NAME)}</div>
        </div>
        <div style="${ACCENT_BAR}"></div>

        <div style="${HDR}">${esc(title)}</div>
        <div style="${SUBHDR}">${esc(subtitle)}</div>

        <div style="${BODY}">
          <div style="${CODE_WRAPPER}">
            <span style="${CODE}">${esc(code)}</span>
          </div>
          <div style="${SMALL}">This code expires in ${minutes} minutes.</div>

          ${hasCta ? `
            <div style="margin-top:16px;">
              <a href="${esc(ctaHref)}" style="${BTN}">${esc(ctaLabel)}</a>
              <div style="${SMALL};margin-top:8px;">If the button doesn’t work, copy &amp; paste this link:<br><span style="word-break:break-all;color:#111827;">${esc(ctaHref)}</span></div>
            </div>` : ''}

        </div>

        <div style="${FOOT}">
          ${esc(footerNote)}
        </div>
      </div>
    </div>
  </div>`;
}

function otpTextFallback({ code, minutes = 10, title = 'Your verification code' }) {
  return `${title}\n\nCode: ${code}\nThis code expires in ${minutes} minutes.\n\nIf you didn’t request this, you can ignore this email.`;
}

async function sendMail({ to, subject, html, text }) {
  if (!to || !SMTP_HOST || !SMTP_USER) {
    console.warn('[mailer] Missing recipient or SMTP config; skipping email');
    return;
  }
  try {
    await transporter.sendMail({
      from: `"${MAIL_FROM_NAME}" <${SMTP_USER}>`,
      to,
      subject,
      html,
      text,
    });
  } catch (e) {
    console.error('[mailer] sendMail failed:', e?.message || e);
  }
}

function norm(e) {
  return String(e || '').trim().toLowerCase();
}

/* ============================ Misc Normalizers ============================ */
const ALLOWED_GENDERS = new Set(['Female', 'Male', 'Non-binary', 'Prefer not to say', '']);
const ALLOWED_PLATFORMS = new Set(['youtube', 'tiktok', 'instagram', 'other', null]);

function normalizeGender(value) {
  if (typeof value === 'undefined' || value === null) return null; // don't update
  const raw = String(value).trim();

  const t = raw.toLowerCase();
  if (t === '' || t === 'none' || t === 'na' || t === 'n/a') return '';
  if (t === 'male' || t === 'm') return 'Male';
  if (t === 'female' || t === 'f') return 'Female';
  if (t === 'non-binary' || t === 'nonbinary' || t === 'nb') return 'Non-binary';
  if (t === 'prefer not to say' || t === 'prefer-not-to-say') return 'Prefer not to say';

  if (ALLOWED_GENDERS.has(raw)) return raw;

  return '__INVALID__';
}

function normalizePrimaryPlatform(value) {
  if (typeof value === 'undefined') return undefined; // don't update
  if (value === null) return null;
  const v = String(value).trim().toLowerCase();
  if (ALLOWED_PLATFORMS.has(v)) return v;
  return '__INVALID__';
}

async function upsertOnboardingFromPayload(inf, onboardingPayload) {
  let ob = onboardingPayload;
  if (typeof ob === 'string') {
    try { ob = JSON.parse(ob); } catch {
      const err = new Error('Invalid onboarding payload (must be JSON).');
      err.statusCode = 400; throw err;
    }
  }
  if (!ob || typeof ob !== 'object') {
    const err = new Error('onboarding must be an object.');
    err.statusCode = 400; throw err;
  }

  const catIdNum = Number(ob.categoryId);
  if (!Number.isFinite(catIdNum)) {
    const err = new Error('categoryId must be a number.');
    err.statusCode = 400; throw err;
  }

  const catDoc = await Category.findOne({ id: catIdNum }).lean();
  if (!catDoc) {
    const err = new Error('Invalid categoryId.');
    err.statusCode = 400; throw err;
  }

  let incomingIds = [];
  if (Array.isArray(ob.subcategories) && ob.subcategories.length) {
    incomingIds = ob.subcategories
      .map(s => s && s.subcategoryId)
      .filter(Boolean);
  } else if (Array.isArray(ob.subcategoryIds) && ob.subcategoryIds.length) {
    incomingIds = [...ob.subcategoryIds];
  }

  const valid = new Set((catDoc.subcategories || []).map(s => s.subcategoryId));
  const nameById = new Map((catDoc.subcategories || []).map(s => [s.subcategoryId, s.name]));

  for (const id of incomingIds) {
    if (!valid.has(id)) {
      const err = new Error(`Invalid subcategoryId for this category: ${id}`);
      err.statusCode = 400; throw err;
    }
  }

  const finalSubs = incomingIds.map(id => ({
    subcategoryId: id,
    subcategoryName: nameById.get(id)
  }));

  inf.onboarding = {
    ...(inf.onboarding || {}),
    categoryId: catDoc.id,
    categoryName: catDoc.name,
    subcategories: finalSubs
  };
}

/* =============================== Uploads =============================== */
const uploadDir = path.join(__dirname, '../uploads/profile_images');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    cb(new Error('Only JPEG, JPG, and PNG files are allowed'));
  },
  limits: { fileSize: 2 * 1024 * 1024 }
});

exports.uploadProfileImage = upload.single('profileImage');

/* ========================== OTP: Request & Verify ========================== */

exports.requestOtpInfluencer = async (req, res) => {
  const { email, role = 'Influencer' } = req.body;
  if (!email || !role) return res.status(400).json({ message: 'Both email and role are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedRole = String(role).trim();
  if (!['Influencer', 'Brand'].includes(normalizedRole)) {
    return res.status(400).json({ message: 'role must be "Influencer" or "Brand"' });
  }

  try {
    const emailRegexCI = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i');

    if (normalizedRole === 'Influencer') {
      // Only treat as "already registered" if this email belongs to a fully registered account
      const existingInf = await Influencer.findOne(
        { email: emailRegexCI },
        'otpVerified'
      );

      if (existingInf && existingInf.otpVerified) {
        return res.status(409).json({ message: 'User already present' });
      }
      // if influencer exists but otpVerified === false → allow OTP so they can "claim" it
    } else {
      const existingBrand = await Brand.findOne({ email: emailRegexCI }, '_id');
      if (existingBrand) {
        return res.status(409).json({ message: 'User already present' });
      }
    }
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await VerifyEmail.findOneAndUpdate(
      { email: normalizedEmail, role: normalizedRole },
      { $set: { otpCode: code, otpExpiresAt: expiresAt, verified: false }, $inc: { attempts: 1 } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const subject = `${PRODUCT_NAME} email verification`;
    const html = otpHtmlTemplate({
      title: 'Verify your email',
      subtitle: `Use this verification code to continue signing up as an ${normalizedRole}.`,
      code,
      minutes: 10,
      preheader: `${PRODUCT_NAME} verification code`,
    });
    const text = otpTextFallback({ code, minutes: 10, title: 'Verify your email' });

    await sendMail({ to: normalizedEmail, subject, html, text });

    return res.json({ message: 'OTP sent to email' });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Conflict while creating/updating verification record.' });
    console.error('Error in requestOtpInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.verifyOtpInfluencer = async (req, res) => {
  const { email, role = 'Influencer', otp } = req.body;
  if (!email || !role || otp == null) return res.status(400).json({ message: 'email, role and otp are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedRole = String(role).trim();
  if (!['Influencer', 'Brand'].includes(normalizedRole)) {
    return res.status(400).json({ message: 'role must be "Influencer" or "Brand"' });
  }

  try {
    const doc = await VerifyEmail.findOne({
      email: normalizedEmail,
      role: normalizedRole,
      otpCode: otp.toString().trim(),
      otpExpiresAt: { $gt: new Date() }
    });

    if (!doc) return res.status(400).json({ message: 'Invalid or expired OTP' });

    doc.verified = true;
    doc.verifiedAt = new Date();
    doc.otpCode = undefined;
    doc.otpExpiresAt = undefined;
    await doc.save();

    return res.json({ message: 'Email verified — you may now complete registration' });
  } catch (err) {
    console.error('Error in verifyOtpInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* ================================ Helpers ================================ */
const safeParse = (v) => {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  if (typeof v === 'object') return v;
  return null;
};

async function buildCategoryIndex() {
  const rows = await Category.find({}, 'id name subcategories').lean();
  const bySubId = new Map();
  const bySubName = new Map();
  const byCatId = new Map();

  for (const r of rows) {
    byCatId.set(r.id, r);
    for (const s of (r.subcategories || [])) {
      const node = {
        categoryId: r.id,
        categoryName: r.name,
        subcategoryId: s.subcategoryId,
        subcategoryName: s.name
      };
      bySubId.set(String(s.subcategoryId), node);
      bySubName.set(String(s.name).toLowerCase(), node);
    }
  }
  return { bySubId, bySubName, byCatId };
}

function normalizeCategories(raw, idx) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];

  for (const item of list) {
    if (!item) continue;

    if (typeof item === 'string') {
      const s = String(item).trim();
      if (UUIDv4Regex.test(s)) {
        const hit = idx.bySubId.get(s);
        if (hit) out.push(hit);
      } else {
        const byName = idx.bySubName.get(s.toLowerCase());
        if (byName) out.push(byName);
      }
      continue;
    }

    if (item.subcategoryId && UUIDv4Regex.test(String(item.subcategoryId))) {
      const hit = idx.bySubId.get(String(item.subcategoryId));
      if (hit) out.push(hit);
      continue;
    }

    if (typeof item.categoryId === 'number' && item.subcategoryName) {
      const cat = idx.byCatId.get(item.categoryId);
      if (cat && Array.isArray(cat.subcategories)) {
        const sub = cat.subcategories.find(
          s => String(s.name).toLowerCase() === String(item.subcategoryName).toLowerCase()
        );
        if (sub) {
          out.push({
            categoryId: cat.id,
            categoryName: cat.name,
            subcategoryId: sub.subcategoryId,
            subcategoryName: sub.name
          });
        }
      }
      continue;
    }

    if (typeof item.id === 'number' || typeof item.name === 'string') {
      const byName = item.name ? idx.bySubName.get(String(item.name).toLowerCase()) : null;
      if (byName) out.push(byName);
      continue;
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const node of out) {
    if (!seen.has(node.subcategoryId)) {
      seen.add(node.subcategoryId);
      deduped.push(node);
    }
  }
  return deduped;
}

function normalizePromptAnswers(selectedPrompts = [], promptAnswers = {}) {
  const groupByPrompt = new Map();
  if (Array.isArray(selectedPrompts)) {
    for (const sp of selectedPrompts) {
      if (sp && sp.prompt) groupByPrompt.set(String(sp.prompt), sp.group || '');
    }
  }

  if (Array.isArray(promptAnswers)) {
    return promptAnswers
      .map((row) => {
        if (!row || !row.prompt) return null;
        return {
          prompt: String(row.prompt),
          answer: row.answer != null ? String(row.answer) : '',
          group: row.group != null ? String(row.group) : (groupByPrompt.get(String(row.prompt)) || '')
        };
      })
      .filter(Boolean);
  }

  if (promptAnswers && typeof promptAnswers === 'object') {
    return Object.entries(promptAnswers).map(([prompt, answer]) => ({
      prompt: String(prompt),
      answer: answer != null ? String(answer) : '',
      group: groupByPrompt.get(String(prompt)) || ''
    }));
  }

  return [];
}

async function resolveCategoryBasics(categoryIdRaw) {
  if (!categoryIdRaw) return { categoryId: undefined, categoryName: undefined };

  let doc = null;
  if (mongoose.Types.ObjectId.isValid(categoryIdRaw)) {
    doc = await Category.findById(categoryIdRaw, 'id name').lean();
  }
  if (!doc && (/^\d+$/).test(String(categoryIdRaw))) {
    doc = await Category.findOne({ id: Number(categoryIdRaw) }, 'id name').lean();
  }

  if (!doc) return { categoryId: undefined, categoryName: undefined };
  return { categoryId: doc.id, categoryName: doc.name };
}

function extractRawCategoriesFromProviderRaw(providerRaw) {
  const p = safeParse(providerRaw) || providerRaw || {};
  const root = p.profile || p;
  const prof = root.profile || {};
  return prof.categories || root.categories || prof.interests || root.interests || [];
}

function normalizeHandle(handle, username) {
  let h = (handle || username || '').trim();
  if (!h) return null;
  if (!h.startsWith('@')) h = '@' + h;
  return h;
}

async function loadSocialProfilesFromModash(influencerId) {
  const docs = await Modash.find(
    { influencerId: String(influencerId) },
    'provider handle username followers url picture'
  ).lean();

  return docs.map(d => ({
    provider: d.provider,
    handle: normalizeHandle(d.handle, d.username),
    username: d.username || null,
    followers: Number(d.followers) || 0,
    url: d.url || null,
    picture: d.picture || null
  }));
}


const mapPayload = (provider, input) => {
  const p = safeParse(input);
  if (!p) return null;

  const root = p.profile || p;
  const prof = root.profile || {};

  return {
    provider,
    userId: root.userId || prof.userId,
    username: prof.username,
    fullname: prof.fullname,
    handle: prof.handle,
    url: prof.url,
    picture: prof.picture,
    followers: prof.followers,
    engagements: prof.engagements,
    engagementRate: prof.engagementRate,
    averageViews: prof.averageViews,

    isPrivate: root.isPrivate,
    isVerified: root.isVerified,
    accountType: root.accountType,
    secUid: root.secUid,

    city: root.city,
    state: root.state,
    country: root.country,
    ageGroup: root.ageGroup,
    gender: root.gender,
    language: root.language,

    statsByContentType: root.statsByContentType,
    stats: root.stats,
    recentPosts: root.recentPosts,
    popularPosts: root.popularPosts,

    postsCount: root.postsCount || root.postsCounts,
    avgLikes: root.avgLikes,
    avgComments: root.avgComments,
    avgViews: root.avgViews,
    avgReelsPlays: root.avgReelsPlays,
    totalLikes: root.totalLikes,
    totalViews: root.totalViews,

    bio: root.description || root.bio,

    categories: [],

    hashtags: root.hashtags,
    mentions: root.mentions,
    brandAffinity: root.brandAffinity,

    audience: root.audience,
    audienceCommenters: root.audienceCommenters,
    lookalikes: root.lookalikes || root.audienceLookalikes,

    sponsoredPosts: root.sponsoredPosts,
    paidPostPerformance: root.paidPostPerformance,
    paidPostPerformanceViews: root.paidPostPerformanceViews,
    sponsoredPostsMedianViews: root.sponsoredPostsMedianViews,
    sponsoredPostsMedianLikes: root.sponsoredPostsMedianLikes,
    nonSponsoredPostsMedianViews: root.nonSponsoredPostsMedianViews,
    nonSponsoredPostsMedianLikes: root.nonSponsoredPostsMedianLikes,

    audienceExtra: root.audienceExtra,
    providerRaw: p
  };
};

/* ============================== Registration ============================== */
exports.registerInfluencer = async (req, res) => {
  try {
    let {
      name, email, password, phone,
      countryId, callingId,
      city, gender, dateOfBirth, selectedLanguages,
      platforms, youtube, tiktok, instagram,
      preferredProvider
    } = req.body;

    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return res.status(400).json({ message: 'Email is required' });
    if (!password || String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    if (!name || !countryId) {
      return res.status(400).json({ message: 'Missing required fields (name, countryId)' });
    }

    const verifiedRec = await VerifyEmail.findOne({
      email: normalizedEmail,
      role: 'Influencer',
      verified: true
    });
    if (!verifiedRec) return res.status(400).json({ message: 'Email not verified' });

    const emailRegexCI = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i');
    // Look up any existing influencer with this email
    const existingInf = await Influencer.findOne({ email: emailRegexCI });

    if (existingInf && existingInf.otpVerified) {
      // This is a fully registered account → block
      return res.status(400).json({ message: 'Already registered' });
    }

    const [countryDoc] = await Promise.all([
      Country.findById(countryId)
    ]);
    if (!countryDoc) return res.status(400).json({ message: 'Invalid countryId' });
    // 🔹 1) Build Modash profile payloads from incoming data
    const profiles = [];

    if (Array.isArray(platforms)) {
      // New structured payload: [{ provider, data, categories }]
      for (const item of platforms) {
        if (!item || !item.provider) continue;

        const mapped = mapPayload(String(item.provider).toLowerCase(), item.data);
        if (!mapped) continue;

        // ⬇️ If frontend sent categories, attach them
        if (Array.isArray(item.categories) && item.categories.length) {
          mapped.categories = item.categories;
        }

        profiles.push(mapped);
      }
    } else {
      // Legacy separate fields: youtube / tiktok / instagram
      const y = mapPayload('youtube', youtube);
      const tt = mapPayload('tiktok', tiktok);
      const ig = mapPayload('instagram', instagram);

      if (y) {
        if (Array.isArray(youtube?.categories) && youtube.categories.length) {
          y.categories = youtube.categories;
        }
        profiles.push(y);
      }

      if (tt) {
        if (Array.isArray(tiktok?.categories) && tiktok.categories.length) {
          tt.categories = tiktok.categories;
        }
        profiles.push(tt);
      }

      if (ig) {
        if (Array.isArray(instagram?.categories) && instagram.categories.length) {
          ig.categories = instagram.categories;
        }
        profiles.push(ig);
      }
    }


    if (!profiles.length) {
      return res.status(400).json({ message: 'No valid platform payloads provided' });
    }

    // 🔹 2) Normalize categories for each profile
    const idx = await buildCategoryIndex();

    for (const prof of profiles) {
      let rawCats = [];

      // 1️⃣ Prefer categories explicitly sent from frontend (platforms[i].categories / youtube.categories etc.)
      if (Array.isArray(prof.categories) && prof.categories.length) {
        rawCats = prof.categories;
      } else {
        // 2️⃣ Fallback: derive from Modash providerRaw (categories / interests)
        rawCats = extractRawCategoriesFromProviderRaw(prof.providerRaw);
      }

      // Convert whatever we have -> [{ categoryId, categoryName, subcategoryId, subcategoryName }]
      prof.categories = normalizeCategories(rawCats, idx);
    }


    // 🔹 3) Resolve languages into embedded refs
    let languageDocs = [];
    if (Array.isArray(selectedLanguages) && selectedLanguages.length) {
      const langs = await Language.find(
        { _id: { $in: selectedLanguages } },
        'code name'
      ).lean();

      const byId = new Map(langs.map(l => [String(l._id), l]));
      languageDocs = selectedLanguages
        .map(id => byId.get(String(id)))
        .filter(Boolean)
        .map(l => ({
          languageId: l._id,
          code: l.code,
          name: l.name
        }));
    }

    // 🔹 4) Determine primaryPlatform based on available Modash profiles
    const validProviders = new Set(profiles.map(p => p.provider));
    let primaryPlatform = profiles[0]?.provider || null;
    if (preferredProvider && validProviders.has(preferredProvider)) {
      primaryPlatform = preferredProvider;
    }

    // 🔹 5) Create core Influencer document (NO socialProfiles HERE anymore)
    let inf = existingInf;

    if (!inf) {
      // Normal case: no influencer yet → create new
      inf = new Influencer({
        name,
        email: normalizedEmail,
        password,
        phone: phone || '',

        primaryPlatform,

        countryId,
        country: countryDoc.countryName,

        city: city || '',
        gender: gender || '',
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
        languages: languageDocs,

        otpVerified: true
      });
    } else {
      // CLAIM CASE: this email was pre-created from an invite / admin flow.
      // Upgrade it into a real, login-able account.
      inf.name = name;
      inf.email = normalizedEmail; // just to be safe
      inf.password = password;
      inf.phone = phone || inf.phone || '';

      inf.primaryPlatform = primaryPlatform;

      inf.countryId = countryId;
      inf.country = countryDoc.countryName;
      inf.city = city || inf.city || '';

      // You can choose whether to override or keep previous gender/dateOfBirth:
      inf.gender = gender || inf.gender || '';
      inf.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : inf.dateOfBirth;

      inf.languages = languageDocs;
      inf.otpVerified = true; // mark as fully registered now
    }

    // Attach free subscription ONLY if they don't already have a plan
    const freePlan = await getFreePlan("Influencer");
    console.log('[registerInfluencer] freePlan for Influencer:', freePlan && {
      planId: freePlan.planId,
      role: freePlan.role,
      name: freePlan.name,
    });

    if (freePlan && (!inf.subscription || !inf.subscription.planId)) {
      inf.subscription = {
        planId: freePlan.planId,
        planName: freePlan.name,
        startedAt: new Date(),
        expiresAt:computeExpiry(freePlan),
        features: freePlan.features.map(f => ({
          key: f.key,
          limit: typeof f.value === 'number' ? f.value : 0,
          used: 0
        }))
      };
      inf.subscriptionExpired = false;
    }

    await inf.save();
    await linkConversationsForInfluencer(inf, inf.email);
    // 🔹 7) Persist Modash profile data in separate Modash collection
    try {
      await Promise.all(
        profiles.map(async (prof) => {
          // Derive a stable userId for the Modash doc
          const raw = prof.providerRaw || {};
          const profileRoot = raw.profile || raw;
          const nestedProf = profileRoot.profile || profileRoot;

          const userId =
            prof.userId ||
            prof.secUid ||
            prof.username ||
            raw.userId ||
            profileRoot.userId ||
            nestedProf.userId;

          if (!userId) {
            console.warn(
              '[registerInfluencer] Skipping Modash link because no userId/secUid/username found',
              { provider: prof.provider }
            );
            return;
          }

          await Modash.findOneAndUpdate(
            // IMPORTANT: match by canonical key (respects unique index userId+provider)
            { provider: prof.provider, userId },
            {
              $set: {
                // link this Modash profile to the newly created influencer
                influencer: inf._id,
                influencerId: inf.influencerId,

                // ensure userId is stored even if it was only in providerRaw
                userId,

                // rest of Modash payload (handle, followers, url, categories, providerRaw, etc.)
                ...prof
              }
            },
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true
            }
          );
        })
      );
    } catch (modashErr) {
      // Don't block registration if Modash sync fails
      console.error('Error saving Modash profiles for influencer:', modashErr);
    }

    // Clean up verification record
    await VerifyEmail.deleteOne({ email: normalizedEmail, role: 'Influencer' });

    // --- NEW: Trigger Welcome Email API Call (Non-blocking) ---
    const emailPayload = {
      email: normalizedEmail,
      name: name,
      userType: 'influencer',
    };

    // IMPORTANT: Ensure 'fetch' is available and WELCOME_EMAIL_API_URL is the correct, full URL
    fetch(WELCOME_EMAIL_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload),
    })
      .then(response => {
        // Log a warning if the email API request failed (status != 2xx)
        if (!response.ok) {
          console.warn(`Welcome email API responded with non-2xx status: ${response.status} for ${normalizedEmail}`);
        }
      })
      .catch(error => {
        // Log the error but do not throw, as registration is already complete.
        console.error(`Failed to trigger welcome email API for ${normalizedEmail}:`, error.message);
      });
    // ------------------------------------------------------------


    // 🔹 8) Response: keep `socialProfilesCount` for backward compatibility
    return res.status(201).json({
      message: 'Influencer registered successfully',
      influencerId: inf.influencerId,
      primaryPlatform: inf.primaryPlatform,
      socialProfilesCount: profiles.length,
      subscription: inf.subscription
    });
  } catch (err) {
    console.error('Error in registerInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* ====================== Save Quick Questions Onboarding ====================== */
exports.saveQuickOnboarding = async (req, res) => {
  try {
    const {
      influencerId,
      email,

      // step fields (do NOT default these)
      formats,
      budgets,
      projectLength,
      capacity,

      categoryId,
      subcategories,

      collabTypes,
      allowlisting,
      cadences,

      selectedPrompts,
      promptAnswers,

      onboardingStepCompleted
    } = req.body;

    if (!influencerId && !email) {
      return res.status(400).json({ message: 'influencerId or email is required' });
    }

    const query = influencerId
      ? { influencerId }
      : { email: new RegExp(`^${escapeRegExp(String(email).trim().toLowerCase())}$`, 'i') };

    const inf = await Influencer.findOne(query);
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    // Ensure onboarding object exists
    if (!inf.onboarding) inf.onboarding = {};

    // Build a patch object only from provided fields
    const patch = {};

    // Step 1
    if (formats !== undefined) {
      patch['onboarding.formats'] = Array.isArray(formats) ? formats : [];
    }

    if (budgets !== undefined) {
      let budgetArr = [];
      if (Array.isArray(budgets)) {
        budgetArr = budgets;
      } else if (budgets && typeof budgets === 'object') {
        budgetArr = Object.entries(budgets).map(([format, range]) => ({ format, range }));
      }
      patch['onboarding.budgets'] = budgetArr;
    }

    if (projectLength !== undefined) patch['onboarding.projectLength'] = projectLength || '';
    if (capacity !== undefined) patch['onboarding.capacity'] = capacity || '';

    // Step 2
    if (categoryId !== undefined) {
      const { categoryId: catNumId, categoryName: catName } = await resolveCategoryBasics(categoryId);

      patch['onboarding.categoryId'] = typeof catNumId === 'number' ? catNumId : undefined;
      patch['onboarding.categoryName'] = catName || undefined;

      // If subcategories are provided, normalize & store them
      if (subcategories !== undefined) {
        const idx = await buildCategoryIndex();
        let subLinks = normalizeCategories(Array.isArray(subcategories) ? subcategories : [], idx);

        if (typeof catNumId === 'number') {
          subLinks = subLinks.filter(s => s.categoryId === catNumId);
        }

        patch['onboarding.subcategories'] = subLinks.map(s => ({
          subcategoryId: s.subcategoryId,
          subcategoryName: s.subcategoryName
        }));
      }
    } else if (subcategories !== undefined) {
      // category not provided but subcategories provided (optional case)
      const idx = await buildCategoryIndex();
      const subLinks = normalizeCategories(Array.isArray(subcategories) ? subcategories : [], idx);

      patch['onboarding.subcategories'] = subLinks.map(s => ({
        subcategoryId: s.subcategoryId,
        subcategoryName: s.subcategoryName
      }));
    }

    if (collabTypes !== undefined) patch['onboarding.collabTypes'] = Array.isArray(collabTypes) ? collabTypes : [];
    if (allowlisting !== undefined) patch['onboarding.allowlisting'] = !!allowlisting;
    if (cadences !== undefined) patch['onboarding.cadences'] = Array.isArray(cadences) ? cadences : [];

    // Step 3
    if (selectedPrompts !== undefined) patch['onboarding.selectedPrompts'] = Array.isArray(selectedPrompts) ? selectedPrompts : [];
    if (promptAnswers !== undefined && selectedPrompts !== undefined) {
      patch['onboarding.promptAnswers'] = normalizePromptAnswers(
        Array.isArray(selectedPrompts) ? selectedPrompts : [],
        promptAnswers || {}
      );
    } else if (promptAnswers !== undefined) {
      // if they send promptAnswers alone, store raw-ish (or skip)
      patch['onboarding.promptAnswers'] = promptAnswers || {};
    }

    if (onboardingStepCompleted !== undefined) {
      patch['onboarding.onboardingStepCompleted'] = onboardingStepCompleted;
    }

    // Apply patch
    await Influencer.updateOne(query, { $set: patch });

    return res.json({ message: 'Onboarding saved', influencerId: inf.influencerId });
  } catch (err) {
    console.error('saveQuickOnboarding error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Both fields are required' });
  }

  try {
    const influencer = await Influencer.findOne({
      email: { $regex: `^${email.trim()}$`, $options: 'i' }
    });
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const now = new Date();
    if (influencer.lockUntil && influencer.lockUntil > now) {
      const msLeft = influencer.lockUntil.getTime() - now.getTime();
      const minutesLeft = Math.ceil(msLeft / (60 * 1000));
      return res.status(403).json({
        message: 'Account locked due to multiple failed login attempts. Try again after the lock period.',
        lockUntil: influencer.lockUntil,
        minutesLeft
      });
    }

    const isMatch = await influencer.comparePassword(password);
    if (!isMatch) {
      influencer.failedLoginAttempts = (influencer.failedLoginAttempts || 0) + 1;

      if (influencer.failedLoginAttempts >= 3) {
        const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
        influencer.lockUntil = new Date(Date.now() + LOCK_WINDOW_MS);
      }

      await influencer.save();
      await linkConversationsForInfluencer(influencer, influencer.email);
      if (influencer.lockUntil && influencer.lockUntil > now) {
        return res.status(403).json({
          message: 'Too many failed attempts. Account locked for 24 hours.',
          lockUntil: influencer.lockUntil
        });
      }

      const attemptsLeft = Math.max(0, 3 - influencer.failedLoginAttempts);
      return res.status(400).json({
        message: 'Invalid credentials',
        attemptsLeft
      });
    }

    if (influencer.failedLoginAttempts || influencer.lockUntil) {
      influencer.failedLoginAttempts = 0;
      influencer.lockUntil = null;
      await influencer.save();
    }

    const token = jwt.sign(
      { influencerId: influencer.influencerId, email: influencer.email },
      JWT_SECRET,
      { expiresIn: '100d' }
    );

    // 🔹 NEW: prepare subscription info for response
    const subscription = influencer.subscription || {};

    return res.status(200).json({
      message: 'Login successful',
      influencerId: influencer.influencerId,
      categoryId: influencer.categoryId, // keep whatever you already use
      token,
      // convenience top-level field
      subscriptionPlanName: subscription.planName,
      // full subscription object (planId, planName, startedAt, expiresAt, features, etc.)
      subscription,
      // if you want explicit flag in response too:
      subscriptionExpired: influencer.subscriptionExpired
    });
  } catch (error) {
    console.error('Error in influencer.login:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(403).json({ message: 'Token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }
    req.influencer = decoded;
    next();
  });
};

exports.getList = async (req, res) => {
  try {
    const influencers = await Influencer.find({}, '-password -__v');
    return res.status(200).json(influencers);
  } catch (error) {
    console.error('Error fetching influencers:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getById = async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ message: 'Body parameter "id" (influencerId) is required.' });
    }

    const influencer = await Influencer.findOne({ influencerId: id })
      .select('-password -__v')
      .lean();

    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    // 🔹 NEW: attach socialProfiles from Modash
    const socialProfiles = await loadSocialProfilesFromModash(id);
    influencer.socialProfiles = socialProfiles;

    return res.status(200).json({ influencer });
  } catch (err) {
    console.error('Error in adminGetInfluencerById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getCampaignsByInfluencer = async (req, res) => {
  try {
    const {
      influencerId,
      page = 1,
      limit = 10,
      search = '',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    // 🔹 Get influencer (for name, etc.)
    const influencer = await Influencer.findOne(
      { influencerId },
      'name email influencerId'
    ).lean();

    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const influencerName = influencer.name || '';

    // 1) Find all ApplyCampaign docs where this influencer has applied or is approved
    const applyDocs = await ApplyCampaign.find({
      $or: [
        { 'applicants.influencerId': influencerId },
        { 'approved.influencerId': influencerId }
      ]
    }).lean();

    if (!applyDocs.length) {
      return res.status(200).json({
        total: 0,
        page: Number(page) || 1,
        pages: 0,
        influencer: {
          influencerId: influencer.influencerId,
          name: influencerName,
          email: influencer.email || ''
        },
        campaigns: []
      });
    }

    // 2) Collect distinct campaignIds from ApplyCampaign
    const campaignIds = [
      ...new Set(
        applyDocs
          .map(doc => doc.campaignId)
          .filter(Boolean)
      )
    ];

    // 3) Build Campaign filter.
    // NOTE: Campaign schema uses "campaignsId", so we match that to ApplyCampaign.campaignId
    const filter = {
      campaignsId: { $in: campaignIds },
      // uncomment this if you want to hide drafts:
      // isDraft: 0
    };

    if (search && String(search).trim()) {
      const s = String(search).trim();
      filter.$or = [
        { productOrServiceName: { $regex: s, $options: 'i' } },
        { brandName: { $regex: s, $options: 'i' } },
        { description: { $regex: s, $options: 'i' } }
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 10, 1);
    const skip = (pageNum - 1) * limitNum;
    const sortDirection = sortOrder === 'asc' ? 1 : -1;

    // 4) Fetch campaigns
    const total = await Campaign.countDocuments(filter);
    const campaigns = await Campaign.find(filter)
      .sort({ [sortBy]: sortDirection })
      .skip(skip)
      .limit(limitNum)
      .lean();

    // 5) Map to response & compute status per campaign
    const result = campaigns.map(campaign => {
      // Match ApplyCampaign doc for this campaign
      const related = applyDocs.find(d => d.campaignId === campaign.campaignsId);

      let status = 'pending';
      if (related?.approved?.some(a => a.influencerId === influencerId)) {
        status = 'approved';
      }

      const campaignName = campaign.productOrServiceName || '';

      return {
        // IDs
        id: campaign.campaignsId,
        campaignId: campaign.campaignsId,

        // Names
        campaignName,                          // ✅ explicit campaign name
        name: campaignName,                    // ✅ alias (backward compatible)
        brandName: campaign.brandName || '',
        influencerId,
        influencerName,                        // ✅ influencer name

        // Core info
        description: campaign.description || '',
        goal: campaign.goal || '',
        campaignType: campaign.campaignType || '',
        budget: campaign.budget || 0,
        targetAudience: campaign.targetAudience || null,
        categories: campaign.categories || [],
        timeline: campaign.timeline || {},
        images: campaign.images || [],
        additionalNotes: campaign.additionalNotes || '',

        // Status
        appliedDate: related?.createdAt || campaign.createdAt,
        status,
        isActive: campaign.isActive,
        isDraft: campaign.isDraft,

        // Meta
        createdAt: campaign.createdAt
      };
    });

    return res.status(200).json({
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      influencer: {
        influencerId: influencer.influencerId,
        name: influencerName,
        email: influencer.email || ''
      },
      campaigns: result
    });
  } catch (error) {
    console.error('Error in getCampaignsByInfluencer:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.requestPasswordResetOtpInfluencer = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  const normalizedEmail = String(email).trim().toLowerCase();

  const influencer = await Influencer.findOne({
    email: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    name: { $exists: true, $ne: null },
    password: { $exists: true, $ne: null },
  });

  // ✅ Explicit response when not found
  if (!influencer) {
    return res.status(404).json({ message: 'Influencer does not exist with this email' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  influencer.passwordResetCode = code;
  influencer.passwordResetExpiresAt = expiresAt;
  influencer.passwordResetVerified = false;
  await influencer.save();

  const subject = 'Password reset code';
  const html = otpHtmlTemplate({
    title: 'Password reset code',
    subtitle: 'Use this one-time code to reset your password.',
    code,
    minutes: 10,
    preheader: 'Your password reset code',
  });
  const text = otpTextFallback({ code, minutes: 10, title: 'Password reset code' });

  await sendMail({
    to: influencer.email,
    subject,
    html,
    text,
  });

  return res.status(200).json({ message: 'OTP sent to your email' });
};

exports.verifyPasswordResetOtpInfluencer = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || otp == null) {
    return res.status(400).json({ message: 'Email and otp required' });
  }

  const influencer = await Influencer.findOne({
    email: { $regex: `^${email.trim()}$`, $options: 'i' },
    passwordResetCode: otp.toString().trim(),
    passwordResetExpiresAt: { $gt: new Date() }
  });

  if (!influencer) {
    return res.status(400).json({ message: 'Invalid or expired OTP' });
  }

  influencer.passwordResetVerified = true;
  influencer.passwordResetCode = undefined;
  influencer.passwordResetExpiresAt = undefined;
  await influencer.save();

  const resetToken = jwt.sign(
    { influencerId: influencer.influencerId, email: influencer.email, prt: true },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  return res.status(200).json({ message: 'OTP verified', resetToken });
};

exports.resetPasswordInfluencer = async (req, res) => {
  const { resetToken, newPassword, confirmPassword } = req.body;
  if (!resetToken || !newPassword) {
    return res.status(400).json({ message: 'resetToken and newPassword required' });
  }
  if (confirmPassword != null && confirmPassword !== newPassword) {
    return res.status(400).json({ message: 'Passwords do not match' });
  }

  try {
    const decoded = jwt.verify(resetToken, JWT_SECRET);
    if (!decoded.prt) {
      return res.status(403).json({ message: 'Invalid reset token' });
    }

    const influencer = await Influencer.findOne({ influencerId: decoded.influencerId });
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    if (!influencer.passwordResetVerified) {
      return res.status(400).json({ message: 'Password reset not verified' });
    }

    influencer.password = newPassword;
    influencer.failedLoginAttempts = 0;
    influencer.lockUntil = null;
    influencer.passwordResetVerified = false;

    await influencer.save();

    return res.status(200).json({ message: 'Password reset successful. You can log in now.' });
  } catch (err) {
    console.error('Error in resetPasswordInfluencer:', err);
    return res.status(403).json({ message: 'Invalid or expired reset token' });
  }
};

/* ============================ Payments (CRUD) ============================ */
exports.addPaymentMethod = async (req, res) => {
  try {
    const { type, bank = {}, paypal = {}, isDefault = false, influencerId } = req.body;

    if (![0, 1].includes(Number(type))) {
      return res.status(400).json({ message: 'type must be 0 (PayPal) or 1 (Bank)' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const paymentObj = {
      paymentId: uuidv4(),
      type: Number(type),
      bank: undefined,
      paypal: undefined,
      isDefault: Boolean(isDefault)
    };

    if (Number(type) === 1) {
      const required = ['accountHolder', 'accountNumber', 'bankName', 'countryId'];
      for (const f of required) {
        if (!bank[f] || !bank[f].toString().trim()) {
          return res.status(400).json({ message: `Missing bank field: ${f}` });
        }
      }

      const countryDoc = await Country.findById(bank.countryId);
      if (!countryDoc) {
        return res.status(400).json({ message: 'Invalid bank.countryId' });
      }

      paymentObj.bank = {
        accountHolder: bank.accountHolder.trim(),
        accountNumber: bank.accountNumber.trim(),
        ifsc: bank.ifsc?.trim(),
        swift: bank.swift?.trim(),
        bankName: bank.bankName.trim(),
        branch: bank.branch?.trim(),
        countryId: countryDoc._id,
        countryName: countryDoc.countryName
      };

    } else {
      if (!paypal.email || !paypal.email.trim()) {
        return res.status(400).json({ message: 'paypal.email is required' });
      }
      paymentObj.paypal = {
        email: paypal.email.trim(),
        username: paypal.username?.trim()
      };
    }

    if (paymentObj.isDefault) {
      inf.paymentMethods.forEach(pm => (pm.isDefault = false));
    } else if (inf.paymentMethods.length === 0) {
      paymentObj.isDefault = true;
    }

    inf.paymentMethods.push(paymentObj);
    await inf.save();

    return res.status(201).json({
      message: 'Payment method added',
      paymentId: paymentObj.paymentId,
      paymentMethods: inf.paymentMethods
    });

  } catch (err) {
    console.error('Error in addPaymentMethod:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.deletePaymentMethod = async (req, res) => {
  try {
    const { influencerId } = req.influencer || {};
    const { paymentId } = req.body;

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    const idx = inf.paymentMethods.findIndex(pm => pm.paymentId === paymentId);
    if (idx === -1) return res.status(404).json({ message: 'Payment method not found' });

    const wasDefault = inf.paymentMethods[idx].isDefault;
    inf.paymentMethods.splice(idx, 1);

    if (wasDefault && inf.paymentMethods.length > 0) {
      inf.paymentMethods[0].isDefault = true;
    }

    await inf.save();
    return res.status(200).json({ message: 'Payment method deleted', paymentMethods: inf.paymentMethods });
  } catch (err) {
    console.error('Error in deletePaymentMethod:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

const mask = (val = '', keep = 4) =>
  val.length <= keep ? val : '*'.repeat(val.length - keep) + val.slice(-keep);

exports.viewPaymentByType = async (req, res) => {
  try {
    const requester = req.influencer;
    const { influencerId, type } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }
    if (type === undefined || ![0, 1].includes(Number(type))) {
      return res.status(400).json({ message: 'type must be 0 (PayPal) or 1 (Bank)' });
    }
    if (!requester || requester.influencerId !== influencerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const inf = await Influencer.findOne(
      { influencerId },
      'paymentMethods influencerId'
    );
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    let methods = inf.paymentMethods.filter(pm => pm.type === Number(type));

    if (Number(type) === 1) {
      methods = methods.map(pm => {
        const obj = pm.toObject();
        if (obj.bank?.accountNumber) {
          obj.bank.accountNumber = mask(obj.bank.accountNumber);
        }
        return obj;
      });
    }

    return res.status(200).json({
      influencerId: inf.influencerId,
      type: Number(type),
      paymentMethods: methods
    });

  } catch (err) {
    console.error('Error in viewPaymentByType:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.updatePaymentMethod = async (req, res) => {
  try {
    const {
      paymentId,
      type,
      bank = {},
      paypal = {},
      isDefault,
      influencerId
    } = req.body || {};

    if (!paymentId) {
      return res.status(400).json({ message: 'paymentId is required' });
    }
    if (type === undefined || ![0, 1].includes(Number(type))) {
      return res.status(400).json({ message: 'type must be 0 (PayPal) or 1 (Bank)' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const pm = inf.paymentMethods.id(paymentId) || inf.paymentMethods.find(p => p.paymentId === paymentId);
    if (!pm) {
      return res.status(404).json({ message: 'Payment method not found' });
    }

    pm.type = Number(type);

    if (pm.type === 1) {
      const required = ['accountHolder', 'accountNumber', 'bankName', 'countryId'];
      for (const f of required) {
        const val = bank[f] ?? pm.bank?.[f];
        if (!val || !String(val).trim()) {
          return res.status(400).json({ message: `Missing bank field: ${f}` });
        }
      }

      let countryDoc;
      if (bank.countryId && String(bank.countryId) !== String(pm.bank?.countryId)) {
        countryDoc = await Country.findById(bank.countryId);
        if (!countryDoc) {
          return res.status(400).json({ message: 'Invalid bank.countryId' });
        }
      } else {
        countryDoc = await Country.findById(pm.bank.countryId);
      }

      pm.bank = {
        accountHolder: (bank.accountHolder ?? pm.bank.accountHolder).trim(),
        accountNumber: (bank.accountNumber ?? pm.bank.accountNumber).trim(),
        ifsc: bank.ifsc?.trim() ?? pm.bank.ifsc,
        swift: bank.swift?.trim() ?? pm.bank.swift,
        bankName: (bank.bankName ?? pm.bank.bankName).trim(),
        branch: bank.branch?.trim() ?? pm.bank.branch,
        countryId: countryDoc._id,
        countryName: countryDoc.countryName
      };
      pm.paypal = undefined;

    } else {
      const emailVal = paypal.email ?? pm.paypal?.email;
      if (!emailVal || !String(emailVal).trim()) {
        return res.status(400).json({ message: 'paypal.email is required' });
      }
      pm.paypal = {
        email: paypal.email?.trim() ?? pm.paypal.email,
        username: paypal.username?.trim() ?? pm.paypal.username
      };
      pm.bank = undefined;
    }

    if (typeof isDefault === 'boolean') {
      if (isDefault) {
        inf.paymentMethods.forEach(x => (x.isDefault = false));
        pm.isDefault = true;
      } else {
        pm.isDefault = false;
        if (!inf.paymentMethods.some(x => x.isDefault)) {
          pm.isDefault = true;
        }
      }
    }

    await inf.save();

    return res.status(200).json({
      message: 'Payment method updated',
      paymentMethod: pm,
      paymentMethods: inf.paymentMethods
    });

  } catch (err) {
    console.error('Error in updatePaymentMethod:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* ============================ Search Endpoints ============================ */
const delay = ms => new Promise(res => setTimeout(res, ms));

exports.searchInfluencers = async (req, res) => {
  try {
    const requester = req.brand;
    const { search, brandId } = req.body || {};

    if (!brandId) return res.status(400).json({ message: 'brandId is required' });
    if (!requester || requester.brandId !== brandId) return res.status(403).json({ message: 'Forbidden' });

    if (!search || !String(search).trim()) {
      return res.status(400).json({ message: 'search is required' });
    }

    await delay(300);

    const q = search.trim();
    const rx = new RegExp(q, 'i');
    const docs = await Influencer.find({ name: rx }, 'name influencerId').limit(10).lean();

    if (docs.length === 0) {
      return res.status(404).json({ message: 'No influencers found' });
    }

    const results = docs.map(d => ({ name: d.name, influencerId: d.influencerId }));
    return res.json({ results });
  } catch (err) {
    console.error('Error in searchInfluencers:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.searchBrands = async (req, res) => {
  try {
    const requester = req.influencer;
    const { search } = req.body || {};

    if (!requester || !requester.influencerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (!search || !String(search).trim()) {
      return res.status(400).json({ message: 'search is required' });
    }

    await delay(300);

    const regex = new RegExp(search.trim(), 'i');
    const docs = await Brand.find({ name: regex }, 'name brandId')
      .limit(10)
      .lean();

    if (docs.length === 0) {
      return res.status(404).json({ message: 'No brands found' });
    }

    const results = docs.map(d => ({
      name: d.name,
      brandId: d.brandId
    }));
    return res.json({ results });
  } catch (err) {
    console.error('Error in searchBrands:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.suggestInfluencers = async (req, res) => {
  try {
    const { q: rawQ = '', limit: rawLimit = 8 } = req.body || {};
    const q = String(rawQ).trim().toLowerCase();
    const limit = Math.max(1, Math.min(20, parseInt(rawLimit, 10) || 8));
    if (!q) return res.json({ success: true, suggestions: [] });

    const candidates = await Influencer.find(
      {},
      'name categoryName platformName country socialMedia'
    ).limit(100).lean();

    const set = new Set();
    for (const c of candidates) {
      if (c.name) set.add(c.name);
      if (Array.isArray(c.categoryName)) c.categoryName.forEach(v => v && set.add(v));
      if (c.platformName) set.add(c.platformName);
      if (c.country) set.add(c.country);
      if (c.socialMedia) set.add(c.socialMedia);
    }

    const list = Array.from(set);
    const starts = list.filter(s => String(s).toLowerCase().startsWith(q));
    const contains = list.filter(s => !String(s).toLowerCase().startsWith(q) && String(s).toLowerCase().includes(q));
    const ordered = [...starts, ...contains].slice(0, limit);

    res.json({ success: true, suggestions: ordered });
  } catch (err) {
    console.error('Suggestion error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ========================= Profile Update (no email) ========================= */
exports.updateProfile = async (req, res) => {
  try {
    const {
      influencerId,
      name,
      password,
      phone,
      socialMedia,
      gender,
      primaryPlatform,
      profileLink,
      malePercentage,
      femalePercentage,
      audienceAgeRangeId,
      audienceId,
      countryId,
      callingId,
      bio,
      onboarding
    } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    if (typeof req.body.email !== 'undefined') {
      return res.status(400).json({ message: 'Email cannot be updated here. Use requestEmailUpdate & verifyotp.' });
    }

    if (req.file) {
      inf.profileImage = `/uploads/profile_images/${req.file.filename}`;
    }

    if (typeof name !== 'undefined') inf.name = name;
    if (typeof password !== 'undefined' && password) inf.password = password;
    if (typeof phone !== 'undefined') inf.phone = phone;
    if (typeof socialMedia !== 'undefined') inf.socialMedia = socialMedia;
    if (typeof profileLink !== 'undefined') inf.profileLink = profileLink;
    if (typeof bio !== 'undefined') inf.bio = bio;

    if (typeof gender !== 'undefined') {
      const g = normalizeGender(gender);
      if (g === '__INVALID__') {
        return res.status(400).json({ message: 'Invalid gender. Allowed: Male, Female, Non-binary, Prefer not to say, or empty.' });
      }
      if (g !== null) inf.gender = g;
    }

    if (typeof primaryPlatform !== 'undefined') {
      const p = normalizePrimaryPlatform(primaryPlatform);
      if (p === '__INVALID__') {
        return res.status(400).json({ message: 'Invalid primaryPlatform. Allowed: youtube | tiktok | instagram | other | null.' });
      }
      inf.primaryPlatform = p;
    }

    const hasMale = typeof malePercentage !== 'undefined';
    const hasFemale = typeof femalePercentage !== 'undefined';
    if (hasMale || hasFemale) {
      inf.audienceBifurcation = {
        malePercentage: hasMale ? Number(malePercentage) : inf.audienceBifurcation?.malePercentage,
        femalePercentage: hasFemale ? Number(femalePercentage) : inf.audienceBifurcation?.femalePercentage
      };
    }

    if (typeof audienceAgeRangeId !== 'undefined') {
      const ageRangeDoc = await Audience.findOne({ audienceId: audienceAgeRangeId });
      if (!ageRangeDoc) return res.status(400).json({ message: 'Invalid audienceAgeRangeId' });
      inf.audienceAgeRangeId = ageRangeDoc._id;
      inf.audienceAgeRange = ageRangeDoc.range;
    }

    if (typeof audienceId !== 'undefined') {
      const countRangeDoc = await AudienceRange.findById(audienceId);
      if (!countRangeDoc) return res.status(400).json({ message: 'Invalid audienceId' });
      inf.audienceId = countRangeDoc._id;
      inf.audienceRange = countRangeDoc.range;
    }

    if (typeof countryId !== 'undefined') {
      const countryDoc = await Country.findById(countryId);
      if (!countryDoc) return res.status(400).json({ message: 'Invalid countryId' });
      inf.countryId = countryDoc._id;
      inf.country = countryDoc.countryName;
    }
    if (typeof callingId !== 'undefined') {
      const callingDoc = await Country.findById(callingId);
      if (!callingDoc) return res.status(400).json({ message: 'Invalid callingId' });
      inf.callingId = callingDoc._id;
      inf.callingcode = callingDoc.callingCode;
    }

    if (typeof onboarding !== 'undefined') {
      await upsertOnboardingFromPayload(inf, onboarding);
    }

    await inf.save();

    return res.status(200).json({
      message: 'Profile updated successfully',
      onboarding: inf.onboarding,
      primaryPlatform: inf.primaryPlatform,
      gender: inf.gender,
      socialMedia: inf.socialMedia,
      profileLink: inf.profileLink,
      country: { id: inf.countryId, name: inf.country },
      calling: { id: inf.callingId, code: inf.callingcode }
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('Error in updateProfile:', err);
    return res.status(status).json({ message: err.message || 'Internal server error' });
  }
};

/* ================= Email Update (single-OTP to NEW email) ================= */
exports.requestEmailUpdate = async (req, res) => {
  try {
    const { influencerId, newEmail, role = 'Influencer' } = req.body || {};
    if (!influencerId || !newEmail || !role) {
      return res.status(400).json({ message: 'influencerId, newEmail and role are required' });
    }
    if (String(role).trim() !== 'Influencer') {
      return res.status(400).json({ message: 'role must be "Influencer" for this endpoint' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    const oldEmail = String(inf.email || '').trim().toLowerCase();
    const nextEmail = String(newEmail || '').trim().toLowerCase();
    if (!nextEmail) {
      return res.status(400).json({ message: 'newEmail is required' });
    }
    if (nextEmail === oldEmail) {
      return res.status(400).json({ message: 'New email must be different from current email' });
    }

    // ensure new email not used by another influencer
    const emailRegexCI = new RegExp(`^${escapeRegExp(nextEmail)}$`, 'i');
    const exists = await Influencer.findOne({ email: emailRegexCI }, '_id influencerId');
    if (exists && String(exists.influencerId) !== String(influencerId)) {
      return res.status(409).json({ message: 'New email already in use' });
    }

    // 🔐 generate ONE OTP and expiry (for NEW email only)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await VerifyEmail.findOneAndUpdate(
      { email: nextEmail, role: 'Influencer' },
      {
        $setOnInsert: { email: nextEmail, role: 'Influencer' },
        $set: { otpCode: otp, otpExpiresAt: expiresAt, verified: false },
        $inc: { attempts: 1 }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    // ✉️ send OTP ONLY to new email
    const subject = 'Confirm email change';
    const html = otpHtmlTemplate({
      title: 'Verify your new email',
      subtitle: 'Use this code to confirm your new email address.',
      code: otp,
      minutes: 10,
      preheader: 'Confirm email change (new email)',
    });
    const text = otpTextFallback({ code: otp, minutes: 10, title: 'Verify your new email' });

    await sendMail({ to: nextEmail, subject, html, text });

    return res.status(200).json({ message: 'OTP sent to new email' });
  } catch (err) {
    console.error('Error in requestEmailUpdate:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.verifyotp = async (req, res) => {
  try {
    const { influencerId, role = 'Influencer', otp, newEmail } = req.body || {};
    if (!influencerId || !role || !otp || !newEmail) {
      return res.status(400).json({ message: 'influencerId, role, otp, and newEmail are required' });
    }
    if (String(role).trim() !== 'Influencer') {
      return res.status(400).json({ message: 'role must be "Influencer" for this endpoint' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    const oldEmail = String(inf.email || '').trim().toLowerCase();
    const nextEmail = String(newEmail || '').trim().toLowerCase();
    if (!nextEmail) {
      return res.status(400).json({ message: 'newEmail is required' });
    }
    if (nextEmail === oldEmail) {
      return res.status(400).json({ message: 'New email must be different from current email' });
    }

    // ensure new email not used by another influencer
    const emailRegexCI = new RegExp(`^${escapeRegExp(nextEmail)}$`, 'i');
    const exists = await Influencer.findOne({ email: emailRegexCI }, '_id influencerId');
    if (exists && String(exists.influencerId) !== String(influencerId)) {
      return res.status(409).json({ message: 'New email already in use' });
    }

    const now = new Date();

    // verify OTP for NEW email only
    const ve = await VerifyEmail.findOne({
      email: nextEmail,
      role: 'Influencer',
      otpCode: String(otp).trim(),
      otpExpiresAt: { $gt: now }
    });

    if (!ve) {
      return res.status(400).json({ message: 'Invalid or expired OTP for new email' });
    }

    // update influencer email
    inf.email = nextEmail;
    await inf.save();

    // mark new email as verified, clear code
    ve.verified = true;
    ve.otpCode = undefined;
    ve.otpExpiresAt = undefined;
    ve.verifiedAt = new Date();
    await ve.save();

    // optional: clean up old email VerifyEmail record
    await VerifyEmail.deleteOne({ email: oldEmail, role: 'Influencer' }).catch(() => { });

    return res.status(200).json({ message: 'Email updated successfully' });
  } catch (err) {
    console.error('Error in verifyotp:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getLiteById = async (req, res) => {
  try {
    const id = req.query.id || req.query.influencerId;
    if (!id) {
      return res.status(400).json({ message: 'Query parameter "id" (influencerId) is required.' });
    }

    const doc = await Influencer.findOne({ influencerId: id })
      .select('influencerId name email primaryPlatform subscription.planId subscription.planName subscription.expiresAt')
      .lean();

    if (!doc) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    // 🔹 Get social profiles from Modash
    const socialProfiles = await loadSocialProfilesFromModash(id);

    // Pick a primary profile (prefer influencer.primaryPlatform, else most followers)
    let primaryProfile = null;
    if (socialProfiles.length) {
      primaryProfile =
        socialProfiles.find(p => p.provider === doc.primaryPlatform) ||
        socialProfiles.slice().sort((a, b) => (b.followers || 0) - (a.followers || 0))[0];
    }

    return res.status(200).json({
      influencerId: doc.influencerId,
      name: doc.name || '',
      email: doc.email || '',
      planId: doc.subscription?.planId || null,
      planName: doc.subscription?.planName || null,
      expiresAt: doc.subscription?.expiresAt || null,

      // 🔹 NEW:
      primaryPlatform: doc.primaryPlatform || null,
      socialProfiles,
      primaryProfile,
      socialProfilesCount: socialProfiles.length
    });
  } catch (err) {
    console.error('Error in getLiteById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.requestClaimEmailOtp = async (req, res) => {
  try {
    const requester = req.influencer;
    const { externalEmail } = req.body || {};

    if (!requester || !requester.influencerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (!externalEmail) {
      return res.status(400).json({ message: 'externalEmail is required' });
    }

    const normalized = norm(externalEmail);
    if (!normalized) {
      return res.status(400).json({ message: 'Invalid externalEmail' });
    }

    const inf = await Influencer.findOne({ influencerId: requester.influencerId });
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    if (normalized === norm(inf.email)) {
      return res.status(400).json({ message: 'This email is already your login email' });
    }

    // Generate OTP for role "InfluencerAlias"
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await VerifyEmail.findOneAndUpdate(
      { email: normalized, role: 'InfluencerAlias' },
      {
        $setOnInsert: { email: normalized, role: 'InfluencerAlias' },
        $set: { otpCode: code, otpExpiresAt: expiresAt, verified: false },
        $inc: { attempts: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const subject = 'Verify this email to link your conversations';
    const html = otpHtmlTemplate({
      title: 'Verify your additional email',
      subtitle: 'Use this code to link your past CollabGlam conversations.',
      code,
      minutes: 10,
      preheader: 'Link your email to CollabGlam',
    });
    const text = otpTextFallback({
      code,
      minutes: 10,
      title: 'Verify your additional email',
    });

    await sendMail({ to: normalized, subject, html, text });

    return res.status(200).json({ message: 'OTP sent to external email' });
  } catch (err) {
    console.error('requestClaimEmailOtp error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.verifyClaimEmailOtp = async (req, res) => {
  try {
    const requester = req.influencer;
    const { externalEmail, otp } = req.body || {};

    if (!requester || !requester.influencerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (!externalEmail || !otp) {
      return res.status(400).json({ message: 'externalEmail and otp are required' });
    }

    const normalized = norm(externalEmail);
    const code = String(otp).trim();

    const inf = await Influencer.findOne({ influencerId: requester.influencerId });
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const ve = await VerifyEmail.findOne({
      email: normalized,
      role: 'InfluencerAlias',
      otpCode: code,
      otpExpiresAt: { $gt: new Date() },
    });

    if (!ve) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }

    // Mark verified & clear
    ve.verified = true;
    ve.verifiedAt = new Date();
    ve.otpCode = undefined;
    ve.otpExpiresAt = undefined;
    await ve.save();

    // Attach externalEmail -> influencer in EmailAlias
    await attachExternalEmailToInfluencer(inf, normalized);

    // Link all conversations that used that email
    await linkConversationsForInfluencer(inf, normalized);

    return res.status(200).json({
      message: 'Email linked successfully. Your past conversations are now attached.',
    });
  } catch (err) {
    console.error('verifyClaimEmailOtp error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getInfluencerOnboarding = async (req, res) => {
  try {
    const influencerId = req.influencer?.influencerId;
    if (!influencerId) return res.status(401).json({ message: 'Unauthorized' });

    const inf = await Influencer.findOne({ influencerId })
      .select('onboarding.influencerTourSeen onboarding.influencerTourSeenAt')
      .lean();

    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    const seen = Boolean(inf?.onboarding?.influencerTourSeen);

    return res.status(200).json({
      influencerTourSeen: seen,
      influencerTourSeenAt: inf?.onboarding?.influencerTourSeenAt ?? null,
    });
  } catch (err) {
    console.error('getInfluencerOnboarding error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.markInfluencerTourSeen = async (req, res) => {
  try {
    const influencerId = req.influencer?.influencerId;
    if (!influencerId) return res.status(401).json({ message: 'Unauthorized' });

    const now = new Date();

    const result = await Influencer.updateOne(
      { influencerId },
      {
        $set: {
          'onboarding.influencerTourSeen': true,
          'onboarding.influencerTourSeenAt': now,
        },
      }
    );

    // ✅ If token was valid but influencerId not found in DB
    if (!result?.matchedCount) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    return res.status(200).json({
      success: true,
      influencerTourSeen: true,
      influencerTourSeenAt: now,
    });
  } catch (err) {
    console.error('markInfluencerTourSeen error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};