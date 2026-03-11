"use strict";

const PDFDocument = require("pdfkit");
const moment = require("moment-timezone");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

// Models & template
const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const { InfluencerModel: Influencer } = require("../models/influencer");

const Contract = require("../models/contract");
const MASTER_TEMPLATE = require("../template/ContractTemplate");

const { createAndEmit } = require("../utils/notifier");
const { CONTRACT_STATUS } = require("../constants/contract");

// Optional email + reminders
let EmailSvc = {};
try {
  EmailSvc = require("../services/email/contractEmailService");
} catch (e) {
  console.warn("[Email] contractEmailService not found. Emails/reminders will be skipped.");
}
const {
  sendContractEmail,
  startReminder,
  clearReminder,
  resetReminderOnEngagement,
} = EmailSvc;

// ============================ Constants ============================
const DEFAULT_TZ = "America/Los_Angeles";
const TIMEZONES_FILE = path.join(__dirname, "..", "data", "timezones.json");
const CURRENCIES_FILE = path.join(__dirname, "..", "data", "currencies.json");
const CONTRACT_PDF_TITLE = "COLLABGLAM BRAND–INFLUENCER CAMPAIGN COLLABORATION AGREEMENT";
const MAX_SIG_BYTES = 50 * 1024;

const ALLOWED_BRAND_PATHS = [
  "content.brand.legalName",
  "content.brand.contactPersonName",
  "content.brand.noticeEmail",
  "content.brand.noticePhone",
  "content.brand.billingAddress",

  "content.campaign.productsServicesCovered",
  "content.campaign.territoryTargetCountry",
  "content.campaign.effectiveDate",
  "content.campaign.campaignTitleOrId",

  "content.scheduleA.deliverables",
  "content.scheduleA.minimumVideoSpecs",
  "content.scheduleA.preShootScriptRequired",
  "content.scheduleA.preShootScriptDue",
  "content.scheduleA.preShootScriptReviewBusinessDays",
  "content.scheduleA.mandatoryTagsMentionsLinksCodes",

  "content.scheduleA.review.includedRevisionRounds",
  "content.scheduleA.review.additionalRevisionFee",
  "content.scheduleA.review.reshootObligation",
  "content.scheduleA.review.reshootFee",
  "content.scheduleA.review.minimumLivePeriod",

  "content.scheduleA.commercial.totalCampaignFee",
  "content.scheduleA.commercial.currency",
  "content.scheduleA.commercial.platformMilestonePaymentStructure",
  "content.scheduleA.commercial.customSplit",
  "content.scheduleA.commercial.advancePaymentTrigger",
  "content.scheduleA.commercial.remainingPaymentTrigger",
  "content.scheduleA.commercial.paymentProcessorFeesBorneBy",
  "content.scheduleA.commercial.paymentProcessorFeesNotes",
  "content.scheduleA.commercial.laneAMarketplaceFeeNote",

  "content.scheduleA.rawFiles.rawSourceFileDelivery",
  "content.scheduleA.rawFiles.deliveryDue",
  "content.scheduleA.rawFiles.format",
  "content.scheduleA.rawFiles.analyticsReportingDeadline",
  "content.scheduleA.rawFiles.analyticsReportingItems",

  "content.scheduleA.shipping.productShippingApplicable",
  "content.scheduleA.shipping.shipToName",
  "content.scheduleA.shipping.shipToAddress",
  "content.scheduleA.shipping.shipToPhone",
  "content.scheduleA.shipping.productReceiptConfirmationDeadline",
  "content.scheduleA.shipping.productReturnable",
  "content.scheduleA.shipping.returnWindowMethod",
  "content.scheduleA.shipping.riskOfLossNotes",

  "content.scheduleA.usageRights.rows",
  "content.scheduleA.usageRights.attributionRequirement",
  "content.scheduleA.usageRights.attributionText",
  "content.scheduleA.usageRights.editingRights",
  "content.scheduleA.usageRights.musicStockAssetResponsibility",

  "content.scheduleA.compliance.creativeBriefMandatoryTalkingPoints",
  "content.scheduleA.compliance.restrictedStatements",

  "content.scheduleA.exclusivity.competitorBlackout",
  "content.scheduleA.exclusivity.categoryCompetitorList",
  "content.scheduleA.exclusivity.blackoutPeriod",
  "content.scheduleA.exclusivity.optionalMoralsClause",

  "content.scheduleA.cancellation.killFeeOrProrata",
  "content.scheduleA.cancellation.refundOfUnearnedAdvance",

  "content.scheduleA.dispute.governingLaw",
  "content.scheduleA.dispute.disputeResolutionMethod",
  "content.scheduleA.dispute.disputeVenue",
  "content.scheduleA.dispute.arbitrationSeat",
  "content.scheduleA.dispute.attorneysFees",

  "content.collabglam.signatoryName",
];

const ALLOWED_INFLUENCER_PATHS = [
  "content.influencer.legalName",
  "content.influencer.contactName",
  "content.influencer.postingHandleUrl",
  "content.influencer.contactEmail",
  "content.influencer.contactPhone",
  "content.influencer.whatsApp",
  "content.influencer.address",
];

// --- Fixed CollabGlam signature for display ---
const COLLABGLAM_SIG_FILE = path.join(__dirname, "..", "assets", "collabglam-signature.png");
let COLLABGLAM_FIXED_SIG_DATA_URL = process.env.COLLABGLAM_FIXED_SIG_DATA_URL || null;

(function loadCollabGlamSig() {
  if (COLLABGLAM_FIXED_SIG_DATA_URL) return;
  try {
    if (fs.existsSync(COLLABGLAM_SIG_FILE)) {
      const buf = fs.readFileSync(COLLABGLAM_SIG_FILE);
      COLLABGLAM_FIXED_SIG_DATA_URL = `data:image/png;base64,${buf.toString("base64")}`;
      console.log("[Contract] Loaded fixed CollabGlam signature:", COLLABGLAM_SIG_FILE);
    }
  } catch (e) {
    console.warn("[Contract] Failed to load CollabGlam signature file:", e?.message || e);
  }
})();

// ============================ Response Helpers ============================
function respondOK(res, payload = {}, status = 200) {
  return res.status(status).json({ success: true, ...payload });
}

function respondError(res, message = "Internal server error", status = 500, err = null) {
  if (err) console.error(message, err);
  else console.error(message);
  return res.status(status).json({ success: false, message });
}

function assertRequired(obj, fields) {
  const missing = (fields || []).filter(
    (f) => obj?.[f] === undefined || obj?.[f] === null || obj?.[f] === ""
  );
  if (missing.length) {
    const e = new Error(`Missing required field(s): ${missing.join(", ")}`);
    e.status = 400;
    throw e;
  }
}

// ============================ JSON file caches ============================
let _tzCache = null;
let _curCache = null;

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.warn(`[Contract] Failed reading JSON: ${filePath}`, e?.message || e);
    return fallback;
  }
}

function loadTimezones() {
  if (_tzCache) return _tzCache;
  _tzCache = safeReadJson(TIMEZONES_FILE, []);
  return _tzCache;
}

function loadCurrencies() {
  if (_curCache) return _curCache;
  _curCache = safeReadJson(CURRENCIES_FILE, {});
  return _curCache;
}

function findTimezoneByValueOrUTC(key) {
  if (!key) return null;
  const list = loadTimezones();
  const q = String(key).toLowerCase();
  return (
    list.find(
      (t) =>
        (t.value && t.value.toLowerCase() === q) ||
        (t.abbr && t.abbr.toLowerCase() === q) ||
        (Array.isArray(t.utc) && t.utc.some((u) => (u || "").toLowerCase() === q)) ||
        (t.text && t.text.toLowerCase().includes(q))
    ) || null
  );
}

// ============================ Time / Locale ============================
const tzOr = (contract, fallback = DEFAULT_TZ) =>
  contract?.requestedEffectiveDateTimezone ||
  contract?.effectiveDateTimezone ||
  contract?.admin?.timezone ||
  fallback;

function nowInContractTz(contract) {
  return moment.tz(tzOr(contract)).toDate();
}

function buildRequestedEffectiveDate(rawDate, tz) {
  if (!rawDate) return undefined;

  const zone = tz || DEFAULT_TZ;
  const dateStr = String(rawDate).split("T")[0];
  const parts = dateStr.split("-");
  if (parts.length !== 3) return new Date(rawDate);

  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (!year || !month || !day) return new Date(rawDate);

  const nowInZone = moment.tz(zone);
  nowInZone.year(year).month(month - 1).date(day);
  return nowInZone.toDate();
}

function formatDateTZ(date, tz, fmt = "MMMM D, YYYY") {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);

  const isDateOnlyUTC =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;

  if (isDateOnlyUTC) return moment.utc(d).format(fmt);
  return tz ? moment(d).tz(tz).format(fmt) : moment(d).format(fmt);
}

function compactJoin(parts, sep = ", ") {
  return (parts || [])
    .filter(Boolean)
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(sep);
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================ Deep update helpers ============================
function getDeep(obj, pathStr) {
  return String(pathStr)
    .split(".")
    .reduce((acc, key) => acc?.[key], obj);
}

function setDeep(obj, pathStr, value) {
  const keys = String(pathStr).split(".");
  let ref = obj;
  while (keys.length > 1) {
    const k = keys.shift();
    if (!ref[k] || typeof ref[k] !== "object") ref[k] = {};
    ref = ref[k];
  }
  ref[keys[0]] = value;
}

function applyAllowedDeepUpdates(target, updates, allowedPaths = []) {
  const changed = [];
  for (const p of allowedPaths) {
    const incoming = getDeep(updates, p);
    if (incoming === undefined) continue;

    const before = getDeep(target, p);
    if (JSON.stringify(before) !== JSON.stringify(incoming)) {
      setDeep(target, p, incoming);
      changed.push(p);
    }
  }
  return changed;
}

function mergeDeep(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(patch)) return patch.map((x) => mergeDeep(undefined, x));
  if (!patch || typeof patch !== "object") return patch;
  if (!base || typeof base !== "object" || Array.isArray(base)) base = {};

  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = mergeDeep(out[k], v);
  }
  return out;
}

function toPlainSafe(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;

  if (typeof value !== "object") return value;

  if (typeof value?.toObject === "function") {
    value = value.toObject({ depopulate: true, flattenMaps: true });
  }

  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value.entries()) {
      out[k] = toPlainSafe(v, seen);
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((v) => toPlainSafe(v, seen));
  }

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = toPlainSafe(v, seen);
  }
  return out;
}

function flatten(obj, prefix = "") {
  const safe = toPlainSafe(obj);
  const out = {};

  function walk(value, path) {
    if (value instanceof Date || value === null || value === undefined) {
      out[path] = value;
      return;
    }

    if (Array.isArray(value)) {
      out[path] = value;
      return;
    }

    if (typeof value !== "object") {
      out[path] = value;
      return;
    }

    const entries = Object.entries(value);
    if (!entries.length) {
      out[path] = value;
      return;
    }

    for (const [k, v] of entries) {
      const nextPath = path ? `${path}.${k}` : k;
      walk(v, nextPath);
    }
  }

  walk(safe, prefix);
  return out;
}

function computeEditedFields(prevObj, nextObj, whitelistTopKeys) {
  const prev = flatten(prevObj || {});
  const next = flatten(nextObj || {});
  const fields = new Set();

  const allKeys = Object.keys({ ...prev, ...next });
  for (const key of allKeys) {
    const topKey = key.split(".")[0];
    if (whitelistTopKeys && !whitelistTopKeys.includes(topKey)) continue;

    const a = prev[key];
    const b = next[key];

    const aVal = a instanceof Date ? a.toISOString() : JSON.stringify(a);
    const bVal = b instanceof Date ? b.toISOString() : JSON.stringify(b);

    if (aVal !== bVal) fields.add(key);
  }

  return Array.from(fields).sort();
}

// ============================ Schedule A Render Helpers ============================
function renderKeyValueTable(rows = []) {
  const safeRows = rows
    .filter(([label]) => label)
    .map(
      ([label, value]) =>
        `<tr><td style="width:35%;"><strong>${esc(label)}</strong></td><td>${esc(
          value === undefined || value === null ? "" : String(value)
        )}</td></tr>`
    )
    .join("");

  return `
    <table border="0" cellpadding="6" cellspacing="0" style="width:100%; border-collapse:collapse;">
      ${safeRows}
    </table>
  `.trim();
}

function renderAgreementHeaderTableHTML(content = {}, tz = DEFAULT_TZ) {
  return renderKeyValueTable([
    ["Brand Legal Name", content?.brand?.legalName || ""],
    ["Brand Contact Person Name", content?.brand?.contactPersonName || ""],
    ["Brand Notice Email / Phone", compactJoin([content?.brand?.noticeEmail, content?.brand?.noticePhone], " / ")],
    ["Brand Billing Address", content?.brand?.billingAddress || ""],
    ["Influencer Legal Name / Entity", content?.influencer?.legalName || ""],
    ["Influencer Posting Handle URL", content?.influencer?.postingHandleUrl || ""],
    ["Influencer Contact Email / Phone", compactJoin([content?.influencer?.contactEmail, content?.influencer?.contactPhone, content?.influencer?.whatsApp], " / ")],
    ["Influencer Address", content?.influencer?.address || ""],
    ["Products / Services Covered", content?.campaign?.productsServicesCovered || ""],
    ["Territory / Target Country", content?.campaign?.territoryTargetCountry || ""],
    ["Effective Date", content?.campaign?.effectiveDate ? formatDateTZ(content.campaign.effectiveDate, tz) : ""],
    [
      "CollabGlam LLC",
      compactJoin(
        [
          content?.collabglam?.legalName || "CollabGlam LLC",
          content?.collabglam?.address || "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",
          content?.collabglam?.email ? `Email: ${content.collabglam.email}` : "Email: help@collabglam.com",
        ],
        " | "
      ),
    ],
    ["Campaign Title / Campaign ID", content?.campaign?.campaignTitleOrId || ""],
  ]);
}

function renderDeliverablesScheduleTable(rows = []) {
  const body = (Array.isArray(rows) ? rows : [])
    .map(
      (r, i) => `
      <tr>
        <td>${esc(String(r?.srNo ?? i + 1))}</td>
        <td>${esc(r?.platformHandle || "")}</td>
        <td>${esc(r?.deliverableFormat || "")}</td>
        <td>${esc(String(r?.qty ?? ""))}</td>
        <td>${esc(r?.draftDue || "")}</td>
        <td>${esc(r?.liveDate || "")}</td>
      </tr>
    `
    )
    .join("");

  return `
    <table>
      <thead>
        <tr>
          <th>Sr. No.</th>
          <th>Platform / Handle</th>
          <th>Deliverable Format</th>
          <th>Qty</th>
          <th>Draft Due</th>
          <th>Live Date</th>
        </tr>
      </thead>
      <tbody>
        ${body || `<tr><td colspan="6">No deliverables defined.</td></tr>`}
      </tbody>
    </table>
  `.trim();
}

function renderUsageRightsTable(rows = []) {
  const body = (Array.isArray(rows) ? rows : [])
    .map(
      (r) => `
      <tr>
        <td>${esc(r?.usageRight || "")}</td>
        <td>${r?.selected ? "☑" : "☐"}</td>
        <td>${esc(r?.duration || "")}</td>
        <td>${esc(r?.territoryNotes || "")}</td>
      </tr>
    `
    )
    .join("");

  return `
    <table>
      <thead>
        <tr>
          <th>Usage Right</th>
          <th>Selected</th>
          <th>Duration</th>
          <th>Territory / Notes</th>
        </tr>
      </thead>
      <tbody>
        ${body}
      </tbody>
    </table>
  `.trim();
}

const PAYMENT_TYPES = Object.freeze({
  MILESTONE: "Milestone",
  FIXED: "Fixed",
  GIFTING: "Gifting",
});

function getCampaignPaymentType(campaign) {
  const raw = String(campaign?.paymentType || "").trim().toLowerCase();

  if (raw === "milestone") return PAYMENT_TYPES.MILESTONE;
  if (raw === "fixed") return PAYMENT_TYPES.FIXED;
  if (raw === "gifting") return PAYMENT_TYPES.GIFTING;

  return PAYMENT_TYPES.MILESTONE;
}

function getCampaignFee(campaign, paymentType) {
  if (paymentType === PAYMENT_TYPES.GIFTING) return 0;

  return Number(
    campaign?.influencerBudget ||
    campaign?.campaignBudget ||
    campaign?.budget ||
    0
  );
}

function buildDefaultDeliverables(campaign, inputDeliverables) {
  if (Array.isArray(inputDeliverables) && inputDeliverables.length) {
    return inputDeliverables;
  }

  return [
    {
      srNo: 1,
      platformHandle: Array.isArray(campaign?.platformSelection)
        ? campaign.platformSelection.join(", ")
        : "",
      deliverableFormat: "",
      qty: 1,
      draftDue: "",
      liveDate: "",
    },
  ];
}

function getMandatoryTags(campaign) {
  if (Array.isArray(campaign?.hashtags) && campaign.hashtags.length) {
    return campaign.hashtags.join(", ");
  }
  return "";
}

// ============================ Content defaults ============================
function createDefaultContent({
  campaign,
  brandDoc,
  influencerDoc,
  admin,
  requestedEffectiveDate,
  requestedEffectiveDateTimezone,
  contentInput = {},
}) {
  const effectiveDate =
    requestedEffectiveDate
      ? buildRequestedEffectiveDate(
        requestedEffectiveDate,
        requestedEffectiveDateTimezone || admin?.timezone || DEFAULT_TZ
      )
      : undefined;

  const paymentType = getCampaignPaymentType(campaign);
  const totalCampaignFee =
    contentInput?.scheduleA?.commercial?.totalCampaignFee ??
    getCampaignFee(campaign, paymentType);

  const defaultPaymentStructure =
    paymentType === PAYMENT_TYPES.MILESTONE
      ? "50% advance / 50% balance"
      : paymentType === PAYMENT_TYPES.FIXED
        ? "100% on completion"
        : "Product gifting only";

  const base = {
    brand: {
      legalName: brandDoc?.legalName || brandDoc?.name || "",
      contactPersonName: brandDoc?.contactName || brandDoc?.ownerName || "",
      noticeEmail: brandDoc?.email || "",
      noticePhone: brandDoc?.phone || "",
      billingAddress: brandDoc?.address || "",
    },

    influencer: {
      legalName: influencerDoc?.legalName || influencerDoc?.name || "",
      contactName: influencerDoc?.contactName || influencerDoc?.name || "",
      postingHandleUrl: influencerDoc?.handle || influencerDoc?.profileUrl || "",
      contactEmail: influencerDoc?.email || "",
      contactPhone: influencerDoc?.phone || "",
      whatsApp: influencerDoc?.whatsapp || "",
      address: influencerDoc?.address || "",
    },

    collabglam: {
      legalName: "CollabGlam LLC",
      address: "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",
      email: "help@collabglam.com",
      signatoryName: admin?.collabglamSignatoryName || "",
    },

    campaign: {
      productsServicesCovered:
        contentInput?.campaign?.productsServicesCovered || campaign?.productOrServiceName || "",
      territoryTargetCountry:
        contentInput?.campaign?.territoryTargetCountry || "Worldwide",
      effectiveDate: effectiveDate || contentInput?.campaign?.effectiveDate || null,
      campaignTitleOrId:
        contentInput?.campaign?.campaignTitleOrId ||
        campaign?.campaignTitle ||
        campaign?.productOrServiceName ||
        String(campaign?._id || ""),
      paymentType,
    },

    scheduleA: {
      deliverables: buildDefaultDeliverables(
        campaign,
        contentInput?.scheduleA?.deliverables
      ),

      minimumVideoSpecs: contentInput?.scheduleA?.minimumVideoSpecs || "",
      preShootScriptRequired: Boolean(contentInput?.scheduleA?.preShootScriptRequired),
      preShootScriptDue: contentInput?.scheduleA?.preShootScriptDue || "",
      preShootScriptReviewBusinessDays:
        contentInput?.scheduleA?.preShootScriptReviewBusinessDays || 2,
      mandatoryTagsMentionsLinksCodes:
        contentInput?.scheduleA?.mandatoryTagsMentionsLinksCodes || getMandatoryTags(campaign),

      review: {
        includedRevisionRounds:
          contentInput?.scheduleA?.review?.includedRevisionRounds ?? 1,
        additionalRevisionFee:
          contentInput?.scheduleA?.review?.additionalRevisionFee || "",
        reshootObligation:
          contentInput?.scheduleA?.review?.reshootObligation ||
          "No reshoot required except for material failure to follow approved brief",
        reshootFee: contentInput?.scheduleA?.review?.reshootFee || "",
        minimumLivePeriod:
          contentInput?.scheduleA?.review?.minimumLivePeriod || "",
      },

      commercial: {
        totalCampaignFee: Number(totalCampaignFee || 0),
        currency: contentInput?.scheduleA?.commercial?.currency || "USD",
        platformMilestonePaymentStructure:
          contentInput?.scheduleA?.commercial?.platformMilestonePaymentStructure ||
          defaultPaymentStructure,
        customSplit:
          contentInput?.scheduleA?.commercial?.customSplit || "",
        advancePaymentTrigger:
          contentInput?.scheduleA?.commercial?.advancePaymentTrigger || "",
        remainingPaymentTrigger:
          contentInput?.scheduleA?.commercial?.remainingPaymentTrigger || "",
        paymentProcessorFeesBorneBy:
          contentInput?.scheduleA?.commercial?.paymentProcessorFeesBorneBy || "",
        paymentProcessorFeesNotes:
          contentInput?.scheduleA?.commercial?.paymentProcessorFeesNotes || "",
        laneAMarketplaceFeeNote:
          contentInput?.scheduleA?.commercial?.laneAMarketplaceFeeNote ||
          "Unless expressly stated otherwise, 10% of the applicable Influencer compensation funded through the Platform is deducted from the Influencer payout and retained by CollabGlam; the Brand-funded campaign amount remains fixed.",
      },

      rawFiles: {
        rawSourceFileDelivery:
          contentInput?.scheduleA?.rawFiles?.rawSourceFileDelivery || "Not included",
        deliveryDue: contentInput?.scheduleA?.rawFiles?.deliveryDue || "",
        format: contentInput?.scheduleA?.rawFiles?.format || "",
        analyticsReportingDeadline:
          contentInput?.scheduleA?.rawFiles?.analyticsReportingDeadline || "",
        analyticsReportingItems:
          contentInput?.scheduleA?.rawFiles?.analyticsReportingItems || "",
      },

      shipping: {
        productShippingApplicable:
          contentInput?.scheduleA?.shipping?.productShippingApplicable ||
          (paymentType === PAYMENT_TYPES.GIFTING ? "Yes" : "No"),
        shipToName: contentInput?.scheduleA?.shipping?.shipToName || "",
        shipToAddress: contentInput?.scheduleA?.shipping?.shipToAddress || "",
        shipToPhone: contentInput?.scheduleA?.shipping?.shipToPhone || "",
        productReceiptConfirmationDeadline:
          contentInput?.scheduleA?.shipping?.productReceiptConfirmationDeadline || "",
        productReturnable:
          contentInput?.scheduleA?.shipping?.productReturnable ||
          (paymentType === PAYMENT_TYPES.GIFTING ? "Gift / keep product" : ""),
        returnWindowMethod:
          contentInput?.scheduleA?.shipping?.returnWindowMethod || "",
        riskOfLossNotes:
          contentInput?.scheduleA?.shipping?.riskOfLossNotes || "",
      },

      usageRights: {
        rows: Array.isArray(contentInput?.scheduleA?.usageRights?.rows)
          ? contentInput.scheduleA.usageRights.rows
          : [
            { usageRight: "Organic repost on Brand-owned social channels", selected: false, duration: "", territoryNotes: "" },
            { usageRight: "Brand website / blog / PDP / retailer listing", selected: false, duration: "", territoryNotes: "" },
            { usageRight: "Email / CRM / deck / internal presentation use", selected: false, duration: "", territoryNotes: "" },
            { usageRight: "Paid social / boosting / ads", selected: false, duration: "", territoryNotes: "" },
            { usageRight: "Whitelisting / Spark Ads / dark posting / creator handle", selected: false, duration: "", territoryNotes: "" },
            { usageRight: "Perpetual rights / buyout / work-made-for-hire", selected: false, duration: "", territoryNotes: "" },
          ],
        attributionRequirement:
          contentInput?.scheduleA?.usageRights?.attributionRequirement ||
          "No attribution required",
        attributionText:
          contentInput?.scheduleA?.usageRights?.attributionText || "",
        editingRights:
          contentInput?.scheduleA?.usageRights?.editingRights || "Cropping / resizing only",
        musicStockAssetResponsibility:
          contentInput?.scheduleA?.usageRights?.musicStockAssetResponsibility ||
          "Brand responsible for separate commercial licensing",
      },

      compliance: {
        creativeBriefMandatoryTalkingPoints:
          contentInput?.scheduleA?.compliance?.creativeBriefMandatoryTalkingPoints || "",
        restrictedStatements:
          contentInput?.scheduleA?.compliance?.restrictedStatements || "",
      },

      exclusivity: {
        competitorBlackout:
          contentInput?.scheduleA?.exclusivity?.competitorBlackout || "None",
        categoryCompetitorList:
          contentInput?.scheduleA?.exclusivity?.categoryCompetitorList || "",
        blackoutPeriod:
          contentInput?.scheduleA?.exclusivity?.blackoutPeriod || "",
        optionalMoralsClause:
          contentInput?.scheduleA?.exclusivity?.optionalMoralsClause || "Not included",
      },

      cancellation: {
        killFeeOrProrata:
          contentInput?.scheduleA?.cancellation?.killFeeOrProrata || "None",
        refundOfUnearnedAdvance:
          contentInput?.scheduleA?.cancellation?.refundOfUnearnedAdvance ||
          "Yes — on material non-performance / uncured breach",
      },

      dispute: {
        governingLaw:
          contentInput?.scheduleA?.dispute?.governingLaw || "Nevada, USA",
        disputeResolutionMethod:
          contentInput?.scheduleA?.dispute?.disputeResolutionMethod || "AAA arbitration",
        disputeVenue:
          contentInput?.scheduleA?.dispute?.disputeVenue || "",
        arbitrationSeat:
          contentInput?.scheduleA?.dispute?.arbitrationSeat || "Las Vegas, Nevada, USA",
        attorneysFees:
          contentInput?.scheduleA?.dispute?.attorneysFees || "Each Party bears own fees",
      },
    },
  };

  const merged = mergeDeep(base, contentInput || {});

  // IMPORTANT: paymentType must always come from Campaign only
  merged.campaign = merged.campaign || {};
  merged.campaign.paymentType = paymentType;

  if (paymentType === PAYMENT_TYPES.GIFTING) {
    merged.scheduleA = merged.scheduleA || {};
    merged.scheduleA.commercial = merged.scheduleA.commercial || {};
    if (
      contentInput?.scheduleA?.commercial?.totalCampaignFee === undefined ||
      contentInput?.scheduleA?.commercial?.totalCampaignFee === null ||
      contentInput?.scheduleA?.commercial?.totalCampaignFee === ""
    ) {
      merged.scheduleA.commercial.totalCampaignFee = 0;
    }
  }

  return merged;
}
// ============================ Token map / Template rendering ============================
function buildTokenMap(contract) {
  const tz = tzOr(contract);
  const c = contract.content || {};

  const review = c?.scheduleA?.review || {};
  const commercial = c?.scheduleA?.commercial || {};
  const rawFiles = c?.scheduleA?.rawFiles || {};
  const shipping = c?.scheduleA?.shipping || {};
  const usageRights = c?.scheduleA?.usageRights || {};
  const compliance = c?.scheduleA?.compliance || {};
  const exclusivity = c?.scheduleA?.exclusivity || {};
  const cancellation = c?.scheduleA?.cancellation || {};
  const dispute = c?.scheduleA?.dispute || {};

  const effectiveDate =
    c?.campaign?.effectiveDate ||
    contract.requestedEffectiveDate ||
    contract.effectiveDate ||
    null;

  const preShootText = c?.scheduleA?.preShootScriptRequired
    ? `Yes — due by ${c?.scheduleA?.preShootScriptDue || "N/A"} and subject to review within ${c?.scheduleA?.preShootScriptReviewBusinessDays || 2
    } business days`
    : "No";

  return {
    "Agreement.EffectiveDate": effectiveDate ? formatDateTZ(effectiveDate, tz) : "",
    "Agreement.EffectiveDateLong": effectiveDate
      ? formatDateTZ(effectiveDate, tz, "Do MMMM YYYY")
      : "",
    "Agreement.EffectiveDateTime": effectiveDate
      ? formatDateTZ(effectiveDate, tz, "MMMM D, YYYY HH:mm z")
      : "",

    "Agreement.HeaderTableHTML": renderAgreementHeaderTableHTML(c, tz),

    "Brand.LegalName": c?.brand?.legalName || contract.brandName || "",
    "Brand.ContactPersonName": c?.brand?.contactPersonName || "",
    "Brand.NoticeEmail": c?.brand?.noticeEmail || "",
    "Brand.NoticePhone": c?.brand?.noticePhone || "",
    "Brand.BillingAddress": c?.brand?.billingAddress || "",
    "Brand.Address": c?.brand?.billingAddress || "",

    "Influencer.LegalName": c?.influencer?.legalName || contract.influencerName || "",
    "Influencer.ContactName": c?.influencer?.contactName || c?.influencer?.legalName || "",
    "Influencer.PostingHandleUrl": c?.influencer?.postingHandleUrl || "",
    "Influencer.ContactEmail": c?.influencer?.contactEmail || "",
    "Influencer.ContactPhone": c?.influencer?.contactPhone || "",
    "Influencer.Address": c?.influencer?.address || contract.influencerAddress || "",

    "CollabGlam.SignatoryName":
      c?.collabglam?.signatoryName || contract.admin?.collabglamSignatoryName || "",
    "CollabGlam.Address":
      c?.collabglam?.address ||
      "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",

    "Campaign.Title": c?.campaign?.campaignTitleOrId || "",
    "Campaign.ProductsServicesCovered": c?.campaign?.productsServicesCovered || "",
    "Campaign.Territory": c?.campaign?.territoryTargetCountry || "Worldwide",

    "SOW.MinimumVideoSpecs": c?.scheduleA?.minimumVideoSpecs || "",
    "SOW.PreShootScriptRequiredText": preShootText,
    "SOW.MandatoryTagsMentionsLinksCodes":
      c?.scheduleA?.mandatoryTagsMentionsLinksCodes || "",

    "SOW.CreativeBriefMandatoryTalkingPoints":
      compliance?.creativeBriefMandatoryTalkingPoints || "",
    "SOW.RestrictedStatements":
      compliance?.restrictedStatements || "",

    "SOW.DeliverablesTableHTML":
      renderDeliverablesScheduleTable(c?.scheduleA?.deliverables || []),

    "SOW.ReviewTermsTableHTML": renderKeyValueTable([
      ["Included Revision Rounds", review?.includedRevisionRounds ?? 1],
      ["Additional Revision Fee", review?.additionalRevisionFee || ""],
      ["Reshoot Obligation", review?.reshootObligation || ""],
      ["Reshoot Fee", review?.reshootFee || ""],
      ["Minimum Live Period", review?.minimumLivePeriod || ""],
    ]),

    "SOW.CommercialTermsTableHTML": renderKeyValueTable([
      [
        "Total Campaign Fee",
        compactJoin([commercial?.totalCampaignFee, commercial?.currency], " "),
      ],
      [
        "Platform Milestone Payment Structure",
        commercial?.platformMilestonePaymentStructure || "",
      ],
      ["Custom Split", commercial?.customSplit || ""],
      ["Advance Payment Trigger", commercial?.advancePaymentTrigger || ""],
      ["Remaining Payment Trigger", commercial?.remainingPaymentTrigger || ""],
      [
        "Payment Processor Fees Borne By",
        commercial?.paymentProcessorFeesBorneBy || "",
      ],
      ["Payment Processor Fee Notes", commercial?.paymentProcessorFeesNotes || ""],
      ["Lane A Marketplace Fee", commercial?.laneAMarketplaceFeeNote || ""],
    ]),

    "SOW.RawFilesReportingTableHTML": renderKeyValueTable([
      ["Raw / Source File Delivery", rawFiles?.rawSourceFileDelivery || ""],
      ["Files Due", rawFiles?.deliveryDue || ""],
      ["Format", rawFiles?.format || ""],
      [
        "Analytics / Reporting Deadline",
        rawFiles?.analyticsReportingDeadline || "",
      ],
      ["Analytics Reporting Items", rawFiles?.analyticsReportingItems || ""],
    ]),

    "SOW.ProductShippingTableHTML": renderKeyValueTable([
      ["Product Shipping Applicable", shipping?.productShippingApplicable || ""],
      ["Ship-To Name", shipping?.shipToName || ""],
      ["Ship-To Address", shipping?.shipToAddress || ""],
      ["Ship-To Phone", shipping?.shipToPhone || ""],
      [
        "Product Receipt Confirmation Deadline",
        shipping?.productReceiptConfirmationDeadline || "",
      ],
      ["Product Returnable", shipping?.productReturnable || ""],
      ["Return Window / Method", shipping?.returnWindowMethod || ""],
      ["Risk of Loss Notes", shipping?.riskOfLossNotes || ""],
    ]),

    "SOW.UsageRightsTableHTML": `
      ${renderUsageRightsTable(usageRights?.rows || [])}
      ${renderKeyValueTable([
      ["Attribution Requirement", usageRights?.attributionRequirement || ""],
      ["Attribution Text", usageRights?.attributionText || ""],
      ["Editing Rights", usageRights?.editingRights || ""],
      [
        "Music / Stock Asset Responsibility",
        usageRights?.musicStockAssetResponsibility || "",
      ],
    ])}
    `,

    "SOW.ExclusivityTableHTML": renderKeyValueTable([
      [
        "Exclusivity / Competitor Blackout",
        exclusivity?.competitorBlackout || "None",
      ],
      ["Category / Competitor List", exclusivity?.categoryCompetitorList || ""],
      ["Exclusivity / Blackout Period", exclusivity?.blackoutPeriod || ""],
      [
        "Optional Morals / Reputation Clause",
        exclusivity?.optionalMoralsClause || "Not included",
      ],
    ]),

    "SOW.CancellationTableHTML": renderKeyValueTable([
      [
        "Kill Fee / Pro-Rata if Brand Cancels Without Cause",
        cancellation?.killFeeOrProrata || "",
      ],
      [
        "Refund of Unearned Advance if Influencer Fails to Perform",
        cancellation?.refundOfUnearnedAdvance || "",
      ],
    ]),

    "SOW.DisputeTableHTML": renderKeyValueTable([
      ["Governing Law", dispute?.governingLaw || ""],
      ["Dispute Resolution Method", dispute?.disputeResolutionMethod || ""],
      ["Venue", dispute?.disputeVenue || ""],
      ["Arbitration Seat", dispute?.arbitrationSeat || ""],
      ["Attorneys’ Fees", dispute?.attorneysFees || ""],
    ]),
  };
}

function renderTemplate(templateText, tokenMap) {
  return (templateText || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, rawKey) => {
    const key = rawKey.replace(/\s*\(.*?\)\s*$/, "");
    const v = tokenMap[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function injectTrustedHtmlPlaceholders(legalHTML, contract) {
  const tokens = buildTokenMap(contract);
  const swaps = [
    { key: "[[Agreement.HeaderTableHTML]]", html: tokens["Agreement.HeaderTableHTML"] || "" },
    { key: "[[SOW.DeliverablesTableHTML]]", html: tokens["SOW.DeliverablesTableHTML"] || "" },
    { key: "[[SOW.ReviewTermsTableHTML]]", html: tokens["SOW.ReviewTermsTableHTML"] || "" },
    { key: "[[SOW.CommercialTermsTableHTML]]", html: tokens["SOW.CommercialTermsTableHTML"] || "" },
    { key: "[[SOW.RawFilesReportingTableHTML]]", html: tokens["SOW.RawFilesReportingTableHTML"] || "" },
    { key: "[[SOW.ProductShippingTableHTML]]", html: tokens["SOW.ProductShippingTableHTML"] || "" },
    { key: "[[SOW.UsageRightsTableHTML]]", html: tokens["SOW.UsageRightsTableHTML"] || "" },
    { key: "[[SOW.ExclusivityTableHTML]]", html: tokens["SOW.ExclusivityTableHTML"] || "" },
    { key: "[[SOW.CancellationTableHTML]]", html: tokens["SOW.CancellationTableHTML"] || "" },
    { key: "[[SOW.DisputeTableHTML]]", html: tokens["SOW.DisputeTableHTML"] || "" },
  ];

  let out = legalHTML;
  for (const { key, html } of swaps) {
    if (!html) continue;
    out = out.replaceAll(key, html);

    const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wrapped = new RegExp(`<p>\\s*${escKey}\\s*<\\/p>`, "g");
    out = out.replace(wrapped, html);
  }

  return out;
}

// ============================ HTML / PDF render ============================
function legalTextToHTML(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = [];
  let buffer = [];

  const flushP = () => {
    if (!buffer.length) return;
    const html = esc(buffer.join("\n")).replace(/\n/g, "<br>");
    out.push(`<p>${html}</p>`);
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushP();
      continue;
    }

    if (/Agreement/i.test(line) && line.length > 30 && !out.length) {
      flushP();
      out.push(`<h1>${esc(line)}</h1>`);
      continue;
    }

    if (/^PART\s+\d+\s+—/i.test(line)) {
      flushP();
      out.push(`<h2>${esc(line)}</h2>`);
      continue;
    }

    if (/^Signatures$/i.test(line)) {
      flushP();
      out.push("<h2>Signatures</h2>");
      out.push('<div id="__SIG_PANEL__"></div>');
      continue;
    }

    const numeric = line.match(/^(\d+)\.\s+(.+)$/);
    if (numeric) {
      flushP();
      out.push(`<h3><span class="secno">${esc(numeric[1])}.</span> ${esc(numeric[2])}</h3>`);
      continue;
    }

    const alpha = line.match(/^([A-Z])\.\s+(.+)$/);
    if (alpha) {
      flushP();
      out.push(`<h3>${esc(alpha[1])}. ${esc(alpha[2])}</h3>`);
      continue;
    }

    buffer.push(rawLine);
  }

  flushP();
  if (!out.length) out.unshift(`<h1>${esc(CONTRACT_PDF_TITLE)}</h1>`);
  return out.join("\n");
}

function signaturePanelHTML(contract) {
  const tz = tzOr(contract);
  const brandLabel = contract?.content?.brand?.legalName || contract.brandName || "—";
  const influencerLabel = contract?.content?.influencer?.legalName || contract.influencerName || "—";

  const roles = [
    { key: "brand", label: `Brand: ${esc(brandLabel)}` },
    { key: "influencer", label: `Influencer: ${esc(influencerLabel)}` },
    { key: "collabglam", label: "CollabGlam: CollabGlam LLC" },
  ];

  const blocks = roles
    .map(({ key, label }) => {
      const s = contract.signatures?.[key] || {};
      const when = s.at ? formatDateTZ(s.at, tz, "YYYY-MM-DD HH:mm z") : "";
      const isCollabGlam = key === "collabglam";
      const imgSrc = s.sigImageDataUrl || (isCollabGlam ? COLLABGLAM_FIXED_SIG_DATA_URL : null);
      const img = imgSrc
        ? `<img class="sigimg" alt="Signature image" src="${esc(imgSrc)}">`
        : "";

      const meta = s.signed
        ? `<div class="sigmeta">SIGNED by ${esc(s.name || "")}${s.email ? ` &lt;${esc(s.email)}&gt;` : ""}${when ? ` on ${esc(when)}` : ""}</div>`
        : isCollabGlam && imgSrc
          ? `<div class="sigmeta muted">Signature on file (CollabGlam)</div>`
          : `<div class="sigmeta muted">Pending signature</div>`;

      return `
        <div class="signature-block">
          <div class="sigrole">${label}</div>
          ${img}
          ${meta}
        </div>
      `;
    })
    .join("");

  return `<div class="signatures">${blocks}</div>`;
}

function renderContractHTML({ contract, templateText }) {
  let legalHTML = legalTextToHTML(templateText);
  legalHTML = legalHTML.replace('<div id="__SIG_PANEL__"></div>', signaturePanelHTML(contract));
  legalHTML = injectTrustedHtmlPlaceholders(legalHTML, contract);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { font-family: "Times New Roman", Times, serif; color: #000; font-size: 10.5pt; line-height: 1.35; }
    main { max-width: 100%; }
    img, table { max-width: 100%; }

    h1, h2, h3 { font-weight: 700; color: #000; margin: 10pt 0 6pt; }
    h1 { font-size: 13pt; text-align: center; text-transform: uppercase; letter-spacing: .2px; }
    h2 { font-size: 11pt; }
    h3 { font-size: 10.5pt; }

    p { margin: 0 0 5pt; text-align: justify; color: #000; orphans: 3; widows: 3; }

    .secno { font-weight: 700; }
    .muted { color: #444; }

    .signatures { margin: 10pt 0 6pt; display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
    .signature-block { border: 1px solid #000; padding: 8pt; break-inside: avoid; page-break-inside: avoid; }
    .sigrole { font-weight: 700; margin-bottom: 4pt; }
    .sigimg { display: block; max-height: 60pt; max-width: 100%; margin: 0 0 6pt; }
    .sigmeta { font-size: 9.5pt; color: #000; }

    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9.5pt; margin: 6pt 0; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td {
      border: 1px solid #000;
      padding: 3pt 4pt;
      vertical-align: top;
      word-break: break-word;
      overflow-wrap: anywhere;
      hyphens: auto;
    }
    th { text-align: left; background: #fff; font-weight: 700; }
    tr:nth-child(even) td { background: #fafafa; }

    .signature-block { break-inside: avoid; page-break-inside: avoid; }
  </style>
</head>
<body>
  <main>${legalHTML}</main>
</body>
</html>`;
}

// ============================ Puppeteer Shared Browser ============================
let sharedBrowserPromise = null;

async function launchBrowserOnce() {
  const baseOptions = {
    headless: true,
    dumpio: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
    ],
    timeout: 60000,
  };

  const execPath = process.env.CHROME_EXECUTABLE_PATH;

  if (execPath && fs.existsSync(execPath)) {
    try {
      return await puppeteer.launch({ ...baseOptions, executablePath: execPath });
    } catch (err) {
      console.error("[PDF] Launch with CHROME_EXECUTABLE_PATH failed, falling back", err);
    }
  }

  return puppeteer.launch(baseOptions);
}

async function getSharedBrowser() {
  if (sharedBrowserPromise) {
    try {
      const b = await sharedBrowserPromise;
      if (b && b.isConnected && b.isConnected()) return b;
    } catch (_e) {
      sharedBrowserPromise = null;
    }
  }

  sharedBrowserPromise = (async () => {
    const browser = await launchBrowserOnce();
    browser.on("disconnected", () => {
      console.warn("[PDF] Browser disconnected, resetting shared instance");
      sharedBrowserPromise = null;
    });
    return browser;
  })();

  return sharedBrowserPromise;
}

async function closeSharedBrowser() {
  try {
    if (!sharedBrowserPromise) return;
    const b = await sharedBrowserPromise;
    if (b && b.close) await b.close();
  } catch (_e) {
    // ignore
  } finally {
    sharedBrowserPromise = null;
  }
}

process.on("exit", closeSharedBrowser);
process.on("SIGINT", async () => {
  await closeSharedBrowser();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeSharedBrowser();
  process.exit(0);
});

async function renderPDFWithPuppeteer({
  html,
  res,
  filename = "Contract.pdf",
  headerTitle,
  headerDate,
}) {
  let page;

  const headerTemplate = `
    <style>
      .pdf-h {
        font-family: "Times New Roman", Times, serif;
        font-size: 9pt;
        width: 100%;
        padding: 4mm 10mm;
        text-align: center;
      }
      .pdf-h .title { font-weight: bold; }
      .pdf-h .effdate { margin-top: 1mm; }
    </style>
    <div class="pdf-h">
      <div class="title">${esc(headerTitle || "")}</div>
      <div class="effdate">Effective Date &amp; Time: ${esc(headerDate || "")}</div>
    </div>`;

  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();

    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      preferCSSPageSize: true,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate: "<div></div>",
      margin: { top: "18mm", bottom: "14mm", left: "16mm", right: "16mm" },
      scale: 1,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${filename}`);
    return res.end(pdf);
  } catch (e) {
    console.error("[PDF] Puppeteer render failed, using PDFKit fallback:", e?.message || e);

    try {
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=${filename}`);
      doc.pipe(res);

      doc.fontSize(18).text(headerTitle || CONTRACT_PDF_TITLE, { align: "center" }).moveDown();

      const plain = String(html || "")
        .replace(/<\/(p|div|h1|h2|h3|br|tr|table)>/gi, "\n\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\n{3,}/g, "\n\n");

      plain
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .forEach((p, idx, arr) => {
          doc.text(p, { align: "justify" });
          if (idx < arr.length - 1) doc.moveDown();
        });

      doc.end();
      return;
    } catch (fallbackErr) {
      return respondError(res, "PDF generation failed", 500, fallbackErr);
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_e) {
        // ignore
      }
    }
  }
}

// ============================ Audit / Versioning ============================
function addAudit(contract, role, type, details = {}) {
  contract.audit = contract.audit || [];
  contract.audit.push({ type, role: role || "system", details, at: new Date() });
  contract.lastActionAt = new Date();
  contract.lastActionByRole = role || "system";
}

function bumpVersion(contract, byRole, byUserId, editedFields) {
  const nextVersion = Number(contract.version || 0) + 1;
  contract.version = nextVersion;

  const snapshot = {
    version: nextVersion,
    status: contract.status,
    awaitingRole: contract.awaitingRole,
    requestedEffectiveDate: contract.requestedEffectiveDate,
    requestedEffectiveDateTimezone: contract.requestedEffectiveDateTimezone,
    content: contract.content,
    admin: contract.admin,
    other: contract.other,
  };

  contract.versions = contract.versions || [];
  contract.versions.push({
    version: nextVersion,
    at: new Date(),
    byRole: byRole || "system",
    byUserId: byUserId || "",
    editedFields: Array.isArray(editedFields) ? editedFields : [],
    snapshot,
  });
}

function requiredSigners(contract) {
  if (Array.isArray(contract?.requiredSigners) && contract.requiredSigners.length) {
    return contract.requiredSigners.map((x) => String(x).toLowerCase());
  }
  return ["brand", "influencer"];
}

function nextUnsignedRole(contract) {
  const req = requiredSigners(contract);
  for (const r of req) {
    if (!contract.signatures?.[r]?.signed) return r;
  }
  return null;
}

function allRequiredSigned(contract) {
  return requiredSigners(contract).every((r) => Boolean(contract.signatures?.[r]?.signed));
}

function hasAcceptedCurrent(contract, role) {
  const v = Number(contract.version || 0);
  const a = contract.acceptances?.[role];
  return Boolean(a?.accepted && Number(a?.acceptedVersion) === v);
}

function markAccepted(contract, role, byUserId) {
  const v = Number(contract.version || 0);

  contract.acceptances = contract.acceptances || {};
  contract.confirmations = contract.confirmations || {};

  contract.acceptances[role] = {
    ...(contract.acceptances[role] || {}),
    accepted: true,
    acceptedVersion: v,
    at: new Date(),
    byUserId: byUserId || "",
  };

  contract.confirmations[role] = {
    confirmed: true,
    byUserId: byUserId || "",
    at: new Date(),
  };
}

function resetAcceptancesForNewVersion(contract) {
  contract.acceptances = contract.acceptances || {};
  contract.confirmations = contract.confirmations || {};

  contract.acceptances.brand = { ...(contract.acceptances.brand || {}), accepted: false };
  contract.acceptances.influencer = {
    ...(contract.acceptances.influencer || {}),
    accepted: false,
  };

  contract.confirmations.brand = { confirmed: false };
  contract.confirmations.influencer = { confirmed: false };

  contract.editsLockedAt = null;

  contract.signatures = contract.signatures || {};
  for (const key of Object.keys(contract.signatures)) {
    contract.signatures[key] = { ...(contract.signatures[key] || {}), signed: false };
  }

  contract.awaitingRole = "influencer";
  contract.statusFlags = contract.statusFlags || {};
  contract.statusFlags.awaitingCollabglam = false;
}

function normalizeStatus(contract) {
  return Contract.normalizeStatus ? Contract.normalizeStatus(contract.status) : contract.status;
}

function isLockedContract(contract) {
  const st = normalizeStatus(contract);
  return Boolean(
    contract.lockedAt ||
    st === CONTRACT_STATUS.CONTRACT_SIGNED ||
    st === CONTRACT_STATUS.MILESTONES_CREATED
  );
}

function requireNotLocked(contract) {
  if (isLockedContract(contract)) {
    const e = new Error("Contract is locked and cannot be edited");
    e.status = 400;
    throw e;
  }
}

function requireInfluencerAcceptedCurrent(contract) {
  if (!hasAcceptedCurrent(contract, "influencer")) {
    const e = new Error("Influencer must accept the current version first");
    e.status = 400;
    throw e;
  }
}

function requireBrandAcceptedCurrent(contract) {
  if (!hasAcceptedCurrent(contract, "brand")) {
    const e = new Error("Brand must accept the current version first");
    e.status = 400;
    throw e;
  }
}

function requireReadyToSign(contract) {
  const st = normalizeStatus(contract);
  if (st !== CONTRACT_STATUS.READY_TO_SIGN || !contract.editsLockedAt) {
    const e = new Error("Contract is not ready to sign yet");
    e.status = 400;
    throw e;
  }
  if (!hasAcceptedCurrent(contract, "brand") || !hasAcceptedCurrent(contract, "influencer")) {
    const e = new Error("Both parties must accept the current version before signing");
    e.status = 400;
    throw e;
  }
}

function syncStatusFromAcceptances(contract) {
  const prev = normalizeStatus(contract);
  const brandOk = hasAcceptedCurrent(contract, "brand");
  const infOk = hasAcceptedCurrent(contract, "influencer");

  contract.statusFlags = contract.statusFlags || {};

  if (brandOk && infOk) {
    contract.status = CONTRACT_STATUS.READY_TO_SIGN;
    contract.editsLockedAt = contract.editsLockedAt || new Date();

    const nextRole = nextUnsignedRole(contract) || "brand";
    contract.awaitingRole = nextRole;
    contract.statusFlags.awaitingCollabglam = nextRole === "collabglam";

    return { movedToReady: prev !== CONTRACT_STATUS.READY_TO_SIGN, nextRole };
  }

  if (infOk && !brandOk) {
    contract.status = CONTRACT_STATUS.INFLUENCER_ACCEPTED;
    contract.awaitingRole = "brand";
    contract.statusFlags.awaitingCollabglam = false;
    return { movedToReady: false, nextRole: "brand" };
  }

  if (brandOk && !infOk) {
    contract.status = CONTRACT_STATUS.BRAND_ACCEPTED;
    contract.awaitingRole = "influencer";
    contract.statusFlags.awaitingCollabglam = false;
    return { movedToReady: false, nextRole: "influencer" };
  }

  contract.awaitingRole = contract.awaitingRole || "influencer";
  contract.statusFlags.awaitingCollabglam = false;
  return { movedToReady: false, nextRole: contract.awaitingRole };
}

function syncAwaitingFromSignatures(contract) {
  contract.statusFlags = contract.statusFlags || {};
  const nextRole = nextUnsignedRole(contract);
  contract.awaitingRole = nextRole || null;
  contract.statusFlags.awaitingCollabglam = nextRole === "collabglam";
  return nextRole;
}

function resolveEffectiveDate(contract) {
  if (contract.effectiveDateOverride) return contract.effectiveDateOverride;

  const dates = [
    contract.signatures?.brand?.at,
    contract.signatures?.influencer?.at,
    contract.signatures?.collabglam?.at,
  ]
    .filter(Boolean)
    .map((d) => new Date(d).getTime());

  if (!dates.length) return undefined;
  return new Date(Math.max(...dates));
}

function freezeRenderedSnapshot(contract) {
  const tz = tzOr(contract);
  const now = nowInContractTz(contract);

  contract.effectiveDate =
    contract.effectiveDateOverride ||
    contract?.content?.campaign?.effectiveDate ||
    contract.requestedEffectiveDate ||
    resolveEffectiveDate(contract) ||
    now;

  contract.effectiveDateTimezone = tz;

  const tokens = buildTokenMap(contract);
  const templateText = contract.admin?.legalTemplateText || MASTER_TEMPLATE;
  const rendered = renderTemplate(templateText, tokens);

  contract.templateVersion = contract.admin?.legalTemplateVersion || 1;
  contract.templateTokensSnapshot = tokens;
  contract.renderedTextSnapshot = rendered;
}

function lockIfFullySigned(contract) {
  if (!allRequiredSigned(contract)) return;

  freezeRenderedSnapshot(contract);
  contract.lockedAt = new Date();
  contract.status = CONTRACT_STATUS.CONTRACT_SIGNED;
  contract.awaitingRole = null;
  contract.statusFlags = contract.statusFlags || {};
  contract.statusFlags.awaitingCollabglam = false;

  addAudit(contract, "system", "LOCKED", { allSigned: true });
}

// ============================ Email / Reminder wrappers ============================
async function safeSendEmail({ contract, templateKey, to, recipientRole, recipientName }) {
  if (!sendContractEmail || !to) return;
  try {
    await sendContractEmail({ contract, templateKey, to, recipientRole, recipientName });
  } catch (e) {
    console.error("[Email] send failed:", templateKey, to, e?.message || e);
  }
}

async function safeStartReminder(contract, role) {
  if (!startReminder) return;
  try {
    await startReminder({ contract, role });
  } catch (e) {
    console.error("[Reminder] start failed:", role, e?.message || e);
  }
}

async function safeClearReminder(contractId, role) {
  if (!clearReminder) return;
  try {
    await clearReminder({ contractId, role });
  } catch (e) {
    console.error("[Reminder] clear failed:", role, e?.message || e);
  }
}

async function safeResetReminderOnView(contract, role) {
  if (!resetReminderOnEngagement) return;
  try {
    await resetReminderOnEngagement({ contract, role });
  } catch (e) {
    console.error("[Reminder] reset-on-view failed:", role, e?.message || e);
  }
}

// ============================ Role / actor helpers ============================
function roleFromReq(req, explicitRole) {
  return (
    explicitRole ||
    req.user?.role ||
    (req.user?.isAdmin
      ? "admin"
      : req.user?.brandId
        ? "brand"
        : req.user?.influencerId
          ? "influencer"
          : "system")
  );
}

function getEmailForRole({ contract, role, brandDoc, influencerDoc }) {
  if (role === "brand") {
    return (
      contract?.content?.brand?.noticeEmail?.trim() ||
      contract?.other?.brandProfile?.email?.trim() ||
      brandDoc?.email?.trim() ||
      ""
    );
  }
  if (role === "influencer") {
    return (
      contract?.content?.influencer?.contactEmail?.trim() ||
      contract?.other?.influencerProfile?.email?.trim() ||
      influencerDoc?.email?.trim() ||
      ""
    );
  }
  if (role === "collabglam") {
    return (
      contract?.admin?.collabglamSignatoryEmail?.trim() ||
      process.env.COLLABGLAM_SIGNATORY_EMAIL?.trim() ||
      ""
    );
  }
  return "";
}

function getNameForRole({ contract, role, brandDoc, influencerDoc }) {
  if (role === "brand") {
    return (
      contract?.content?.brand?.contactPersonName ||
      contract?.brandName ||
      brandDoc?.name ||
      brandDoc?.legalName ||
      "Brand"
    );
  }
  if (role === "influencer") {
    return (
      contract?.content?.influencer?.contactName ||
      contract?.influencerName ||
      influencerDoc?.name ||
      influencerDoc?.legalName ||
      "Influencer"
    );
  }
  if (role === "collabglam") {
    return contract?.content?.collabglam?.signatoryName || "CollabGlam";
  }
  return "User";
}

// ============================ Campaign helper ============================
function campaignQuery(campaignId) {
  return { _id: campaignId };
}

// ============================ Signature validation ============================
function parseSignatureImage({ signatureImageDataUrl, signatureImageBase64, signatureImageMime }) {
  if (!signatureImageDataUrl && !signatureImageBase64) return null;

  let mime = "image/png";
  let base64 = "";

  if (signatureImageDataUrl) {
    const m = String(signatureImageDataUrl).match(
      /^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/i
    );
    if (!m) {
      const e = new Error("Invalid signatureImageDataUrl. Must be data URL with base64.");
      e.status = 400;
      throw e;
    }
    mime = m[1].toLowerCase();
    base64 = m[3];
  } else {
    mime = (signatureImageMime || "image/png").toLowerCase();
    if (!/^image\/(png|jpeg|jpg)$/.test(mime)) {
      const e = new Error("Unsupported signatureImageMime.");
      e.status = 400;
      throw e;
    }
    base64 = String(signatureImageBase64 || "");
    if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
      const e = new Error("Invalid base64 payload for signature image.");
      e.status = 400;
      throw e;
    }
  }

  const bytes = Buffer.from(base64, "base64").length;
  if (bytes > MAX_SIG_BYTES) {
    const e = new Error(`Signature image must be ≤ ${MAX_SIG_BYTES / 1024} KB.`);
    e.status = 400;
    throw e;
  }

  return {
    sigImageDataUrl: `data:${mime};base64,${base64}`,
    sigImageBytes: bytes,
  };
}

// ============================ Resend helper ============================
function buildResendChildContract(
  parentDoc,
  {
    campaignDoc,
    contentUpdates = {},
    requestedEffectiveDate,
    requestedEffectiveDateTimezone,
    userEmail,
    asPlain = false,
  } = {}
) {
  const parent = parentDoc?.toObject ? parentDoc.toObject() : parentDoc;

  const tz =
    requestedEffectiveDateTimezone ||
    parent?.requestedEffectiveDateTimezone ||
    parent?.admin?.timezone ||
    DEFAULT_TZ;

  const requestedDateBuilt = requestedEffectiveDate
    ? buildRequestedEffectiveDate(requestedEffectiveDate, tz)
    : parent?.requestedEffectiveDate;

  const mergedContent = mergeDeep(parent?.content || {}, contentUpdates || {});
  const paymentType = getCampaignPaymentType(campaignDoc);

  mergedContent.campaign = mergedContent.campaign || {};
  mergedContent.campaign.paymentType = paymentType;

  if (requestedDateBuilt) {
    mergedContent.campaign.effectiveDate = requestedDateBuilt;
  }

  const childData = {
    brandId: parent.brandId,
    influencerId: parent.influencerId,
    campaignId: parent.campaignId,

    status: CONTRACT_STATUS.BRAND_SENT_DRAFT,
    awaitingRole: "influencer",

    version: 0,
    editsLockedAt: null,
    versions: [],

    requiredSigners:
      Array.isArray(parent.requiredSigners) && parent.requiredSigners.length
        ? parent.requiredSigners
        : ["brand", "influencer"],

    acceptances: { brand: { accepted: false }, influencer: { accepted: false } },
    confirmations: { brand: { confirmed: false }, influencer: { confirmed: false } },

    paymentType,

    signatures: {
      brand: { signed: false },
      influencer: { signed: false },
      collabglam: { signed: false },
    },

    content: mergedContent,
    other: parent.other,
    admin: parent.admin,

    requestedEffectiveDate: requestedDateBuilt,
    requestedEffectiveDateTimezone: tz,

    brandName: mergedContent?.brand?.legalName || parent.brandName,
    brandAddress: mergedContent?.brand?.billingAddress || parent.brandAddress,
    influencerName: mergedContent?.influencer?.legalName || parent.influencerName,
    influencerAddress: mergedContent?.influencer?.address || parent.influencerAddress,
    influencerHandle:
      mergedContent?.influencer?.postingHandleUrl || parent.influencerHandle,

    lastSentAt: new Date(),
    lastViewedAt: { brand: null, influencer: null },
    reminders: { brand: {}, influencer: {} },
    emailLog: [],
    milestonesCreatedAt: null,
    milestones: [],

    isAssigned: 1,
    isAccepted: 0,
    isRejected: 0,
    feeAmount: Number(
      mergedContent?.scheduleA?.commercial?.totalCampaignFee ?? parent.feeAmount ?? 0
    ),
    currency: mergedContent?.scheduleA?.commercial?.currency || parent.currency || "USD",

    resendIteration: Number(parent.resendIteration || 0) + 1,
    resendOf: parent.contractId,
    supersededBy: null,
    resentAt: null,

    lockedAt: null,
    effectiveDate: null,
    effectiveDateOverride: null,
  };

  if (asPlain) return childData;

  const child = new Contract(childData);
  addAudit(child, "system", "RESENT_CHILD_CREATED", {
    resendOf: parent.contractId,
    by: userEmail || "system",
  });
  return child;
}

// ============================ Controllers ============================
exports.initiate = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      campaignId,
      content: contentInput = {},
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      preview = false,
      isResend = false,
      resendOf,
    } = req.body;

    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);

    const mongoose = require("mongoose");

    if (!mongoose.Types.ObjectId.isValid(campaignId)) {
      return respondError(res, "Invalid campaignId", 400);
    }
    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      return respondError(res, "Invalid brandId", 400);
    }
    if (!mongoose.Types.ObjectId.isValid(influencerId)) {
      return respondError(res, "Invalid influencerId", 400);
    }

    const [campaign, brandDoc, influencerDoc] = await Promise.all([
      Campaign.findById(campaignId),
      Brand.findById(brandId),
      Influencer.findById(influencerId),
    ]);

    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);
    if (!influencerDoc) return respondError(res, "Influencer not found", 404);
    const other = {
      brandProfile: {
        legalName: brandDoc.legalName || brandDoc.name || "",
        address: brandDoc.address || "",
        contactName: brandDoc.contactName || brandDoc.ownerName || "",
        email: brandDoc.email || "",
        country: brandDoc.country || "",
      },
      influencerProfile: {
        legalName: influencerDoc.legalName || influencerDoc.name || "",
        address: influencerDoc.address || "",
        contactName: influencerDoc.contactName || influencerDoc.name || "",
        email: influencerDoc.email || "",
        country: influencerDoc.country || "",
        handle: influencerDoc.handle || "",
      },
      autoCalcs: {},
    };

    const adminTimezone =
      campaign?.campaignTimezone || requestedEffectiveDateTimezone || DEFAULT_TZ;
    const admin = {
      timezone: adminTimezone,
      jurisdiction: "USA",
      arbitrationSeat: "San Francisco, CA",
      fxSource: "ECB",
      extraRevisionFee: 0,
      escrowAMLFlags: "",
      collabglamSignatoryName: "",
      collabglamSignatoryEmail: process.env.COLLABGLAM_SIGNATORY_EMAIL || "",
      legalTemplateVersion: 1,
      legalTemplateText: MASTER_TEMPLATE,
      legalTemplateHistory: [
        {
          version: 1,
          text: MASTER_TEMPLATE,
          updatedAt: new Date(),
          updatedBy: req.user?.email || "system",
        },
      ],
    };

    const requestedDateBuilt = requestedEffectiveDate
      ? buildRequestedEffectiveDate(
        requestedEffectiveDate,
        requestedEffectiveDateTimezone || adminTimezone || DEFAULT_TZ
      )
      : undefined;

    const content = createDefaultContent({
      campaign,
      brandDoc,
      influencerDoc,
      admin,
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      contentInput,
    });

    const base = {
      brandId,
      influencerId,
      campaignId,
      paymentType: getCampaignPaymentType(campaign),

      status: CONTRACT_STATUS.BRAND_SENT_DRAFT,
      awaitingRole: "influencer",
      version: 0,
      editsLockedAt: null,

      requiredSigners: ["brand", "influencer"],

      acceptances: {
        brand: { accepted: false },
        influencer: { accepted: false },
      },
      confirmations: { brand: { confirmed: false }, influencer: { confirmed: false } },

      signatures: {
        brand: { signed: false },
        influencer: { signed: false },
        collabglam: { signed: false },
      },

      content,
      other,
      admin,

      requestedEffectiveDate: requestedDateBuilt,
      requestedEffectiveDateTimezone: requestedEffectiveDateTimezone || adminTimezone || DEFAULT_TZ,

      brandName: content.brand.legalName,
      brandAddress: content.brand.billingAddress,
      influencerName: content.influencer.legalName,
      influencerAddress: content.influencer.address,
      influencerHandle: content.influencer.postingHandleUrl,
    };

    if (preview && !isResend) {
      const tmp = { ...base };
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin.legalTemplateText, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });

      return renderPDFWithPuppeteer({
        html,
        res,
        filename: `Contract-Preview-${campaignId}.pdf`,
        headerTitle: CONTRACT_PDF_TITLE,
        headerDate:
          tokens["Agreement.EffectiveDateTime"] ||
          tokens["Agreement.EffectiveDateLong"] ||
          "Pending",
      });
    }

    if (isResend && resendOf) {
      const parent = await Contract.findOne({ contractId: resendOf });
      if (!parent) return respondError(res, "resendOf contract not found", 404);

      if (
        String(parent.brandId) !== String(brandId) ||
        String(parent.influencerId) !== String(influencerId) ||
        String(parent.campaignId) !== String(campaignId)
      ) {
        return respondError(
          res,
          "resendOf must belong to the same brand, influencer, and campaign",
          400
        );
      }

      if (isLockedContract(parent)) {
        return respondError(res, "Cannot resend a signed/locked contract", 400);
      }

      const child = buildResendChildContract(parent, {
        campaignDoc: campaign,
        contentUpdates: contentInput,
        requestedEffectiveDate,
        requestedEffectiveDateTimezone,
        userEmail: req.user?.email,
      });

      await child.save();

      parent.supersededBy = child.contractId;
      parent.resentAt = new Date();
      parent.status = CONTRACT_STATUS.SUPERSEDED;
      addAudit(parent, "system", "RESENT", {
        to: child.contractId,
        by: req.user?.email || "system",
      });
      await parent.save();

      await Campaign.updateOne(campaignQuery(campaignId), {
        $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 },
      });

      await createAndEmit({
        recipientType: "influencer",
        influencerId: String(influencerId),
        type: "contract.initiated",
        title: `Contract resent by ${brandDoc.name || "Brand"}`,
        message: `Updated contract for "${campaign.productOrServiceName || "Campaign"}".`,
        entityType: "contract",
        entityId: String(child.contractId),
        actionPath: `/influencer/my-campaign`,
        meta: { campaignId, brandId, influencerId, resendOf: parent.contractId },
      });

      await createAndEmit({
        recipientType: "brand",
        brandId: String(brandId),
        type: "contract.initiated.self",
        title: "Contract resent",
        message: `You resent the contract to ${influencerDoc?.name || "Influencer"}.`,
        entityType: "contract",
        entityId: String(child.contractId),
        actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
        meta: { campaignId, influencerId, resendOf: parent.contractId },
      });

      const infEmail = getEmailForRole({ contract: child, role: "influencer", influencerDoc });
      await safeSendEmail({
        contract: child,
        templateKey: "contract_new_received_influencer",
        to: infEmail,
        recipientRole: "influencer",
        recipientName: getNameForRole({ contract: child, role: "influencer", influencerDoc }),
      });

      await safeStartReminder(child, "influencer");
      await safeClearReminder(child.contractId, "brand");

      return respondOK(res, { message: "Resent contract created", contract: child }, 201);
    }

    const contract = new Contract({
      ...base,
      lastSentAt: new Date(),
      isAssigned: 1,
      isAccepted: 0,
      feeAmount: Number(content?.scheduleA?.commercial?.totalCampaignFee || 0),
      currency: content?.scheduleA?.commercial?.currency || "USD",
    });

    addAudit(contract, "system", "INITIATED", { campaignId, status: contract.status });
    await contract.save();

    await Campaign.updateOne(campaignQuery(campaignId), {
      $set: { isContracted: 1 },
    });

    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(influencerId),
      type: "contract.initiated",
      title: `Contract initiated by ${brandDoc.name || "Brand"}`,
      message: `Contract created for "${campaign.productOrServiceName || "Campaign"}".`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { campaignId, brandId, influencerId },
    });

    await createAndEmit({
      recipientType: "brand",
      brandId: String(brandId),
      type: "contract.initiated.self",
      title: "Contract sent",
      message: `You sent a contract to ${influencerDoc.name || "Influencer"}.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
      meta: { campaignId, influencerId },
    });

    const infEmail = getEmailForRole({ contract, role: "influencer", influencerDoc });
    await safeSendEmail({
      contract,
      templateKey: "contract_new_received_influencer",
      to: infEmail,
      recipientRole: "influencer",
      recipientName: getNameForRole({ contract, role: "influencer", influencerDoc }),
    });

    await safeStartReminder(contract, "influencer");
    await safeClearReminder(contract.contractId, "brand");

    return respondOK(res, { message: "Contract initialized successfully", contract }, 201);
  } catch (err) {
    return respondError(res, err.message || "initiate error", err.status || 500, err);
  }
};

exports.viewed = async (req, res) => {
  try {
    const { contractId, role } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    const who = roleFromReq(req, role);

    contract.lastViewedAt = contract.lastViewedAt || {};
    if (who === "brand") contract.lastViewedAt.brand = new Date();
    if (who === "influencer") contract.lastViewedAt.influencer = new Date();

    addAudit(contract, who, "VIEWED");
    await contract.save();

    if (who === "brand" || who === "influencer") {
      await safeResetReminderOnView(contract, who);
    }

    return respondOK(res, { message: "Marked viewed", contract });
  } catch (err) {
    return respondError(res, "viewed error", err.status || 500, err);
  }
};

exports.influencerConfirm = async (req, res) => {
  try {
    const { contractId, influencer: influencerData = {}, preview = false } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);

    if (contract.editsLockedAt) {
      return respondError(
        res,
        "Contract is locked for signing; edits/accept changes are disabled",
        400
      );
    }

    const incoming = {
      content: {
        influencer: {
          legalName: influencerData?.legalName,
          contactName: influencerData?.contactName,
          postingHandleUrl: influencerData?.postingHandleUrl,
          contactEmail: influencerData?.contactEmail,
          contactPhone: influencerData?.contactPhone,
          whatsApp: influencerData?.whatsApp,
          address: influencerData?.address,
        },
      },
    };

    if (preview) {
      const tmp = contract.toObject?.() || contract;
      tmp.content = mergeDeep(tmp.content || {}, incoming.content || {});

      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });

      return renderPDFWithPuppeteer({
        html,
        res,
        filename: `Contract-Influencer-Preview-${contractId}.pdf`,
        headerTitle: CONTRACT_PDF_TITLE,
        headerDate:
          tokens["Agreement.EffectiveDateTime"] ||
          tokens["Agreement.EffectiveDateLong"] ||
          "Pending",
      });
    }

    contract.content = contract.content || {};

    const changedPaths = applyAllowedDeepUpdates(
      contract,
      incoming,
      ALLOWED_INFLUENCER_PATHS
    );

    if (changedPaths.length) {
      bumpVersion(contract, "influencer", req.user?.id, changedPaths);
      contract.status = CONTRACT_STATUS.INFLUENCER_EDITED;
      contract.awaitingRole = "brand";
      resetAcceptancesForNewVersion(contract);
    }

    markAccepted(contract, "influencer", req.user?.id);
    const sync = syncStatusFromAcceptances(contract);
    contract.isAccepted = 1;

    addAudit(contract, "influencer", "INFLUENCER_ACCEPTED", {
      editedFields: changedPaths,
      version: contract.version,
      nextRole: sync.nextRole,
    });

    await contract.save();

    await Campaign.updateOne(campaignQuery(contract.campaignId), {
      $set: { isAccepted: 1, isContracted: 1, contractId: contract.contractId },
    });

    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.confirm.influencer",
      title: "Influencer accepted",
      message: `${contract.influencerName || "Influencer"} accepted the contract.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}&infId=${contract.influencerId}`,
    });

    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(contract.influencerId),
      type: "contract.confirm.influencer.self",
      title: "You accepted the contract",
      message: `You accepted “${contract.content?.campaign?.campaignTitleOrId || contract.brandName || "Contract"}”.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { campaignId: contract.campaignId, brandId: contract.brandId },
    });

    const brandEmail = getEmailForRole({ contract, role: "brand" });
    await safeSendEmail({
      contract,
      templateKey: "contract_accepted_by_influencer_brand_notify",
      to: brandEmail,
      recipientRole: "brand",
      recipientName: getNameForRole({ contract, role: "brand" }),
    });

    if (contract.awaitingRole === "brand") await safeStartReminder(contract, "brand");
    await safeClearReminder(contract.contractId, "influencer");

    return respondOK(res, { message: "Influencer acceptance saved", contract });
  } catch (err) {
    return respondError(res, err.message || "influencerConfirm error", err.status || 500, err);
  }
};

exports.brandConfirm = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    requireNotLocked(contract);
    if (contract.editsLockedAt) {
      return respondError(res, "Contract is already locked for signing", 400);
    }

    requireInfluencerAcceptedCurrent(contract);

    markAccepted(contract, "brand", req.user?.id);
    const sync = syncStatusFromAcceptances(contract);

    if (sync.movedToReady) {
      addAudit(contract, "system", "READY_TO_SIGN", {
        version: contract.version,
        nextRole: sync.nextRole,
      });
    }
    addAudit(contract, "brand", "BRAND_ACCEPTED", { version: contract.version });

    await contract.save();

    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(contract.influencerId),
      type: "contract.confirm.brand",
      title: "Brand accepted",
      message: `${contract.brandName || "Brand"} accepted the contract. ${contract.status === CONTRACT_STATUS.READY_TO_SIGN ? "Both parties can sign now." : "Awaiting next step."
        }`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
    });

    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.confirm.brand.self",
      title: "You accepted the contract",
      message:
        contract.status === CONTRACT_STATUS.READY_TO_SIGN
          ? `You accepted the contract for “${contract.content?.campaign?.campaignTitleOrId || "Campaign"}”. Signing is open.`
          : `You accepted the contract for “${contract.content?.campaign?.campaignTitleOrId || "Campaign"}”.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
      meta: { campaignId: contract.campaignId, influencerId: contract.influencerId },
    });

    const influencerEmail = getEmailForRole({ contract, role: "influencer" });
    await safeSendEmail({
      contract,
      templateKey: "contract_accepted_by_brand_influencer_notify",
      to: influencerEmail,
      recipientRole: "influencer",
      recipientName: getNameForRole({ contract, role: "influencer" }),
    });

    if (contract.status === CONTRACT_STATUS.READY_TO_SIGN && contract.editsLockedAt) {
      const brandEmail = getEmailForRole({ contract, role: "brand" });

      await safeSendEmail({
        contract,
        templateKey: "contract_ready_to_sign_both",
        to: brandEmail,
        recipientRole: "brand",
        recipientName: getNameForRole({ contract, role: "brand" }),
      });

      await safeSendEmail({
        contract,
        templateKey: "contract_ready_to_sign_both",
        to: influencerEmail,
        recipientRole: "influencer",
        recipientName: getNameForRole({ contract, role: "influencer" }),
      });

      await safeClearReminder(contract.contractId, "brand");
      await safeClearReminder(contract.contractId, "influencer");
    }

    return respondOK(res, { message: "Brand acceptance saved", contract });
  } catch (err) {
    return respondError(res, err.message || "brandConfirm error", err.status || 500, err);
  }
};

exports.adminUpdate = async (req, res) => {
  try {
    const { contractId, adminUpdates = {}, newLegalText } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    if (!req.user?.isAdmin) return respondError(res, "Forbidden: admin only", 403);

    requireNotLocked(contract);

    const before = { admin: contract.admin?.toObject?.() || contract.admin };
    contract.admin = { ...contract.admin, ...adminUpdates };

    if (typeof newLegalText === "string" && newLegalText.trim()) {
      const newVersion = (contract.admin.legalTemplateVersion || 1) + 1;
      contract.admin.legalTemplateVersion = newVersion;
      contract.admin.legalTemplateText = newLegalText;
      contract.admin.legalTemplateHistory = contract.admin.legalTemplateHistory || [];
      contract.admin.legalTemplateHistory.push({
        version: newVersion,
        text: newLegalText,
        updatedAt: new Date(),
        updatedBy: req.user?.email || "admin",
      });
    }

    const after = { admin: contract.admin };
    const editedFields = computeEditedFields(before, after, ["admin"]);

    if (editedFields.length) {
      bumpVersion(contract, "admin", req.user?.id, editedFields);
      resetAcceptancesForNewVersion(contract);

      contract.status = CONTRACT_STATUS.BRAND_SENT_DRAFT;
      contract.awaitingRole = "influencer";

      addAudit(contract, "admin", "ADMIN_UPDATED", {
        adminUpdates: Object.keys(adminUpdates),
        newLegalVersion: contract.admin.legalTemplateVersion,
        editedFields,
      });
    }

    await contract.save();

    if (editedFields.length) {
      await safeStartReminder(contract, "influencer");
      await safeClearReminder(contract.contractId, "brand");
    }

    return respondOK(res, { message: "Admin settings updated", contract });
  } catch (err) {
    return respondError(res, err.message || "adminUpdate error", err.status || 500, err);
  }
};

exports.finalize = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);

    requireInfluencerAcceptedCurrent(contract);
    requireBrandAcceptedCurrent(contract);

    if (contract.status === CONTRACT_STATUS.READY_TO_SIGN && contract.editsLockedAt) {
      return respondOK(res, { message: "Already ready to sign", contract });
    }

    const prev = normalizeStatus(contract);

    contract.status = CONTRACT_STATUS.READY_TO_SIGN;
    contract.editsLockedAt = new Date();
    syncAwaitingFromSignatures(contract);

    addAudit(contract, "system", "READY_TO_SIGN", {
      version: contract.version,
      prevStatus: prev,
      awaitingRole: contract.awaitingRole,
    });

    await contract.save();

    const brandEmail = getEmailForRole({ contract, role: "brand" });
    const influencerEmail = getEmailForRole({ contract, role: "influencer" });

    await safeSendEmail({
      contract,
      templateKey: "contract_ready_to_sign_both",
      to: brandEmail,
      recipientRole: "brand",
      recipientName: getNameForRole({ contract, role: "brand" }),
    });

    await safeSendEmail({
      contract,
      templateKey: "contract_ready_to_sign_both",
      to: influencerEmail,
      recipientRole: "influencer",
      recipientName: getNameForRole({ contract, role: "influencer" }),
    });

    await safeClearReminder(contract.contractId, "brand");
    await safeClearReminder(contract.contractId, "influencer");

    return respondOK(res, { message: "Contract finalized for signatures", contract });
  } catch (err) {
    return respondError(res, err.message || "finalize error", err.status || 500, err);
  }
};

exports.preview = async (req, res) => {
  try {
    const { contractId } = req.query;
    assertRequired(req.query, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    let tokens;
    let renderedText;

    if (contract.lockedAt && contract.renderedTextSnapshot) {
      renderedText = contract.renderedTextSnapshot;
      tokens = contract.templateTokensSnapshot || buildTokenMap(contract);
    } else {
      tokens = buildTokenMap(contract);
      renderedText = renderTemplate(contract.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
    }

    const html = renderContractHTML({ contract, templateText: renderedText });

    return renderPDFWithPuppeteer({
      html,
      res,
      filename: `Contract-Preview-${contractId}.pdf`,
      headerTitle: CONTRACT_PDF_TITLE,
      headerDate:
        tokens["Agreement.EffectiveDateTime"] ||
        tokens["Agreement.EffectiveDateLong"] ||
        tokens["Agreement.EffectiveDate"] ||
        "Pending",
    });
  } catch (err) {
    return respondError(res, err.message || "preview error", err.status || 500, err);
  }
};

exports.viewContractPdf = async (req, res) => {
  let contract;
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);

    contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    const text =
      contract.lockedAt && contract.renderedTextSnapshot
        ? contract.renderedTextSnapshot
        : renderTemplate(
          contract.admin?.legalTemplateText || MASTER_TEMPLATE,
          buildTokenMap(contract)
        );

    const html = renderContractHTML({ contract, templateText: text });
    const tokens = buildTokenMap(contract);

    return renderPDFWithPuppeteer({
      html,
      res,
      filename: `Contract-${contractId}.pdf`,
      headerTitle: CONTRACT_PDF_TITLE,
      headerDate:
        tokens["Agreement.EffectiveDateTime"] ||
        tokens["Agreement.EffectiveDateLong"] ||
        "Pending",
    });
  } catch (err) {
    console.error("viewContractPdf error:", err);

    try {
      const templateText = renderTemplate(
        contract?.admin?.legalTemplateText || MASTER_TEMPLATE,
        buildTokenMap(contract || {})
      );
      const doc = new PDFDocument({ margin: 50 });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename=Contract-${contract?.contractId || "Unknown"}.pdf`
      );

      doc.pipe(res);
      doc.fontSize(18).text(CONTRACT_PDF_TITLE, { align: "center" }).moveDown();

      const paragraphs = String(templateText || "").split(/\n\s*\n/);
      paragraphs.forEach((p, i) => {
        doc.text(p, { align: "justify" });
        if (i < paragraphs.length - 1) doc.moveDown();
      });

      doc.end();
      return;
    } catch (e2) {
      return respondError(res, "fallback PDF also failed", 500, e2);
    }
  }
};

exports.sign = async (req, res) => {
  try {
    const {
      contractId,
      role,
      name,
      email,
      effectiveDateOverride,
      signatureImageDataUrl,
      signatureImageBase64,
      signatureImageMime,
    } = req.body;

    assertRequired(req.body, ["contractId", "role"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);

    const signerRole = String(role).toLowerCase();
    const allowed = requiredSigners(contract);
    if (!allowed.includes(signerRole)) {
      return respondError(res, `Invalid role. Allowed signers: ${allowed.join(", ")}`, 400);
    }

    requireReadyToSign(contract);

    if (contract.signatures?.[signerRole]?.signed) {
      return respondError(res, "Already signed for this role", 400);
    }

    const sigPayload = parseSignatureImage({
      signatureImageDataUrl,
      signatureImageBase64,
      signatureImageMime,
    });

    contract.signatures = contract.signatures || {};
    const now = nowInContractTz(contract);

    contract.signatures[signerRole] = {
      ...(contract.signatures[signerRole] || {}),
      signed: true,
      byUserId: req.user?.id,
      name,
      email,
      at: now,
      ...(sigPayload || {}),
    };

    if (effectiveDateOverride && req.user?.isAdmin) {
      contract.effectiveDateOverride = new Date(effectiveDateOverride);
    }

    addAudit(contract, signerRole, "SIGNED", { role: signerRole, name, email });
    const nextRole = syncAwaitingFromSignatures(contract);

    lockIfFullySigned(contract);
    await contract.save();

    const locked = isLockedContract(contract);

    if (!locked) {
      if (signerRole === "brand") {
        const influencerEmail = getEmailForRole({ contract, role: "influencer" });
        await safeSendEmail({
          contract,
          templateKey: "contract_signed_by_brand_influencer_notify",
          to: influencerEmail,
          recipientRole: "influencer",
          recipientName: getNameForRole({ contract, role: "influencer" }),
        });
      }

      if (signerRole === "influencer") {
        const brandEmail = getEmailForRole({ contract, role: "brand" });
        await safeSendEmail({
          contract,
          templateKey: "contract_signed_by_influencer_brand_notify",
          to: brandEmail,
          recipientRole: "brand",
          recipientName: getNameForRole({ contract, role: "brand" }),
        });
      }
    }

    const campaignSync = { isContracted: 1, contractId: contract.contractId };
    if (contract.isAccepted === 1) campaignSync.isAccepted = 1;
    if (locked) campaignSync.contractLockedAt = contract.lockedAt || new Date();
    await Campaign.updateOne(campaignQuery(contract.campaignId), { $set: campaignSync });

    const opp =
      signerRole === "brand"
        ? {
          recipientType: "influencer",
          influencerId: String(contract.influencerId),
          type: "contract.signed.brand",
          path: `/influencer/my-campaign`,
        }
        : signerRole === "influencer"
          ? {
            recipientType: "brand",
            brandId: String(contract.brandId),
            type: "contract.signed.influencer",
            path: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
          }
          : null;

    if (opp) {
      await createAndEmit({
        recipientType: opp.recipientType,
        brandId: opp.brandId,
        influencerId: opp.influencerId,
        type: opp.type,
        title: `${signerRole === "brand" ? "Brand" : "Influencer"} signed`,
        message: `${signerRole === "brand"
          ? contract.brandName || "Brand"
          : contract.influencerName || "Influencer"
          } added a signature.`,
        entityType: "contract",
        entityId: String(contract.contractId),
        actionPath: opp.path,
      });
    }

    if (signerRole === "brand") {
      await createAndEmit({
        recipientType: "brand",
        brandId: String(contract.brandId),
        type: "contract.signed.brand.self",
        title: "You signed the contract",
        message: "Your signature has been recorded.",
        entityType: "contract",
        entityId: String(contract.contractId),
        actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
      });
    } else if (signerRole === "influencer") {
      await createAndEmit({
        recipientType: "influencer",
        influencerId: String(contract.influencerId),
        type: "contract.signed.influencer.self",
        title: "You signed the contract",
        message: "Your signature has been recorded.",
        entityType: "contract",
        entityId: String(contract.contractId),
        actionPath: `/influencer/my-campaign`,
      });
    }

    await safeClearReminder(contract.contractId, signerRole);

    if (!locked && nextRole) {
      await safeStartReminder(contract, nextRole);
    }

    if (locked) {
      await Promise.all([
        createAndEmit({
          recipientType: "brand",
          brandId: String(contract.brandId),
          type: "contract.locked",
          title: "Contract fully signed",
          message: "All required parties signed. Your contract is locked.",
          entityType: "contract",
          entityId: String(contract.contractId),
          actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
        }),
        createAndEmit({
          recipientType: "influencer",
          influencerId: String(contract.influencerId),
          type: "contract.locked",
          title: "Contract fully signed",
          message: "All required parties signed. Your contract is locked.",
          entityType: "contract",
          entityId: String(contract.contractId),
          actionPath: `/influencer/my-campaign`,
        }),
      ]);

      const brandEmail = getEmailForRole({ contract, role: "brand" });
      const influencerEmail = getEmailForRole({ contract, role: "influencer" });

      await safeSendEmail({
        contract,
        templateKey: "contract_fully_signed_both",
        to: brandEmail,
        recipientRole: "brand",
        recipientName: getNameForRole({ contract, role: "brand" }),
      });

      await safeSendEmail({
        contract,
        templateKey: "contract_fully_signed_both",
        to: influencerEmail,
        recipientRole: "influencer",
        recipientName: getNameForRole({ contract, role: "influencer" }),
      });

      await safeClearReminder(contract.contractId, "brand");
      await safeClearReminder(contract.contractId, "influencer");
      await safeClearReminder(contract.contractId, "collabglam");
    }

    return respondOK(res, {
      message: locked ? "Signed & locked" : "Signature recorded",
      contract,
    });
  } catch (err) {
    return respondError(res, err.message || "sign error", err.status || 500, err);
  }
};

exports.brandUpdateFields = async (req, res) => {
  try {
    const { contractId, brandId, brandUpdates = {}, type = 0 } = req.body;
    const isPreview = Number(type) === 1;

    assertRequired(req.body, ["contractId", "brandId"]);

    const contract = await Contract.findOne({ contractId, brandId });
    if (!contract) return respondError(res, "Contract not found", 404);

    requireNotLocked(contract);
    if (contract.editsLockedAt) {
      return respondError(
        res,
        "Contract is locked for signing; edits are disabled",
        400
      );
    }

    contract.content = contract.content || {};

    const before = { content: contract.content?.toObject?.() || contract.content };
    const changedPaths = applyAllowedDeepUpdates(contract, brandUpdates, ALLOWED_BRAND_PATHS);
    const after = { content: contract.content?.toObject?.() || contract.content };

    const editedFields = computeEditedFields(before, after, ["content"]);

    if (isPreview) {
      return respondOK(res, {
        message: "Brand fields preview",
        contract,
        editedFields: editedFields.length ? editedFields : changedPaths,
      });
    }

    if (editedFields.length || changedPaths.length) {
      bumpVersion(
        contract,
        "brand",
        req.user?.id,
        editedFields.length ? editedFields : changedPaths
      );
      resetAcceptancesForNewVersion(contract);

      contract.status = CONTRACT_STATUS.BRAND_EDITED;
      contract.awaitingRole = "influencer";
      contract.lastSentAt = new Date();

      addAudit(contract, "brand", "BRAND_EDITED", {
        editedFields: editedFields.length ? editedFields : changedPaths,
      });
    }

    await contract.save();

    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(contract.influencerId),
      type: "contract.edited.brand",
      title: `Contract updated by ${contract.brandName || "Brand"}`,
      message: "Brand made changes to your contract. Please review and accept again.",
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
    });

    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.edited.brand.self",
      title: "You updated the contract",
      message: "Your changes were saved and shared with the influencer.",
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
      meta: { editedFields: editedFields.length ? editedFields : changedPaths },
    });

    const influencerEmail = getEmailForRole({ contract, role: "influencer" });
    await safeSendEmail({
      contract,
      templateKey: "contract_updated_by_brand_influencer_notify",
      to: influencerEmail,
      recipientRole: "influencer",
      recipientName: getNameForRole({ contract, role: "influencer" }),
    });

    await safeStartReminder(contract, "influencer");
    await safeClearReminder(contract.contractId, "brand");

    return respondOK(res, { message: "Brand fields updated", contract });
  } catch (err) {
    return respondError(res, err.message || "brandUpdateFields error", err.status || 500, err);
  }
};

exports.influencerUpdateFields = async (req, res) => {
  try {
    const { contractId, influencerUpdates = {} } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    requireNotLocked(contract);
    if (contract.editsLockedAt) {
      return respondError(
        res,
        "Contract is locked for signing; edits are disabled",
        400
      );
    }

    contract.content = contract.content || {};

    const before = { content: contract.content?.toObject?.() || contract.content };
    const changedPaths = applyAllowedDeepUpdates(contract, influencerUpdates, ALLOWED_INFLUENCER_PATHS);
    const after = { content: contract.content?.toObject?.() || contract.content };

    const editedFields = computeEditedFields(before, after, ["content"]);

    if (editedFields.length || changedPaths.length) {
      bumpVersion(
        contract,
        "influencer",
        req.user?.id,
        editedFields.length ? editedFields : changedPaths
      );
      resetAcceptancesForNewVersion(contract);

      contract.status = CONTRACT_STATUS.INFLUENCER_EDITED;
      contract.awaitingRole = "brand";

      addAudit(contract, "influencer", "INFLUENCER_EDITED", {
        editedFields: editedFields.length ? editedFields : changedPaths,
      });
    }

    await contract.save();

    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.edited.influencer",
      title: `Contract updated by ${contract.influencerName || "Influencer"}`,
      message: "Influencer submitted updates to the contract. Please review and accept again.",
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
    });

    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(contract.influencerId),
      type: "contract.edited.influencer.self",
      title: "You updated the contract",
      message: "Your updates were sent to the brand.",
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { editedFields: editedFields.length ? editedFields : changedPaths },
    });

    const brandEmail = getEmailForRole({ contract, role: "brand" });
    await safeSendEmail({
      contract,
      templateKey: "contract_updated_by_influencer_brand_notify",
      to: brandEmail,
      recipientRole: "brand",
      recipientName: getNameForRole({ contract, role: "brand" }),
    });

    await safeStartReminder(contract, "brand");
    await safeClearReminder(contract.contractId, "influencer");

    return respondOK(res, { message: "Influencer fields updated", contract });
  } catch (err) {
    return respondError(res, err.message || "influencerUpdateFields error", err.status || 500, err);
  }
};

exports.getContract = async (req, res) => {
  try {
    const { brandId, influencerId, campaignId } = req.body;
    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);

    const contracts = await Contract.find({ brandId, influencerId, campaignId })
      .sort({ createdAt: -1 })
      .lean();

    return respondOK(res, { contracts: contracts || [] });
  } catch (err) {
    return respondError(res, "Error fetching contracts", 500, err);
  }
};

exports.reject = async (req, res) => {
  try {
    const { contractId, influencerId, reason } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);

    if (influencerId && String(influencerId) !== String(contract.influencerId)) {
      return respondError(res, "Forbidden", 403);
    }

    contract.isAccepted = 0;
    contract.isRejected = 1;
    contract.status = CONTRACT_STATUS.REJECTED;
    contract.awaitingRole = null;
    contract.editsLockedAt = null;
    contract.statusFlags = contract.statusFlags || {};
    contract.statusFlags.awaitingCollabglam = false;

    addAudit(contract, "influencer", "REJECTED", { reason });
    await contract.save();

    await Campaign.updateOne(campaignQuery(contract.campaignId), {
      $set: { isContracted: 0, contractId: null, isAccepted: 0 },
    });

    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.rejected",
      title: "Contract rejected by influencer",
      message: reason ? `Reason: ${reason}` : "Influencer rejected the contract.",
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
    });

    const brandEmail = getEmailForRole({ contract, role: "brand" });
    const influencerEmail = getEmailForRole({ contract, role: "influencer" });

    await safeSendEmail({
      contract,
      templateKey: "contract_declined_both",
      to: brandEmail,
      recipientRole: "brand",
      recipientName: getNameForRole({ contract, role: "brand" }),
    });

    await safeSendEmail({
      contract,
      templateKey: "contract_declined_both",
      to: influencerEmail,
      recipientRole: "influencer",
      recipientName: getNameForRole({ contract, role: "influencer" }),
    });

    await safeClearReminder(contract.contractId, "brand");
    await safeClearReminder(contract.contractId, "influencer");
    await safeClearReminder(contract.contractId, "collabglam");

    return respondOK(res, { message: "Contract rejected", contract });
  } catch (err) {
    return respondError(res, err.message || "reject error", err.status || 500, err);
  }
};

exports.resend = async (req, res) => {
  try {
    const {
      contractId,
      content: contentUpdates = {},
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      preview = false,
    } = req.body;
    assertRequired(req.body, ["contractId"]);

    const parent = await Contract.findOne({ contractId });
    if (!parent) return respondError(res, "Contract not found", 404);

    const campaignDoc = await Campaign.findById(parent.campaignId);
    if (!campaignDoc) return respondError(res, "Campaign not found", 404);

    if (isLockedContract(parent)) {
      return respondError(res, "Cannot resend a signed/locked contract", 400);
    }

    if (preview) {
      const tmp = buildResendChildContract(parent, {
        campaignDoc,
        contentUpdates,
        requestedEffectiveDate,
        requestedEffectiveDateTimezone,
        userEmail: req.user?.email,
        asPlain: true,
      });

      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });

      return renderPDFWithPuppeteer({
        html,
        res,
        filename: `Contract-Resend-Preview-${contractId}.pdf`,
        headerTitle: CONTRACT_PDF_TITLE,
        headerDate:
          tokens["Agreement.EffectiveDateTime"] ||
          tokens["Agreement.EffectiveDateLong"] ||
          "Pending",
      });
    }

    const child = buildResendChildContract(parent, {
      campaignDoc,
      contentUpdates,
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      userEmail: req.user?.email,
    });

    await child.save();

    parent.supersededBy = child.contractId;
    parent.resentAt = new Date();
    parent.status = CONTRACT_STATUS.SUPERSEDED;
    addAudit(parent, "system", "RESENT", {
      to: child.contractId,
      by: req.user?.email || "system",
    });
    await parent.save();

    await Campaign.updateOne(campaignQuery(parent.campaignId), {
      $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 },
    });

    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(parent.influencerId),
      type: "contract.initiated",
      title: `Contract resent by ${parent.brandName || "Brand"}`,
      message: "Updated contract is available.",
      entityType: "contract",
      entityId: String(child.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: {
        campaignId: parent.campaignId,
        brandId: parent.brandId,
        influencerId: parent.influencerId,
        resendOf: parent.contractId,
      },
    });

    await createAndEmit({
      recipientType: "brand",
      brandId: String(parent.brandId),
      type: "contract.initiated.self",
      title: "Contract resent",
      message: "You resent an updated contract to the influencer.",
      entityType: "contract",
      entityId: String(child.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${parent.campaignId}`,
      meta: {
        campaignId: parent.campaignId,
        influencerId: parent.influencerId,
        resendOf: parent.contractId,
      },
    });

    const influencerEmail = getEmailForRole({ contract: child, role: "influencer" });
    await safeSendEmail({
      contract: child,
      templateKey: "contract_new_received_influencer",
      to: influencerEmail,
      recipientRole: "influencer",
      recipientName: getNameForRole({ contract: child, role: "influencer" }),
    });

    await safeStartReminder(child, "influencer");
    await safeClearReminder(child.contractId, "brand");

    return respondOK(res, { message: "Resent contract created", contract: child }, 201);
  } catch (err) {
    return respondError(res, err.message || "resend error", err.status || 500, err);
  }
};

exports.initiateBulk = async (req, res) => {
  try {
    const {
      brandId,
      campaignId,
      influencerIds = [],
      content: contentInput = {},
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
    } = req.body;

    assertRequired(req.body, ["brandId", "campaignId"]);

    if (!Array.isArray(influencerIds) || !influencerIds.length) {
      return respondError(res, "influencerIds is required", 400);
    }

    const [campaign, brandDoc] = await Promise.all([
      Campaign.findById(campaignId),
      Brand.findById(brandId),
    ]);

    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);

    const adminTimezone =
      campaign?.campaignTimezone || requestedEffectiveDateTimezone || DEFAULT_TZ;

    const admin = {
      timezone: adminTimezone,
      jurisdiction: "USA",
      arbitrationSeat: "San Francisco, CA",
      fxSource: "ECB",
      extraRevisionFee: 0,
      escrowAMLFlags: "",
      collabglamSignatoryName: "",
      collabglamSignatoryEmail: process.env.COLLABGLAM_SIGNATORY_EMAIL || "",
      legalTemplateVersion: 1,
      legalTemplateText: MASTER_TEMPLATE,
      legalTemplateHistory: [
        {
          version: 1,
          text: MASTER_TEMPLATE,
          updatedAt: new Date(),
          updatedBy: req.user?.email || "system",
        },
      ],
    };

    const results = await Promise.allSettled(
      influencerIds.map(async (influencerId) => {
        const influencerDoc = await Influencer.findById(influencerId);
        if (!influencerDoc) {
          throw new Error(`Influencer not found: ${influencerId}`);
        }

        // remove single-influencer values from shared bulk payload
        const safeContentInput = JSON.parse(JSON.stringify(contentInput || {}));
        delete safeContentInput.influencer;

        if (safeContentInput?.scheduleA?.deliverables) {
          safeContentInput.scheduleA.deliverables =
            safeContentInput.scheduleA.deliverables.map((row, index) => ({
              ...row,
              srNo: Number(row?.srNo ?? index + 1),
              platformHandle:
                influencerDoc?.handle || influencerDoc?.profileUrl || row?.platformHandle || "",
            }));
        }

        const other = {
          brandProfile: {
            legalName: brandDoc.legalName || brandDoc.name || "",
            address: brandDoc.address || "",
            contactName: brandDoc.contactName || brandDoc.ownerName || "",
            email: brandDoc.email || "",
            country: brandDoc.country || "",
          },
          influencerProfile: {
            legalName: influencerDoc.legalName || influencerDoc.name || "",
            address: influencerDoc.address || "",
            contactName: influencerDoc.contactName || influencerDoc.name || "",
            email: influencerDoc.email || "",
            country: influencerDoc.country || "",
            handle: influencerDoc.handle || "",
          },
          autoCalcs: {},
        };

        const content = createDefaultContent({
          campaign,
          brandDoc,
          influencerDoc,
          admin,
          requestedEffectiveDate,
          requestedEffectiveDateTimezone,
          contentInput: safeContentInput,
        });

        const requestedDateBuilt = requestedEffectiveDate
          ? buildRequestedEffectiveDate(
            requestedEffectiveDate,
            requestedEffectiveDateTimezone || adminTimezone || DEFAULT_TZ
          )
          : undefined;

        const contract = new Contract({
          brandId,
          influencerId,
          campaignId,
          paymentType: getCampaignPaymentType(campaign),

          status: CONTRACT_STATUS.BRAND_SENT_DRAFT,
          awaitingRole: "influencer",
          version: 0,
          editsLockedAt: null,

          requiredSigners: ["brand", "influencer"],

          acceptances: {
            brand: { accepted: false },
            influencer: { accepted: false },
          },
          confirmations: {
            brand: { confirmed: false },
            influencer: { confirmed: false },
          },

          signatures: {
            brand: { signed: false },
            influencer: { signed: false },
            collabglam: { signed: false },
          },

          content,
          other,
          admin,

          requestedEffectiveDate: requestedDateBuilt,
          requestedEffectiveDateTimezone:
            requestedEffectiveDateTimezone || adminTimezone || DEFAULT_TZ,

          brandName: content.brand.legalName,
          brandAddress: content.brand.billingAddress,
          influencerName: content.influencer.legalName,
          influencerAddress: content.influencer.address,
          influencerHandle: content.influencer.postingHandleUrl,

          lastSentAt: new Date(),
          isAssigned: 1,
          isAccepted: 0,
          feeAmount: Number(content?.scheduleA?.commercial?.totalCampaignFee || 0),
          currency: content?.scheduleA?.commercial?.currency || "USD",
        });

        addAudit(contract, "system", "INITIATED", {
          campaignId,
          status: contract.status,
          bulk: true,
        });

        await contract.save();

        await createAndEmit({
          recipientType: "influencer",
          influencerId: String(influencerId),
          type: "contract.initiated",
          title: `Contract initiated by ${brandDoc.name || "Brand"}`,
          message: `Contract created for "${campaign.productOrServiceName || "Campaign"}".`,
          entityType: "contract",
          entityId: String(contract.contractId),
          actionPath: `/influencer/my-campaign`,
          meta: { campaignId, brandId, influencerId, bulk: true },
        });

        const infEmail = getEmailForRole({
          contract,
          role: "influencer",
          influencerDoc,
        });

        await safeSendEmail({
          contract,
          templateKey: "contract_new_received_influencer",
          to: infEmail,
          recipientRole: "influencer",
          recipientName: getNameForRole({
            contract,
            role: "influencer",
            influencerDoc,
          }),
        });

        await safeStartReminder(contract, "influencer");

        return {
          influencerId,
          contractId: contract.contractId,
        };
      })
    );

    const sent = [];
    const failed = [];

    results.forEach((r, index) => {
      if (r.status === "fulfilled") {
        sent.push(r.value);
      } else {
        failed.push({
          influencerId: influencerIds[index],
          reason: r.reason?.message || "Failed",
        });
      }
    });

    await Campaign.updateOne(campaignQuery(campaignId), {
      $set: { isContracted: 1 },
    });

    return respondOK(
      res,
      {
        message: "Bulk contract processing completed",
        sentCount: sent.length,
        sent,
        failed,
      },
      failed.length ? 207 : 201
    );
  } catch (err) {
    return respondError(res, err.message || "initiateBulk error", err.status || 500, err);
  }
};

// ============================ Timezone / Currency helpers ============================
exports.listTimezones = async (_req, res) => {
  try {
    return respondOK(res, { timezones: loadTimezones() });
  } catch (err) {
    return respondError(res, "listTimezones error", 500, err);
  }
};

exports.getTimezone = async (req, res) => {
  try {
    const { key } = req.query;
    assertRequired(req.query, ["key"]);
    const tz = findTimezoneByValueOrUTC(key);
    if (!tz) return respondError(res, "Timezone not found", 404);
    return respondOK(res, { timezone: tz });
  } catch (err) {
    return respondError(res, "getTimezone error", 500, err);
  }
};

exports.listCurrencies = async (_req, res) => {
  try {
    const data = loadCurrencies();
    const arr = Object.keys(data).map((code) => ({ code, ...data[code] }));
    return respondOK(res, { currencies: arr });
  } catch (err) {
    return respondError(res, "listCurrencies error", 500, err);
  }
};

exports.getCurrency = async (req, res) => {
  try {
    const { code } = req.query;
    assertRequired(req.query, ["code"]);
    const data = loadCurrencies();
    const cur = data[String(code).toUpperCase()];
    if (!cur) return respondError(res, "Currency not found", 404);
    return respondOK(res, { currency: { code: String(code).toUpperCase(), ...cur } });
  } catch (err) {
    return respondError(res, "getCurrency error", 500, err);
  }
};