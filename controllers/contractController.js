"use strict";

/**
 * Contract Controller (CollabGlam)
 * - PDF rendering via Puppeteer (HTML -> PDF)
 * - Versioning + acceptances + signatures workflow
 * - Email + reminders are best-effort (never break the API)
 * - Safe HTML rendering with trusted placeholders
 */

// ============================ Imports ============================
const PDFDocument = require("pdfkit");
const moment = require("moment-timezone");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

// Models & template
const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const Contract = require("../models/contract");
const MASTER_TEMPLATE = require("../template/ContractTemplate");

const { createAndEmit } = require("../utils/notifier");
const { CONTRACT_STATUS } = require("../constants/contract");

// Optional email + reminders (best effort)
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

const MAX_SIG_BYTES = 50 * 1024;

const ALLOWED_BRAND_KEYS = [
  "campaignTitle",
  "platforms",
  "goLive",
  "totalFee",
  "currency",
  "milestoneSplit",
  "usageBundle",
  "revisionsIncluded",
  "deliverablesPresetKey",
  "deliverablesExpanded",
  "requestedEffectiveDate",
  "requestedEffectiveDateTimezone",
];

const ALLOWED_INFLUENCER_KEYS = [
  "shippingAddress",
  "dataAccess",
  "taxFormType",
  "legalName",
  "email",
  "phone",
  "taxId",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "country",
  "notes",
];

// --- Fixed CollabGlam dummy signature (always shown in PDF) ---
const COLLABGLAM_SIG_FILE = path.join(__dirname, "..", "assets", "collabglam-signature.png");
let COLLABGLAM_FIXED_SIG_DATA_URL = process.env.COLLABGLAM_FIXED_SIG_DATA_URL || null;

(function loadCollabGlamSig() {
  if (COLLABGLAM_FIXED_SIG_DATA_URL) return;
  try {
    if (fs.existsSync(COLLABGLAM_SIG_FILE)) {
      const buf = fs.readFileSync(COLLABGLAM_SIG_FILE);
      COLLABGLAM_FIXED_SIG_DATA_URL = `data:image/png;base64,${buf.toString("base64")}`;
      console.log("[Contract] Loaded fixed CollabGlam signature:", COLLABGLAM_SIG_FILE);
    } else {
      console.warn("[Contract] CollabGlam signature file not found:", COLLABGLAM_SIG_FILE);
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

// ============================ File caches ============================
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

// ============================ Time / Locale Helpers ============================
const tzOr = (contract, fallback = DEFAULT_TZ) =>
  contract?.requestedEffectiveDateTimezone ||
  contract?.effectiveDateTimezone ||
  contract?.admin?.timezone ||
  fallback;

function nowInContractTz(contract) {
  return moment.tz(tzOr(contract)).toDate();
}

/**
 * Build a "date-only" effective date in a given timezone.
 * Input may be yyyy-mm-dd or ISO string; stores Date object that matches "today at now-time" in that tz.
 */
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

function formatInfluencerAddressLines(inf = {}) {
  const line1 = inf.addressLine1 || "";
  const line2 = inf.addressLine2 || "";
  const cityStateZip = compactJoin(
    [compactJoin([inf.city, inf.state], ", "), inf.postalCode],
    " "
  );
  const country = inf.country || "";
  return compactJoin([line1, line2, cityStateZip, country], ", ");
}

function formatDateTZ(date, tz, fmt = "MMMM D, YYYY") {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);

  // Treat UTC midnight as "date-only" to avoid shifting
  const isDateOnlyUTC =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;

  if (isDateOnlyUTC) return moment.utc(d).format(fmt);
  return tz ? moment(d).tz(tz).format(fmt) : moment(d).format(fmt);
}

// ============================ HTML Blocks (Trusted) ============================
function buildInfluencerAcceptanceTableHTML(inf = {}) {
  const cells = {
    legalName: esc(inf.legalName || ""),
    email: esc(inf.email || ""),
    phone: esc(inf.phone || ""),
    taxId: esc(inf.taxId || ""),
    addressLine1: esc(inf.addressLine1 || ""),
    addressLine2: esc(inf.addressLine2 || ""),
    city: esc(inf.city || ""),
    state: esc(inf.state || ""),
    postalCode: esc(inf.postalCode || ""),
    country: esc(inf.country || ""),
    notes: esc(inf.notes || ""),
  };

  return `
<table border="0" cellpadding="6" cellspacing="0" style="width:100%; border-collapse:collapse;">
  <tr><td style="width:35%; vertical-align:top;"><strong>Legal Name</strong></td><td style="vertical-align:top;">${cells.legalName}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Tax ID (optional)</strong></td><td style="vertical-align:top;">${cells.taxId}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Address Line 1</strong></td><td style="vertical-align:top;">${cells.addressLine1}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Address Line 2</strong></td><td style="vertical-align:top;">${cells.addressLine2}</td></tr>
  <tr><td style="vertical-align:top;"><strong>City</strong></td><td style="vertical-align:top;">${cells.city}</td></tr>
  <tr><td style="vertical-align:top;"><strong>State</strong></td><td style="vertical-align:top;">${cells.state}</td></tr>
  <tr><td style="vertical-align:top;"><strong>ZIP / Postal Code</strong></td><td style="vertical-align:top;">${cells.postalCode}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Country</strong></td><td style="vertical-align:top;">${cells.country}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Notes (optional)</strong></td><td style="vertical-align:top;">${cells.notes}</td></tr>
</table>`.trim();
}

function legalTextToHTML(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = [];
  let buffer = [];
  let consumedTitle = false;
  let inSchedules = false;
  let afterBOpen = false;

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

    if (!consumedTitle && /Agreement/i.test(line) && line.length > 30) {
      flushP();
      out.push(`<h1>${esc(line)}</h1>`);
      consumedTitle = true;
      continue;
    }

    const sch = line.match(/^Schedule\s+([A-Z])\s+–\s+(.+)$/);
    if (sch) {
      flushP();
      if (afterBOpen) {
        out.push("</div>");
        afterBOpen = false;
      }
      const letter = sch[1];
      inSchedules = true;

      if (letter >= "C") {
        out.push('<div class="afterB">');
        afterBOpen = true;
      }
      out.push(`<h3>Schedule ${esc(letter)} – ${esc(sch[2])}</h3>`);
      continue;
    }

    if (/^Signatures$/i.test(line)) {
      flushP();
      out.push("<h2>Signatures</h2>");
      out.push('<div id="__SIG_PANEL__"></div>');
      continue;
    }

    const sec = line.match(/^(\d+)\.\s+(.+)$/);
    if (sec && !inSchedules) {
      flushP();
      out.push(`<h2><span class="secno">${esc(sec[1])}.</span> ${esc(sec[2])}</h2>`);
      continue;
    }
    if (sec && inSchedules) {
      flushP();
      out.push(`<p class="numli"><span class="marker">${esc(sec[1])}.</span> ${esc(sec[2])}</p>`);
      continue;
    }

    const letm = line.match(/^([a-z])\.\s+(.+)$/i);
    if (letm) {
      flushP();
      out.push(`<p class="subli"><span class="marker">${esc(letm[1])}.</span> ${esc(letm[2])}</p>`);
      continue;
    }

    const bul = line.match(/^[-•]\s+(.+)$/);
    if (bul) {
      flushP();
      out.push(`<p class="bull"><span class="marker">•</span> ${esc(bul[1])}</p>`);
      continue;
    }

    buffer.push(rawLine);
  }

  flushP();
  if (!consumedTitle) out.unshift("<h1>Master Brand–Influencer Agreement</h1>");
  if (afterBOpen) out.push("</div>");
  return out.join("\n");
}

function getBrandSelectedEffectiveDate(contract) {
  return contract?.requestedEffectiveDate || contract?.brand?.requestedEffectiveDate || null;
}

function signaturePanelHTML(contract) {
  const tz = tzOr(contract);

  const roles = [
    {
      key: "brand",
      label: `Brand: ${esc(contract.other?.brandProfile?.legalName || contract.brandName || "—")}`,
    },
    {
      key: "influencer",
      label: `Influencer: ${esc(
        contract.other?.influencerProfile?.legalName || contract.influencerName || "—"
      )}`,
    },
    { key: "collabglam", label: "CollabGlam: CollabGlam LLC" },
  ];

  const blocks = roles
    .map(({ key, label }) => {
      const s = contract.signatures?.[key] || {};
      const when = s.at ? formatDateTZ(s.at, tz, "YYYY-MM-DD HH:mm z") : "";

      const isCollabGlam = key === "collabglam";
      const imgSrc = s.sigImageDataUrl || (isCollabGlam ? COLLABGLAM_FIXED_SIG_DATA_URL : null);
      const img = imgSrc ? `<img class="sigimg" alt="Signature image" src="${esc(imgSrc)}">` : "";

      const meta = s.signed
        ? `<div class="sigmeta">SIGNED by ${esc(s.name || "")}${s.email ? ` &lt;${esc(s.email)}&gt;` : ""
        }${when ? ` on ${esc(when)}` : ""}</div>`
        : isCollabGlam && imgSrc
          ? `<div class="sigmeta muted">Signature on file (CollabGlam)</div>`
          : `<div class="sigmeta muted">Pending signature</div>`;

      return `
      <div class="signature-block">
        <div class="sigrole">${label}</div>
        ${img}
        ${meta}
      </div>`;
    })
    .join("");

  return `<div class="signatures">${blocks}</div>`;
}

// ============================ Business Day Utilities ============================
function businessDaysShift(date, delta) {
  let d = new Date(date || Date.now());
  let remaining = Math.abs(Number(delta) || 0);
  // positive delta => go backwards; negative delta => go forwards
  const dir = delta >= 0 ? -1 : 1;
  while (remaining > 0) {
    d.setDate(d.getDate() + dir);
    const day = d.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return d;
}

function clampDraftDue(goLiveStart, now = new Date()) {
  const ideal = businessDaysShift(goLiveStart || now, 7); // 7 business days before go-live
  const floor = businessDaysShift(now, -2); // at least +2 business days from now
  return ideal < floor ? floor : ideal;
}

// ============================ Deliverables Normalization / Render ============================
const fmtBool = (v) => (v ? "Yes" : "No");
const fmtList = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).join(", ") : "");

function normalizeDeliverable(d = {}, opts = {}) {
  const nd = { ...d };

  nd.whitelistingEnabled = d.whitelistingEnabled ?? d.whitelisting ?? false;
  nd.sparkAdsEnabled = d.sparkAdsEnabled ?? d.sparkAds ?? false;

  if (opts.enforcedHandle) {
    nd.handles = [opts.enforcedHandle];
  } else if (!Array.isArray(nd.handles)) {
    nd.handles = [];
  }

  if (nd.draftRequired && !nd.draftDueDate) nd.draftDueDate = opts.draftDue || null;
  if (nd.revisionRoundsIncluded === undefined) nd.revisionRoundsIncluded = opts.defaultRevRounds ?? 1;
  if (nd.additionalRevisionFee === undefined) nd.additionalRevisionFee = opts.extraRevisionFee ?? 0;

  if (
    nd.liveRetentionMonths === "-" ||
    nd.liveRetentionMonths === "" ||
    nd.liveRetentionMonths === null ||
    nd.liveRetentionMonths === undefined
  ) {
    nd.liveRetentionMonths = undefined;
  } else if (typeof nd.liveRetentionMonths === "string") {
    const parsed = Number(nd.liveRetentionMonths);
    nd.liveRetentionMonths = Number.isFinite(parsed) ? parsed : undefined;
  }

  return nd;
}

function normalizeDeliverablesArray(arr = [], opts = {}) {
  return (Array.isArray(arr) ? arr : []).map((d) => normalizeDeliverable(d, opts));
}

function renderDeliverablesTable(delivs = [], tz) {
  if (!delivs.length) return '<p class="muted">No deliverables defined.</p>';

  const ensureAt = (s) => {
    const t = (s || "").trim();
    return t ? (t.startsWith("@") ? t : `@${t}`) : "";
  };

  const fmtHandles = (arr) => {
    const list = Array.isArray(arr) ? arr.map(ensureAt).filter(Boolean) : [];
    return list.length ? fmtList(list) : "";
  };

  const fmtRetention = (d) => {
    if (d.liveRetentionMonths !== undefined && d.liveRetentionMonths !== null) {
      const m = Number(d.liveRetentionMonths);
      return Number.isFinite(m) ? `${m} month${m === 1 ? "" : "s"}` : "";
    }
    if (d.minLiveHours !== undefined && d.minLiveHours !== null) {
      const h = Number(d.minLiveHours);
      return Number.isFinite(h) ? `${h} hour${h === 1 ? "" : "s"}` : "";
    }
    return "";
  };

  const row = (label, val, { keepWhenEmpty = false } = {}) =>
    keepWhenEmpty || (val !== "" && val !== null && val !== undefined)
      ? `<tr><td><strong>${label}</strong></td><td>${val}</td></tr>`
      : "";

  const colgroup = `
    <colgroup>
      <col style="width:30%;">
      <col style="width:70%;">
    </colgroup>
  `.trim();

  const groups = delivs
    .map((d, i) => {
      const idx = i + 1;

      const type = esc(d.type || "");
      const qty = d.quantity === 0 || d.quantity ? esc(String(d.quantity)) : "";
      const format = esc(d.format || "");
      const durSec = d.durationSec === 0 || d.durationSec ? esc(String(d.durationSec)) : "";

      const pwStart = d?.postingWindow?.start ? formatDateTZ(d.postingWindow.start, tz) : "";
      const pwEnd = d?.postingWindow?.end ? formatDateTZ(d.postingWindow.end, tz) : "";
      const posting = esc(`${pwStart}${pwStart && pwEnd ? " – " : ""}${pwEnd}`);

      const draftDue = d?.draftDueDate ? formatDateTZ(d.draftDueDate, tz) : "";
      const draftCell = `${fmtBool(d.draftRequired)}${draftDue ? `<br><span class="muted">Due: ${esc(draftDue)}</span>` : ""
        }`;

      const revisionsInc = d.revisionRoundsIncluded ?? d.revisionsIncluded;
      const extraRevFee = d.additionalRevisionFee;
      const retention = esc(fmtRetention(d));

      const tags = esc(fmtList(d?.tags));
      const handles = esc(fmtHandles(d?.handles));
      const captions = esc(d.captions || "");
      const disclosures = esc(d.disclosures || "");

      const links =
        Array.isArray(d?.links) && d.links.length
          ? d.links.map((x) => esc(String(x))).join(", ")
          : "";

      const whitelist = d.whitelistingEnabled ?? d.whitelisting ?? false;
      const sparkAds = d.sparkAdsEnabled ?? d.sparkAds ?? false;
      const wlSpark = `${fmtBool(whitelist)} / ${fmtBool(sparkAds)}`;

      const header = `
      <tr class="deliv-head">
        <th colspan="2">Deliverable ${idx}</th>
      </tr>`;

      const rowsHtml = [
        row("Type", type, { keepWhenEmpty: true }),
        row("Quantity", qty, { keepWhenEmpty: true }),
        row("Format", format, { keepWhenEmpty: true }),
        row("Duration (sec)", durSec),
        row("Posting Window", posting, { keepWhenEmpty: true }),
        row("Draft Required / Due", draftCell, { keepWhenEmpty: true }),
        row("Revisions Included", revisionsInc === 0 || revisionsInc ? esc(String(revisionsInc)) : ""),
        row("Extra Revision Fee", extraRevFee === 0 || extraRevFee ? esc(String(extraRevFee)) : ""),
        row("Live Retention", retention),
        row("Tags", tags),
        row("Handles", handles),
        row("Captions", captions),
        row("Links", links),
        row("Disclosures", disclosures),
        row("Whitelist / Spark", wlSpark, { keepWhenEmpty: true }),
      ].join("");

      return `
      <tbody class="block-avoid">
        ${header}
        ${rowsHtml}
      </tbody>`;
    })
    .join("");

  return `
    <table class="table--condensed deliverables-table">
      ${colgroup}
      <thead>
        <tr><th>Field</th><th>Value</th></tr>
      </thead>
      ${groups}
    </table>
  `.trim();
}

function renderUsageBundleTokens(ub = {}, currency = "USD") {
  const geos = fmtList(ub.geographies);
  const spendCap =
    ub.spendCap || ub.spendCap === 0
      ? `${Number(ub.spendCap).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`
      : "—";

  const summary = `
    <p>
      <strong>Type:</strong> ${esc(ub.type || "Organic")} |
      <strong>Duration:</strong> ${esc(ub.durationMonths ?? "—")} months |
      <strong>Geographies:</strong> ${esc(geos || "—")} |
      <strong>Derivative Edits:</strong> ${fmtBool(ub.derivativeEditsAllowed)} |
      <strong>Spend Cap:</strong> ${esc(spendCap)}
      ${ub.audienceRestrictions
      ? `<br><strong>Audience Restrictions:</strong> ${esc(ub.audienceRestrictions)}`
      : ""
    }
    </p>`.trim();

  const table = `
    <table>
      <thead>
        <tr><th>Type</th><th>Duration (months)</th><th>Geographies</th><th>Derivative Edits</th><th>Spend Cap</th><th>Audience Restrictions</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>${esc(ub.type || "Organic")}</td>
          <td>${esc(ub.durationMonths ?? "—")}</td>
          <td>${esc(geos || "—")}</td>
          <td>${fmtBool(ub.derivativeEditsAllowed)}</td>
          <td>${esc(spendCap)}</td>
          <td>${esc(ub.audienceRestrictions || "—")}</td>
        </tr>
      </tbody>
    </table>`.trim();

  return {
    "Usage.LicenseType": ub.type || "Organic",
    "Usage.Type": ub.type || "Organic",
    "Usage.DurationMonths": ub.durationMonths ?? "",
    "Usage.Geographies": geos,
    "Usage.DerivativeEditsAllowed": fmtBool(ub.derivativeEditsAllowed),
    "Usage.SpendCap": spendCap,
    "Usage.AudienceRestrictions": ub.audienceRestrictions || "",
    "Usage.BundleSummary": summary,
    "Usage.BundleTableHTML": table,
  };
}

// ============================ Token Plumbing ============================
function buildTokenMap(contract) {
  const tz = tzOr(contract);

  const brandProfile = contract.other?.brandProfile || {};
  const inflProfile = contract.other?.influencerProfile || {};
  const infData = contract.influencer || {};
  const b = contract.brand || {};
  const admin = contract.admin || {};

  const influencerFields = {
    legalName: infData.legalName || inflProfile.legalName || contract.influencerName || "",
    contactName: inflProfile.contactName || contract.influencerName || "",
    email: infData.email || inflProfile.email || "",
    phone: infData.phone || "",
    taxId: infData.taxId || "",
    addressLine1: infData.addressLine1 || "",
    addressLine2: infData.addressLine2 || "",
    city: infData.city || "",
    state: infData.state || "",
    postalCode: infData.postalCode || infData.zip || "",
    country: infData.country || inflProfile.country || "",
    notes: infData.notes || "",
    legacyAddress: inflProfile.address || contract.influencerAddress || "",
  };

  const addressFormatted =
    formatInfluencerAddressLines(influencerFields) || influencerFields.legacyAddress || "";
  const acceptanceTableHTML = buildInfluencerAcceptanceTableHTML(influencerFields);

  const channels = (b.platforms || []).join(", ");
  const displayDate = getBrandSelectedEffectiveDate(contract) || contract.effectiveDate || null;

  const tokens = {
    "Agreement.EffectiveDate": displayDate ? formatDateTZ(displayDate, tz) : "",
    "Agreement.EffectiveDateLong": displayDate ? formatDateTZ(displayDate, tz, "Do MMMM YYYY") : "",
    "Agreement.EffectiveDateTime": displayDate
      ? formatDateTZ(displayDate, tz, "MMMM D, YYYY HH:mm z")
      : "",

    "Brand.LegalName": brandProfile.legalName || contract.brandName || "",
    "Brand.Address": brandProfile.address || contract.brandAddress || "",
    "Brand.ContactName": brandProfile.contactName || "",

    "Influencer.LegalName": influencerFields.legalName,
    "Influencer.ContactName": influencerFields.contactName,
    "Influencer.Email": influencerFields.email,
    "Influencer.Phone": influencerFields.phone,
    "Influencer.TaxId": influencerFields.taxId,
    "Influencer.AddressLine1": influencerFields.addressLine1,
    "Influencer.AddressLine2": influencerFields.addressLine2,
    "Influencer.City": influencerFields.city,
    "Influencer.State": influencerFields.state,
    "Influencer.PostalCode": influencerFields.postalCode,
    "Influencer.Country": influencerFields.country,
    "Influencer.Notes": influencerFields.notes,
    "Influencer.AddressFormatted": addressFormatted,
    "Influencer.Address": addressFormatted,
    "Influencer.AcceptanceDetailsTableHTML": acceptanceTableHTML,

    "CollabGlam.Address": "548 Market St, San Francisco, CA 94104, USA",
    "CollabGlam.SignatoryName": admin.collabglamSignatoryName || "",
    "Time.StandardTimezone": admin.timezone || tz,
    "Time.StandardJurisdiction": admin.jurisdiction || "USA",
    "Arbitration.Seat": admin.arbitrationSeat || "San Francisco, CA",
    "Payments.FXSource": admin.fxSource || "ECB",

    "Campaign.Title": b.campaignTitle || "",
    "Campaign.Territory": "Worldwide",
    "Campaign.Channels": channels,
    "Campaign.Platforms": channels,

    "Campaign.Timeline.GoLiveWindowStart": b?.goLive?.start ? formatDateTZ(b.goLive.start, tz) : "",
    "Campaign.Timeline.GoLiveWindowEnd": b?.goLive?.end ? formatDateTZ(b.goLive.end, tz) : "",

    "Approval.BrandResponseWindow": admin.defaultBrandReviewWindowBDays ?? 2,
    "Approval.RoundsIncluded": b.revisionsIncluded ?? 1,
    "Approval.AdditionalRevisionFee": admin.extraRevisionFee ?? 0,

    "Comp.TotalFee": b.totalFee ?? 0,
    "Comp.Currency": b.currency || "USD",
    "Comp.MilestoneSplit": b.milestoneSplit || "50/50",
    "Comp.NetTerms": "Net 15",
    "Comp.PaymentMethod": "Escrow via CollabGlam",

    "Exclusivity.WindowHoursAfterPost": 0,
    "ProductShipment.RequiredDate":
      b?.deliverablesExpanded?.[0]?.postingWindow?.start
        ? formatDateTZ(b.deliverablesExpanded[0].postingWindow.start, tz)
        : "",
    "ProductShipment.ReturnRequired": "No",

    "SOW.DeliverablesTableHTML": renderDeliverablesTable(b.deliverablesExpanded || [], tz),
  };

  Object.assign(tokens, renderUsageBundleTokens(b.usageBundle || {}, tokens["Comp.Currency"]) || {});

  // Optional per-deliverable token expansion (for older templates)
  const delivs = Array.isArray(b.deliverablesExpanded) ? b.deliverablesExpanded : [];
  const setDeliv = (key, val) => {
    tokens[key] = val === undefined || val === null ? "" : String(val);
  };

  delivs.forEach((d, i) => {
    const idx0 = i;
    const idx1 = i + 1;
    const wl = d.whitelistingEnabled ?? d.whitelisting ?? false;
    const sp = d.sparkAdsEnabled ?? d.sparkAds ?? false;

    const keys = [
      ["Type", d?.type],
      ["Quantity", d?.quantity],
      ["DurationSec", d?.durationSec],
      ["PostingWindowStart", d?.postingWindow?.start ? formatDateTZ(d.postingWindow.start, tz) : ""],
      ["PostingWindowEnd", d?.postingWindow?.end ? formatDateTZ(d.postingWindow.end, tz) : ""],
      ["DraftRequired", fmtBool(d?.draftRequired)],
      ["DraftDueDate", d?.draftDueDate ? formatDateTZ(d.draftDueDate, tz) : ""],
      ["RevisionRoundsIncluded", d?.revisionRoundsIncluded ?? ""],
      ["AdditionalRevisionFee", d?.additionalRevisionFee ?? ""],
      ["LiveRetentionMonths", d?.liveRetentionMonths ?? ""],
      ["TagsHandles", [fmtList(d?.tags), fmtList(d?.handles)].filter(Boolean).join(" / ")],
      ["WhitelistEnabled", fmtBool(wl)],
      ["SparkAdsEnabled", fmtBool(sp)],
    ];

    keys.forEach(([leaf, val]) => {
      setDeliv(`Deliverables[${idx0}].${leaf}`, val);
      setDeliv(`Deliverables.${idx0}.${leaf}`, val);
      setDeliv(`Deliverables[${idx1}].${leaf}`, val);
      setDeliv(`Deliverables.${idx1}.${leaf}`, val);
    });
  });

  tokens["Deliverables.Count"] = String(delivs.length);
  return tokens;
}

function renderTemplate(templateText, tokenMap) {
  return (templateText || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, rawKey) => {
    // support {{ Key (optional stuff) }}
    const key = rawKey.replace(/\s*\(.*?\)\s*$/, "");
    const v = tokenMap[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function injectTrustedHtmlPlaceholders(legalHTML, contract) {
  const tokens = buildTokenMap(contract);
  const swaps = [
    { key: "[[SOW.DeliverablesTableHTML]]", html: tokens["SOW.DeliverablesTableHTML"] || "" },
    { key: "[[Usage.BundleSummary]]", html: tokens["Usage.BundleSummary"] || "" },
    { key: "[[Usage.BundleTableHTML]]", html: tokens["Usage.BundleTableHTML"] || "" },
    {
      key: "[[Influencer.AcceptanceDetailsTableHTML]]",
      html: tokens["Influencer.AcceptanceDetailsTableHTML"] || "",
    },
  ];

  let out = legalHTML;

  for (const { key, html } of swaps) {
    if (!html) continue;

    out = out.replaceAll(key, html);

    // also replace <p>[[TOKEN]]</p>
    const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wrapped = new RegExp(`<p>\\s*${escKey}\\s*<\\/p>`, "g");
    out = out.replace(wrapped, html);
  }

  return out;
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

    h1 { page-break-after: avoid; break-after: avoid-page; }
    h2, h3 { page-break-after: auto; break-after: auto; }

    p { margin: 0 0 5pt; text-align: justify; color: #000; orphans: 3; widows: 3; }

    .numli, .subli, .bull { text-align: justify; padding-left: 18pt; text-indent: -18pt; margin-bottom: 4pt; }
    .marker { display: inline-block; width: 18pt; }
    .secno { font-weight: 700; }
    .muted { color: #444; }

    .signatures { margin: 10pt 0 6pt; display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
    .signature-block { border: 1px solid #000; padding: 8pt; break-inside: avoid; page-break-inside: avoid; }
    .sigrole { font-weight: 700; margin-bottom: 4pt; }
    .sigimg { display: block; max-height: 60pt; max-width: 100%; margin: 0 0 6pt; }
    .sigmeta { font-size: 9.5pt; color: #000; }

    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9.5pt; margin: 6pt 0; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
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

    .table--condensed th, .table--condensed td { padding: 3pt 3.5pt; font-size: 9pt; line-height: 1.3; }
    .deliverables-table th, .deliverables-table td { white-space: normal; }

    .afterB p { margin-bottom: 5pt; }

    .block-avoid, .signature-block { break-inside: avoid; page-break-inside: avoid; }
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
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions"],
    timeout: 60000,
  };

  const execPath = process.env.CHROME_EXECUTABLE_PATH;

  if (execPath && fs.existsSync(execPath)) {
    console.log("[PDF] Using CHROME_EXECUTABLE_PATH:", execPath);
    try {
      return await puppeteer.launch({ ...baseOptions, executablePath: execPath });
    } catch (err) {
      console.error("[PDF] Launch with CHROME_EXECUTABLE_PATH failed, falling back", err);
    }
  } else if (execPath) {
    console.warn("[PDF] CHROME_EXECUTABLE_PATH does not exist:", execPath);
  } else {
    console.log("[PDF] No CHROME_EXECUTABLE_PATH set, using default Chromium.");
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

async function renderPDFWithPuppeteer({ html, res, filename = "Contract.pdf", headerTitle, headerDate }) {
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

    const needsLandscape = /data-require-landscape="1"/i.test(html);

    const pdf = await page.pdf({
      preferCSSPageSize: true,
      format: "A4",
      landscape: needsLandscape,
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

    // Fallback: plain-text PDF
    try {
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=${filename}`);

      doc.pipe(res);

      doc.fontSize(18).text(headerTitle || "Master Brand–Influencer Agreement", { align: "center" }).moveDown();

      const plain = String(html || "")
        .replace(/<\/(p|div|h1|h2|h3|br)>/gi, "\n\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\n{3,}/g, "\n\n");

      const paragraphs = plain.split(/\n\s*\n/);
      paragraphs.forEach((p, idx) => {
        doc.text(p.trim(), { align: "justify" });
        if (idx < paragraphs.length - 1) doc.moveDown();
      });

      doc.end();
      return;
    } catch (fallbackErr) {
      console.error("[PDF] PDFKit fallback failed:", fallbackErr?.message || fallbackErr);
      return respondError(res, "PDF generation failed", 500, fallbackErr);
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_e) { }
    }
  }
}

// ============================ Audit / Diff / Versioning ============================
function addAudit(contract, role, type, details = {}) {
  contract.audit = contract.audit || [];
  contract.audit.push({ type, role: role || "system", details });
  contract.lastActionAt = new Date();
  contract.lastActionByRole = role || "system";
}

function flatten(obj, prefix = "") {
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      Object.assign(out, flatten(v, p));
    } else {
      out[p] = v;
    }
  });
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

function bumpVersion(contract, byRole, byUserId, editedFields) {
  const nextVersion = Number(contract.version || 0) + 1;
  contract.version = nextVersion;

  const snapshot = {
    version: nextVersion,
    status: contract.status,
    awaitingRole: contract.awaitingRole,
    requestedEffectiveDate: contract.requestedEffectiveDate,
    requestedEffectiveDateTimezone: contract.requestedEffectiveDateTimezone,
    brand: contract.brand,
    influencer: contract.influencer,
    admin: contract.admin,
    other: {
      brandProfile: contract.other?.brandProfile,
      influencerProfile: contract.other?.influencerProfile,
      autoCalcs: contract.other?.autoCalcs,
    },
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

// required signers: allow per-contract override
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
  const sigs = contract.signatures || {};
  return requiredSigners(contract).every((r) => Boolean(sigs?.[r]?.signed));
}

function hasAcceptedCurrent(contract, role) {
  const v = Number(contract.version || 0);
  const a = contract.acceptances?.[role];
  return Boolean(a?.accepted && Number(a?.acceptedVersion) === v);
}

function markAccepted(contract, role, byUserId) {
  const v = Number(contract.version || 0);

  contract.acceptances = contract.acceptances || {};
  contract.confirmations = contract.confirmations || {}; // legacy support

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

function markEdit(contract, byRole, byUserId, editedFields) {
  if (!Array.isArray(editedFields) || editedFields.length === 0) return;

  contract.isEdit = true;
  contract.isEditBy = byRole;
  contract.editedFields = editedFields;
  contract.lastEdit = { isEdit: true, by: byRole, at: new Date(), fields: editedFields };

  bumpVersion(contract, byRole, byUserId, editedFields);
  addAudit(contract, byRole, "EDITED", { fields: editedFields });
}

function resetAcceptancesForNewVersion(contract) {
  contract.acceptances = contract.acceptances || {};
  contract.confirmations = contract.confirmations || {};

  contract.acceptances.brand = { ...(contract.acceptances.brand || {}), accepted: false };
  contract.acceptances.influencer = { ...(contract.acceptances.influencer || {}), accepted: false };

  contract.confirmations.brand = { confirmed: false };
  contract.confirmations.influencer = { confirmed: false };

  // New version => signing lock cleared + signatures cleared
  contract.editsLockedAt = null;

  contract.signatures = contract.signatures || {};
  for (const k of Object.keys(contract.signatures)) {
    contract.signatures[k] = { ...(contract.signatures[k] || {}), signed: false };
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

// Single source of truth for status/awaitingRole once acceptances change
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

  contract.statusFlags.awaitingCollabglam = false;
  contract.awaitingRole = contract.awaitingRole || "influencer";
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
    getBrandSelectedEffectiveDate(contract) ||
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

// ============================ Resend helper ============================
function buildResendChildContract(
  parentDoc,
  {
    brandInput = {},
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

  const mergedBrand = { ...(parent?.brand || {}), ...(brandInput || {}) };

  const enforcedHandle =
    parent?.influencerHandle ||
    parent?.other?.influencerProfile?.handle ||
    "";

  const goLiveStart = mergedBrand?.goLive?.start || parent?.brand?.goLive?.start || new Date();
  const draftDue = clampDraftDue(goLiveStart);

  let deliverablesExpanded = Array.isArray(mergedBrand.deliverablesExpanded)
    ? mergedBrand.deliverablesExpanded
    : (parent?.brand?.deliverablesExpanded || []);

  deliverablesExpanded = normalizeDeliverablesArray(deliverablesExpanded, {
    enforcedHandle,
    draftDue,
    defaultRevRounds: mergedBrand.revisionsIncluded ?? parent?.brand?.revisionsIncluded ?? 1,
    extraRevisionFee: parent?.admin?.extraRevisionFee ?? 0,
  });

  mergedBrand.deliverablesExpanded = deliverablesExpanded;

  const other = { ...(parent?.other || {}) };
  other.autoCalcs = { ...(parent?.other?.autoCalcs || {}) };
  other.autoCalcs.firstDraftDue = draftDue;
  other.autoCalcs.tokensExpandedAt = new Date();

  const childData = {
    brandId: parent.brandId,
    influencerId: parent.influencerId,
    campaignId: parent.campaignId,

    status: CONTRACT_STATUS.BRAND_SENT_DRAFT,
    awaitingRole: "influencer",

    version: 0,
    editsLockedAt: null,
    versions: [],

    requiredSigners: Array.isArray(parent.requiredSigners) && parent.requiredSigners.length
      ? parent.requiredSigners
      : ["brand", "influencer"],

    acceptances: { brand: { accepted: false }, influencer: { accepted: false } },
    confirmations: { brand: { confirmed: false }, influencer: { confirmed: false } },

    signatures: {
      brand: { signed: false },
      influencer: { signed: false },
      collabglam: { signed: false },
    },

    brand: mergedBrand,
    influencer: {},

    other,
    admin: parent.admin,

    requestedEffectiveDate: requestedDateBuilt,
    requestedEffectiveDateTimezone: tz,

    brandName: parent.brandName,
    brandAddress: parent.brandAddress,
    influencerName: parent.influencerName,
    influencerAddress: parent.influencerAddress,
    influencerHandle: parent.influencerHandle,

    lastSentAt: new Date(),
    lastViewedAt: { brand: null, influencer: null },
    reminders: { brand: {}, influencer: {} },
    emailLog: [],
    milestonesCreatedAt: null,
    milestones: [],

    isAssigned: 1,
    isAccepted: 0,
    isRejected: 0,
    feeAmount: Number(mergedBrand.totalFee ?? parent.feeAmount ?? 0),
    currency: mergedBrand.currency || parent.currency || "USD",

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

// ============================ Campaign helper ============================
function campaignQuery(campaignId) {
  return { $or: [{ campaignId }, { campaignsId: campaignId }] };
}

// ============================ Email / Reminder wrappers ============================
async function safeSendEmail({ contract, templateKey, to, recipientRole, recipientName }) {
  if (!sendContractEmail) return;
  if (!to) return;
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

// ============================ Role helpers ============================
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
      (contract?.other?.brandProfile?.email || "").trim() ||
      (brandDoc?.email || "").trim() ||
      ""
    );
  }
  if (role === "influencer") {
    return (
      (contract?.other?.influencerProfile?.email || "").trim() ||
      (influencerDoc?.email || "").trim() ||
      ""
    );
  }
  if (role === "collabglam") {
    return (
      (contract?.admin?.collabglamSignatoryEmail || "").trim() ||
      (process.env.COLLABGLAM_SIGNATORY_EMAIL || "").trim() ||
      ""
    );
  }
  return "";
}

function getNameForRole({ contract, role, brandDoc, influencerDoc }) {
  if (role === "brand") {
    return (
      contract?.other?.brandProfile?.contactName ||
      contract?.brandName ||
      brandDoc?.name ||
      brandDoc?.legalName ||
      "Brand"
    );
  }
  if (role === "influencer") {
    return (
      contract?.other?.influencerProfile?.contactName ||
      contract?.influencerName ||
      influencerDoc?.name ||
      influencerDoc?.legalName ||
      "Influencer"
    );
  }
  if (role === "collabglam") {
    return contract?.admin?.collabglamSignatoryName || "CollabGlam";
  }
  return "User";
}

// ============================ Signature payload validation ============================
function parseSignatureImage({ signatureImageDataUrl, signatureImageBase64, signatureImageMime }) {
  if (!signatureImageDataUrl && !signatureImageBase64) return null;

  let mime = "image/png";
  let base64 = "";

  if (signatureImageDataUrl) {
    const m = String(signatureImageDataUrl).match(/^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/i);
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

// ============================ Controllers ============================

// -------------------- INITIATE --------------------
exports.initiate = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      campaignId,
      brand: brandInput = {},
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      preview = false,
      isResend = false,
      resendOf,
    } = req.body;

    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);

    const [campaign, brandDoc, influencerDoc] = await Promise.all([
      Campaign.findOne(campaignQuery(campaignId)),
      Brand.findOne({ brandId }),
      Influencer.findOne({ influencerId }),
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

    const adminTimezone = campaign?.timezone || requestedEffectiveDateTimezone || DEFAULT_TZ;

    const admin = {
      timezone: adminTimezone,
      jurisdiction: "USA",
      arbitrationSeat: "San Francisco, CA",
      fxSource: "ECB",
      defaultBrandReviewWindowBDays: 2,
      extraRevisionFee: 0,
      escrowAMLFlags: "",
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

    let deliverablesExpanded =
      Array.isArray(brandInput.deliverablesExpanded) && brandInput.deliverablesExpanded.length
        ? brandInput.deliverablesExpanded
        : [
          {
            type: "Video",
            quantity: 1,
            format: "MP4",
            durationSec: 60,
            postingWindow: { start: brandInput.goLive?.start, end: brandInput.goLive?.end },
            draftRequired: (brandInput.revisionsIncluded ?? 1) > 0,
            minLiveHours: 720,
            revisionRoundsIncluded: brandInput.revisionsIncluded ?? 1,
            additionalRevisionFee: admin.extraRevisionFee ?? 0,
            tags: [],
            handles: [],
            captions: "",
            links: [],
            disclosures: "#ad",
            whitelistingEnabled: false,
            sparkAdsEnabled: false,
          },
        ];

    const draftDue = clampDraftDue(brandInput.goLive?.start || new Date());
    const enforcedHandle = influencerDoc.handle || "";

    deliverablesExpanded = normalizeDeliverablesArray(deliverablesExpanded, {
      enforcedHandle,
      draftDue,
      defaultRevRounds: brandInput.revisionsIncluded ?? 1,
      extraRevisionFee: admin.extraRevisionFee ?? 0,
    });

    other.autoCalcs.firstDraftDue = draftDue;
    other.autoCalcs.tokensExpandedAt = new Date();

    const effectiveTz = requestedEffectiveDateTimezone || adminTimezone || DEFAULT_TZ;
    const requestedDateBuilt = requestedEffectiveDate
      ? buildRequestedEffectiveDate(requestedEffectiveDate, effectiveTz)
      : undefined;

    const base = {
      brandId,
      influencerId,
      campaignId,

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

      brand: { ...brandInput, deliverablesExpanded },
      influencer: {},

      other,
      admin,

      requestedEffectiveDate: requestedDateBuilt,
      requestedEffectiveDateTimezone: effectiveTz,

      brandName: other.brandProfile.legalName,
      brandAddress: other.brandProfile.address,
      influencerName: other.influencerProfile.legalName,
      influencerAddress: other.influencerProfile.address,
      influencerHandle: other.influencerProfile.handle,
    };

    // PDF preview (no emails / reminders)
    if (preview && !isResend) {
      const tmp = { ...base };
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin.legalTemplateText, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });

      const headerTitle = "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)";
      const headerDate =
        tokens["Agreement.EffectiveDateTime"] ||
        tokens["Agreement.EffectiveDateLong"] ||
        "Pending";

      return renderPDFWithPuppeteer({
        html,
        res,
        filename: `Contract-Preview-${campaignId}.pdf`,
        headerTitle,
        headerDate,
      });
    }

    // ---- RESEND via initiate ----
    if (isResend && resendOf) {
      const parent = await Contract.findOne({ contractId: resendOf });
      if (!parent) return respondError(res, "resendOf contract not found", 404);

      if (
        String(parent.brandId) !== String(brandId) ||
        String(parent.influencerId) !== String(influencerId) ||
        String(parent.campaignId) !== String(campaignId)
      ) {
        return respondError(res, "resendOf must belong to the same brand, influencer, and campaign", 400);
      }

      if (isLockedContract(parent)) return respondError(res, "Cannot resend a signed/locked contract", 400);

      const child = await buildResendChildContract(parent, {
        brandInput,
        requestedEffectiveDate,
        requestedEffectiveDateTimezone,
        userEmail: req.user?.email,
      });

      await child.save();

      parent.supersededBy = child.contractId;
      parent.resentAt = new Date();
      parent.status = CONTRACT_STATUS.SUPERSEDED;
      addAudit(parent, "system", "RESENT", { to: child.contractId, by: req.user?.email || "system" });
      await parent.save();

      await Campaign.updateOne(
        campaignQuery(campaignId),
        { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } }
      );

      await createAndEmit({
        recipientType: "influencer",
        influencerId: String(influencerId),
        type: "contract.initiated",
        title: `Contract resent by ${brandDoc.name}`,
        message: `Updated contract for "${campaign.productOrServiceName}".`,
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
        message: `You resent the contract to ${influencerDoc?.name || "Influencer"} for “${campaign?.productOrServiceName || "Campaign"}”.`,
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

    // ---- New contract ----
    const contract = new Contract({
      ...base,
      lastSentAt: new Date(),
      isAssigned: 1,
      isAccepted: 0,
      feeAmount: Number(brandInput.totalFee || 0),
      currency: brandInput.currency || "USD",
    });

    addAudit(contract, "system", "INITIATED", { campaignId, status: contract.status });
    await contract.save();

    await Campaign.updateOne(
      campaignQuery(campaignId),
      { $set: { isContracted: 1, contractId: contract.contractId, isAccepted: 0 } }
    );

    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(influencerId),
      type: "contract.initiated",
      title: `Contract initiated by ${brandDoc.name}`,
      message: `Contract created for "${campaign.productOrServiceName}".`,
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
      message: `You sent a contract to ${influencerDoc.name || "Influencer"} for “${campaign.productOrServiceName}”.`,
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

// -------------------- VIEWED --------------------
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

// -------------------- INFLUENCER CONFIRM --------------------
exports.influencerConfirm = async (req, res) => {
  try {
    const { contractId, influencer: influencerData = {}, preview = false } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);

    if (contract.editsLockedAt) {
      return respondError(res, "Contract is locked for signing; edits/accept changes are disabled", 400);
    }

    const safeInfluencer = {
      dataAccess: {},
      ...influencerData,
      dataAccess: influencerData?.dataAccess || {},
    };

    if (preview) {
      const tmp = contract.toObject?.() || contract;
      tmp.influencer = { ...(tmp.influencer || {}), ...safeInfluencer };

      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });

      const headerTitle = "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)";
      const headerDate =
        tokens["Agreement.EffectiveDateTime"] ||
        tokens["Agreement.EffectiveDateLong"] ||
        "Pending";

      return renderPDFWithPuppeteer({
        html,
        res,
        filename: `Contract-Influencer-Preview-${contractId}.pdf`,
        headerTitle,
        headerDate,
      });
    }

    const before = { influencer: contract.influencer?.toObject?.() || contract.influencer };
    contract.influencer = { ...(contract.influencer || {}), ...safeInfluencer };
    const after = { influencer: contract.influencer };

    const editedFields = computeEditedFields(before, after, ["influencer"]);
    if (editedFields.length) {
      markEdit(contract, "influencer", req.user?.id, editedFields);
      contract.status = CONTRACT_STATUS.INFLUENCER_EDITED;
      contract.awaitingRole = "brand";
      resetAcceptancesForNewVersion(contract);
    }

    markAccepted(contract, "influencer", req.user?.id);

    const sync = syncStatusFromAcceptances(contract);
    contract.isAccepted = 1;

    addAudit(contract, "influencer", "INFLUENCER_ACCEPTED", {
      editedFields,
      version: contract.version,
      nextRole: sync.nextRole,
    });

    await contract.save();

    await Campaign.updateOne(
      campaignQuery(contract.campaignId),
      { $set: { isAccepted: 1, isContracted: 1, contractId: contract.contractId } }
    );

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
      message: `You accepted “${contract.brand?.campaignTitle || contract.brandName || "Contract"}”.`,
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

// -------------------- BRAND CONFIRM --------------------
exports.brandConfirm = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    requireNotLocked(contract);
    if (contract.editsLockedAt) return respondError(res, "Contract is already locked for signing", 400);

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
          ? `You accepted the contract for “${contract.brand?.campaignTitle || "Campaign"}”. Signing is open.`
          : `You accepted the contract for “${contract.brand?.campaignTitle || "Campaign"}”.`,
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

// -------------------- ADMIN UPDATE --------------------
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

// -------------------- FINALIZE --------------------
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

// -------------------- PREVIEW PDF --------------------
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

    const headerTitle = "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)";
    const headerDate =
      tokens["Agreement.EffectiveDateTime"] ||
      tokens["Agreement.EffectiveDateLong"] ||
      tokens["Agreement.EffectiveDate"] ||
      "Pending";

    return renderPDFWithPuppeteer({
      html,
      res,
      filename: `Contract-Preview-${contractId}.pdf`,
      headerTitle,
      headerDate,
    });
  } catch (err) {
    return respondError(res, err.message || "preview error", err.status || 500, err);
  }
};

// -------------------- VIEW CONTRACT PDF --------------------
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
        : renderTemplate(contract.admin?.legalTemplateText || MASTER_TEMPLATE, buildTokenMap(contract));

    const html = renderContractHTML({ contract, templateText: text });

    const tokens = buildTokenMap(contract);
    const headerDate =
      tokens["Agreement.EffectiveDateTime"] ||
      tokens["Agreement.EffectiveDateLong"] ||
      "Pending";

    return renderPDFWithPuppeteer({
      html,
      res,
      filename: `Contract-${contractId}.pdf`,
      headerTitle: "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)",
      headerDate,
    });
  } catch (err) {
    console.error("viewContractPdf error:", err);

    // Emergency fallback: plain template text
    try {
      const templateText = renderTemplate(
        contract?.admin?.legalTemplateText || MASTER_TEMPLATE,
        buildTokenMap(contract || {})
      );
      const doc = new PDFDocument({ margin: 50 });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=Contract-${contract?.contractId || "Unknown"}.pdf`);

      doc.pipe(res);
      doc.fontSize(18).text("Master Brand–Influencer Agreement", { align: "center" }).moveDown();

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

// -------------------- SIGN --------------------
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
      ...(sigPayload ? sigPayload : {}),
    };

    if (effectiveDateOverride && req.user?.isAdmin) {
      contract.effectiveDateOverride = new Date(effectiveDateOverride);
    }

    addAudit(contract, signerRole, "SIGNED", { role: signerRole, name, email });

    const nextRole = syncAwaitingFromSignatures(contract);

    lockIfFullySigned(contract);

    await contract.save();

    const locked = isLockedContract(contract);

    // Email: one side signed, other still pending
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

    // Notify opposite party
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
          : signerRole === "collabglam"
            ? null
            : null;

    if (opp) {
      await createAndEmit({
        recipientType: opp.recipientType,
        brandId: opp.brandId,
        influencerId: opp.influencerId,
        type: opp.type,
        title: `${signerRole === "brand" ? "Brand" : "Influencer"} signed`,
        message: `${signerRole === "brand" ? contract.brandName || "Brand" : contract.influencerName || "Influencer"} added a signature.`,
        entityType: "contract",
        entityId: String(contract.contractId),
        actionPath: opp.path,
      });
    }

    // Self notify
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

    // Reminders
    if (signerRole === "brand" || signerRole === "influencer" || signerRole === "collabglam") {
      await safeClearReminder(contract.contractId, signerRole);
    }

    if (!locked) {
      if (nextRole === "brand" || nextRole === "influencer" || nextRole === "collabglam") {
        await safeStartReminder(contract, nextRole);
      }
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

    return respondOK(res, { message: locked ? "Signed & locked" : "Signature recorded", contract });
  } catch (err) {
    return respondError(res, err.message || "sign error", err.status || 500, err);
  }
};

// -------------------- BRAND UPDATE FIELDS --------------------
exports.brandUpdateFields = async (req, res) => {
  try {
    const { contractId, brandId, brandUpdates = {}, type = 0 } = req.body;
    const isPreview = Number(type) === 1;

    assertRequired(req.body, ["contractId", "brandId"]);

    const contract = await Contract.findOne({ contractId, brandId });
    if (!contract) return respondError(res, "Contract not found", 404);

    requireNotLocked(contract);
    if (contract.editsLockedAt) return respondError(res, "Contract is locked for signing; edits are disabled", 400);

    const before = { brand: contract.brand?.toObject?.() || contract.brand };
    contract.brand = contract.brand || {};

    for (const k of Object.keys(brandUpdates)) {
      if (!ALLOWED_BRAND_KEYS.includes(k)) continue;

      if (k === "goLive" && brandUpdates.goLive?.start) {
        const dd = clampDraftDue(brandUpdates.goLive.start);
        (contract.brand.deliverablesExpanded || []).forEach((d) => {
          if (d.draftRequired) d.draftDueDate = dd;
        });
        contract.other = contract.other || {};
        contract.other.autoCalcs = contract.other.autoCalcs || {};
        contract.other.autoCalcs.firstDraftDue = dd;
      }

      if (k === "requestedEffectiveDate") {
        const tz =
          brandUpdates.requestedEffectiveDateTimezone ||
          contract.requestedEffectiveDateTimezone ||
          contract.admin?.timezone ||
          DEFAULT_TZ;

        contract.requestedEffectiveDate = buildRequestedEffectiveDate(brandUpdates[k], tz);
      } else if (k === "requestedEffectiveDateTimezone") {
        contract.requestedEffectiveDateTimezone = brandUpdates[k] || DEFAULT_TZ;
      } else {
        contract.brand[k] = brandUpdates[k];
      }
    }

    const inf = await Influencer.findOne({ influencerId: contract.influencerId }, "handle").lean();
    const enforcedHandle = inf?.handle || "";

    if (Array.isArray(contract.brand?.deliverablesExpanded)) {
      contract.brand.deliverablesExpanded = normalizeDeliverablesArray(contract.brand.deliverablesExpanded, {
        enforcedHandle,
        draftDue: contract.other?.autoCalcs?.firstDraftDue,
        defaultRevRounds: contract.brand?.revisionsIncluded ?? 1,
        extraRevisionFee: contract.admin?.extraRevisionFee ?? 0,
      });
    }

    contract.other = contract.other || {};
    contract.other.influencerProfile = contract.other.influencerProfile || {};
    contract.other.influencerProfile.handle = enforcedHandle;

    const after = { brand: contract.brand?.toObject?.() || contract.brand };
    const editedFields = computeEditedFields(before, after, ["brand"]);

    if (isPreview) {
      const contractPreview = contract.toObject ? contract.toObject() : { ...contract };
      contractPreview.brand = after.brand;
      return respondOK(res, { message: "Brand fields preview", contract: contractPreview, editedFields });
    }

    if (editedFields.length) {
      bumpVersion(contract, "brand", req.user?.id, editedFields);
      resetAcceptancesForNewVersion(contract);

      contract.status = CONTRACT_STATUS.BRAND_EDITED;
      contract.awaitingRole = "influencer";
      contract.lastSentAt = new Date();

      addAudit(contract, "brand", "BRAND_EDITED", { editedFields, brandUpdates: Object.keys(brandUpdates) });
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
      meta: { editedFields },
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

// -------------------- INFLUENCER UPDATE FIELDS --------------------
exports.influencerUpdateFields = async (req, res) => {
  try {
    const { contractId, influencerUpdates = {} } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    requireNotLocked(contract);
    if (contract.editsLockedAt) return respondError(res, "Contract is locked for signing; edits are disabled", 400);

    const before = { influencer: contract.influencer?.toObject?.() || contract.influencer };
    contract.influencer = contract.influencer || {};

    for (const k of Object.keys(influencerUpdates)) {
      if (!ALLOWED_INFLUENCER_KEYS.includes(k)) continue;
      contract.influencer[k] = influencerUpdates[k];
    }

    const after = { influencer: contract.influencer };
    const editedFields = computeEditedFields(before, after, ["influencer"]);

    if (editedFields.length) {
      bumpVersion(contract, "influencer", req.user?.id, editedFields);
      resetAcceptancesForNewVersion(contract);

      contract.status = CONTRACT_STATUS.INFLUENCER_EDITED;
      contract.awaitingRole = "brand";

      addAudit(contract, "influencer", "INFLUENCER_EDITED", { editedFields });
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
      meta: { editedFields },
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

// -------------------- GET CONTRACTS --------------------
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

// -------------------- REJECT --------------------
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

    await Campaign.updateOne(
      campaignQuery(contract.campaignId),
      { $set: { isContracted: 0, contractId: null, isAccepted: 0 } }
    );

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

// -------------------- RESEND --------------------
exports.resend = async (req, res) => {
  try {
    const { contractId, brandUpdates = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, preview = false } =
      req.body;
    assertRequired(req.body, ["contractId"]);

    const parent = await Contract.findOne({ contractId });
    if (!parent) return respondError(res, "Contract not found", 404);
    if (isLockedContract(parent)) return respondError(res, "Cannot resend a signed/locked contract", 400);

    if (preview) {
      const tmp = buildResendChildContract(parent, {
        brandInput: brandUpdates,
        requestedEffectiveDate,
        requestedEffectiveDateTimezone,
        userEmail: req.user?.email,
        asPlain: true,
      });

      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });

      const headerTitle = "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)";
      const headerDate =
        tokens["Agreement.EffectiveDateTime"] ||
        tokens["Agreement.EffectiveDateLong"] ||
        "Pending";

      return renderPDFWithPuppeteer({
        html,
        res,
        filename: `Contract-Resend-Preview-${contractId}.pdf`,
        headerTitle,
        headerDate,
      });
    }

    const child = buildResendChildContract(parent, {
      brandInput: brandUpdates,
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      userEmail: req.user?.email,
    });

    await child.save();

    parent.supersededBy = child.contractId;
    parent.resentAt = new Date();
    parent.status = CONTRACT_STATUS.SUPERSEDED;
    addAudit(parent, "system", "RESENT", { to: child.contractId, by: req.user?.email || "system" });
    await parent.save();

    await Campaign.updateOne(
      campaignQuery(parent.campaignId),
      { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } }
    );

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

// -------------------- Timezone / Currency helpers --------------------
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
