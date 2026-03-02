// ==============================
// FILE: models/contract.js
// ==============================
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { CONTRACT_STATUS, LEGACY_STATUS_MAP } = require("../constants/contract");

// ============================ Status Enums ============================

// Canonical statuses
const CANONICAL_STATUS = Object.freeze(Object.values(CONTRACT_STATUS));

// Legacy statuses kept readable during migration
const LEGACY_STATUS = Object.freeze(Object.keys(LEGACY_STATUS_MAP));

// Allow reading both canonical + legacy, but controllers/middleware must WRITE canonical
const STATUS_ENUM = Object.freeze(Array.from(new Set([...CANONICAL_STATUS, ...LEGACY_STATUS])));

// ✅ Workflow signers (CollabGlam signature is display-only)
const WORKFLOW_SIGNERS = Object.freeze(["brand", "influencer"]);

function normalizeStatus(status) {
  if (!status) return CONTRACT_STATUS.DRAFT;
  if (CANONICAL_STATUS.includes(status)) return status;
  if (LEGACY_STATUS_MAP[status]) return LEGACY_STATUS_MAP[status];
  return CONTRACT_STATUS.BRAND_SENT_DRAFT; // safe default
}

// ============================ Sub-Schemas ============================

const SignatureSchema = new mongoose.Schema(
  {
    signed: { type: Boolean, default: false },
    byUserId: { type: String },
    name: { type: String },
    email: { type: String },
    at: { type: Date },
    sigImageDataUrl: { type: String },
    sigImageBytes: { type: Number },
  },
  { _id: false }
);

const AuditEventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    byUserId: { type: String, default: "" },
    role: { type: String, enum: ["brand", "influencer", "collabglam", "admin", "system"], default: "system" },
    type: { type: String },
    details: { type: Object, default: {} },
  },
  { _id: false }
);

const ExpandedDeliverableSchema = new mongoose.Schema(
  {
    type: String,
    quantity: Number,
    format: String,
    durationSec: Number,
    postingWindow: { start: Date, end: Date },
    draftRequired: { type: Boolean, default: false },
    draftDueDate: Date,
    minLiveHours: Number,

    liveRetentionMonths: Number,
    revisionRoundsIncluded: Number,
    additionalRevisionFee: Number,

    tags: [String],
    handles: [String],
    captions: String,
    links: [String],
    disclosures: String,

    // Legacy aliases
    whitelisting: { type: Boolean, default: false },
    sparkAds: { type: Boolean, default: false },

    // Canonical switches
    whitelistingEnabled: { type: Boolean, default: undefined },
    sparkAdsEnabled: { type: Boolean, default: undefined },
  },
  { _id: false }
);

const UsageBundleSchema = new mongoose.Schema(
  {
    type: { type: String, default: "Organic" },
    durationMonths: Number,
    geographies: [String],
    derivativeEditsAllowed: { type: Boolean, default: false },
    spendCap: { type: Number },
    audienceRestrictions: { type: String },
  },
  { _id: false }
);

const ConfirmationSchema = new mongoose.Schema(
  {
    confirmed: { type: Boolean, default: false },
    byUserId: { type: String },
    at: { type: Date },
  },
  { _id: false }
);

const AcceptanceSchema = new mongoose.Schema(
  {
    accepted: { type: Boolean, default: false },
    byUserId: { type: String },
    at: { type: Date },
    acceptedVersion: { type: Number },
  },
  { _id: false }
);

const LastEditSchema = new mongoose.Schema(
  {
    isEdit: { type: Boolean, default: false },
    by: { type: String, enum: ["brand", "influencer", "admin", "system", ""], default: "" },
    at: { type: Date },
    fields: [String],
  },
  { _id: false }
);

const ReminderSchema = new mongoose.Schema(
  {
    dueAt: { type: Date },
    lastSentAt: { type: Date },
    sentCount: { type: Number, default: 0 },
    token: { type: String },
  },
  { _id: false }
);

const VersionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true },
    at: { type: Date, required: true },
    byRole: { type: String, enum: ["brand", "influencer", "admin", "system"], required: true },
    byUserId: { type: String },
    editedFields: [{ type: String }],
    snapshot: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const EmailLogSchema = new mongoose.Schema(
  {
    event: { type: String },
    to: { type: String },
    subject: { type: String },
    templateKey: { type: String },
    vars: { type: mongoose.Schema.Types.Mixed },
    sentAt: { type: Date },
    providerId: { type: String },
    error: { type: String },
  },
  { _id: false }
);

const MilestoneSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    dueAt: { type: Date },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    status: { type: String, default: "PENDING" },
  },
  { _id: false }
);

// ============================ Main Schema ============================

const contractSchema = new mongoose.Schema({
  contractId: { type: String, required: true, unique: true, default: uuidv4 },
  brandId: { type: String, required: true, ref: "Brand" },
  influencerId: { type: String, required: true, ref: "Influencer" },
  campaignId: { type: String, required: true, ref: "Campaign" },

  // Canonical status (writes should be canonical)
  status: { type: String, enum: STATUS_ENUM, default: CONTRACT_STATUS.DRAFT },

  version: { type: Number, default: 0 },

  // Keep collabglam in enum for backwards-compat reads, but we will NEVER expose it via flags
  awaitingRole: { type: String, enum: ["brand", "influencer", "collabglam"], default: null },

  acceptances: {
    brand: { type: AcceptanceSchema, default: () => ({ accepted: false }) },
    influencer: { type: AcceptanceSchema, default: () => ({ accepted: false }) },
  },

  editsLockedAt: { type: Date },

  // ✅ Never require CollabGlam for workflow completion
  requiredSigners: { type: [String], default: () => [...WORKFLOW_SIGNERS] },

  versions: { type: [VersionSchema], default: () => [] },

  lastActionAt: { type: Date },
  lastActionByRole: { type: String },

  lastViewedAt: {
    brand: { type: Date },
    influencer: { type: Date },
  },

  reminders: {
    brand: { type: ReminderSchema, default: () => ({}) },
    influencer: { type: ReminderSchema, default: () => ({}) },
  },

  emailLog: { type: [EmailLogSchema], default: () => [] },

  milestonesCreatedAt: { type: Date },
  milestones: { type: [MilestoneSchema], default: () => [] },

  // Back-compat acceptance fields
  confirmations: {
    brand: { type: ConfirmationSchema, default: () => ({ confirmed: false }) },
    influencer: { type: ConfirmationSchema, default: () => ({ confirmed: false }) },
  },

  // Brand data
  brand: {
    campaignTitle: { type: String },
    platforms: [{ type: String, enum: ["YouTube", "Instagram", "TikTok"] }],
    goLive: { start: { type: Date }, end: { type: Date } },
    totalFee: { type: Number },
    currency: { type: String, default: "USD" },
    milestoneSplit: { type: String },
    usageBundle: UsageBundleSchema,
    revisionsIncluded: { type: Number, default: 1 },
    deliverablesPresetKey: { type: String },
    deliverablesExpanded: [ExpandedDeliverableSchema],
  },

  // Influencer data
  influencer: {
    legalName: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    taxId: { type: String, default: "" },

    addressLine1: { type: String, default: "" },
    addressLine2: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    postalCode: { type: String, default: "" },
    country: { type: String, default: "" },
    notes: { type: String, default: "" },

    shippingAddress: { type: String, default: "" },
    dataAccess: {
      insightsReadOnly: { type: Boolean, default: false },
      whitelisting: { type: Boolean, default: false },
      sparkAds: { type: Boolean, default: false },
    },
    taxFormType: { type: String, enum: ["W-9", "W-8BEN", "W-8BEN-E"], default: "W-9" },
  },

  other: {
    brandProfile: { legalName: String, address: String, contactName: String, email: String, country: String },
    influencerProfile: { legalName: String, address: String, contactName: String, email: String, country: String, handle: String },
    autoCalcs: { firstDraftDue: Date, tokensExpandedAt: { type: Date } },
  },

  admin: {
    governingLaw: { type: String, default: "California, United States" },
    arbitrationSeat: { type: String, default: "San Francisco, CA" },
    timezone: { type: String, default: "America/Los_Angeles" },
    jurisdiction: { type: String, default: "USA" },
    fxSource: { type: String, default: "ECB" },
    defaultBrandReviewWindowBDays: { type: Number, default: 2 },
    extraRevisionFee: { type: Number, default: 0 },
    escrowAMLFlags: { type: String, default: "" },

    legalTemplateVersion: { type: Number, default: 1 },
    legalTemplateText: { type: String },
    legalTemplateHistory: [
      { version: Number, text: String, updatedAt: { type: Date, default: Date.now }, updatedBy: { type: String } },
    ],
  },

  templateVersion: { type: Number, default: 1 },
  templateTokensSnapshot: { type: Object, default: {} },
  renderedTextSnapshot: { type: String },

  dateFormatShort: { type: String, default: "MMMM D, YYYY" },
  dateFormatLong: { type: String, default: "Do MMMM YYYY" },
  locale: { type: String, default: "en-US" },

  requestedEffectiveDate: { type: Date },
  requestedEffectiveDateTimezone: { type: String, default: "America/Los_Angeles" },
  effectiveDate: { type: Date },
  effectiveDateTimezone: { type: String, default: "America/Los_Angeles" },
  effectiveDateOverride: { type: Date },
  lockedAt: { type: Date },

  // Signatures (CollabGlam block supported, but NOT a workflow signer)
  signatures: {
    brand: { type: SignatureSchema, default: () => ({}) },
    influencer: { type: SignatureSchema, default: () => ({}) },
    collabglam: { type: SignatureSchema, default: () => ({}) },
  },

  isEdit: { type: Boolean, default: false },
  isEditBy: { type: String, enum: ["brand", "influencer", "admin", "system", ""], default: "" },
  editedFields: [String],
  lastEdit: { type: LastEditSchema, default: () => ({ isEdit: false, by: "", fields: [] }) },

  audit: [AuditEventSchema],

  brandName: { type: String },
  brandAddress: { type: String },
  influencerName: { type: String },
  influencerAddress: { type: String },
  influencerHandle: { type: String },

  lastSentAt: { type: Date },
  isAssigned: { type: Number, default: 0 },
  isAccepted: { type: Number, default: 0 },
  isRejected: { type: Number, default: 0 },
  feeAmount: { type: Number, default: 0 },
  currency: { type: String, default: "USD" },

  resendIteration: { type: Number, default: 0 },
  resendOf: { type: String },
  supersededBy: { type: String },
  resentAt: { type: Date },

  createdAt: { type: Date, default: Date.now },
});

// ============================ Indexes ============================

contractSchema.index({ contractId: 1 }, { unique: true });
contractSchema.index({ brandId: 1, influencerId: 1, campaignId: 1 });
contractSchema.index({ lastSentAt: -1 });
contractSchema.index({ lockedAt: 1 });
contractSchema.index({ editsLockedAt: 1 });
contractSchema.index({ status: 1 });
contractSchema.index({ awaitingRole: 1 });
contractSchema.index({ "audit.at": -1 });
contractSchema.index({ resendOf: 1 });
contractSchema.index({ supersededBy: 1 });
contractSchema.index({ status: 1, awaitingRole: 1, "reminders.brand.dueAt": 1 });
contractSchema.index({ status: 1, awaitingRole: 1, "reminders.influencer.dueAt": 1 });

// ============================ Sync / Normalization Middleware ============================

contractSchema.pre("save", function preSave(next) {
  try {
    // 1) Normalize status (WRITE canonical)
    this.status = normalizeStatus(this.status);

    // ✅ 2) Enforce workflow signers (CollabGlam is NEVER required)
    this.requiredSigners = [...WORKFLOW_SIGNERS];

    // ✅ 2b) Never persist awaitingRole as collabglam/unknown
    if (!["brand", "influencer"].includes(this.awaitingRole || "")) {
      this.awaitingRole = null;
    }

    // 3) Back-compat sync between acceptances and confirmations
    this.acceptances = this.acceptances || {};
    this.confirmations = this.confirmations || {};

    const currentVersion = Number(this.version || 0);

    const bConf = Boolean(this.confirmations?.brand?.confirmed);
    const iConf = Boolean(this.confirmations?.influencer?.confirmed);

    const bAcc = Boolean(this.acceptances?.brand?.accepted);
    const iAcc = Boolean(this.acceptances?.influencer?.accepted);

    if (bAcc) {
      this.confirmations.brand = {
        ...(this.confirmations.brand || {}),
        confirmed: true,
        byUserId: this.acceptances.brand.byUserId || this.confirmations.brand?.byUserId,
        at: this.acceptances.brand.at || this.confirmations.brand?.at,
      };
      if (this.acceptances.brand.acceptedVersion == null) this.acceptances.brand.acceptedVersion = currentVersion;
    }
    if (iAcc) {
      this.confirmations.influencer = {
        ...(this.confirmations.influencer || {}),
        confirmed: true,
        byUserId: this.acceptances.influencer.byUserId || this.confirmations.influencer?.byUserId,
        at: this.acceptances.influencer.at || this.confirmations.influencer?.at,
      };
      if (this.acceptances.influencer.acceptedVersion == null) this.acceptances.influencer.acceptedVersion = currentVersion;
    }

    if (bConf && !bAcc) {
      this.acceptances.brand = {
        ...(this.acceptances.brand || {}),
        accepted: true,
        byUserId: this.confirmations.brand.byUserId,
        at: this.confirmations.brand.at,
        acceptedVersion: this.acceptances.brand?.acceptedVersion ?? currentVersion,
      };
    }
    if (iConf && !iAcc) {
      this.acceptances.influencer = {
        ...(this.acceptances.influencer || {}),
        accepted: true,
        byUserId: this.confirmations.influencer.byUserId,
        at: this.confirmations.influencer.at,
        acceptedVersion: this.acceptances.influencer?.acceptedVersion ?? currentVersion,
      };
    }

    // 4) Legacy convenience flags (isAccepted) mirrors "both accepted on current version"
    const bOk = Boolean(this.acceptances.brand?.accepted && Number(this.acceptances.brand?.acceptedVersion) === currentVersion);
    const iOk = Boolean(this.acceptances.influencer?.accepted && Number(this.acceptances.influencer?.acceptedVersion) === currentVersion);
    this.isAccepted = bOk && iOk ? 1 : 0;

    // 5) Legacy isRejected mirrors canonical status
    if (this.status === CONTRACT_STATUS.REJECTED) this.isRejected = 1;

    next();
  } catch (e) {
    next(e);
  }
});

// ============================ Flags / Virtuals (Back-Compat) ============================

function computeStatusFlags(doc) {
  const st = normalizeStatus(doc?.status || CONTRACT_STATUS.DRAFT);

  const isDraft = st === CONTRACT_STATUS.DRAFT;

  const isSentLike = [
    CONTRACT_STATUS.BRAND_SENT_DRAFT,
    CONTRACT_STATUS.BRAND_EDITED,
    CONTRACT_STATUS.INFLUENCER_EDITED,
    CONTRACT_STATUS.BRAND_ACCEPTED,
    CONTRACT_STATUS.INFLUENCER_ACCEPTED,
    CONTRACT_STATUS.READY_TO_SIGN,
    CONTRACT_STATUS.CONTRACT_SIGNED,
    CONTRACT_STATUS.MILESTONES_CREATED,
  ].includes(st);

  const isFinalized = st === CONTRACT_STATUS.READY_TO_SIGN;
  const isSigning = st === CONTRACT_STATUS.READY_TO_SIGN;
  const isLocked = [CONTRACT_STATUS.CONTRACT_SIGNED, CONTRACT_STATUS.MILESTONES_CREATED].includes(st) || Boolean(doc?.lockedAt);

  const rejected = st === CONTRACT_STATUS.REJECTED || doc?.isRejected === 1;

  const isViewed = Boolean(doc?.lastViewedAt?.brand || doc?.lastViewedAt?.influencer) || !isDraft;

  const brandAccepted = Boolean(doc?.acceptances?.brand?.accepted);
  const influencerAccepted = Boolean(doc?.acceptances?.influencer?.accepted);

  const brandConfirmed = Boolean(doc?.confirmations?.brand?.confirmed) || brandAccepted;
  const influencerConfirmed = Boolean(doc?.confirmations?.influencer?.confirmed) || influencerAccepted;

  const v = Number(doc?.version || 0);
  const brandAcceptedOnCurrent = Boolean(doc?.acceptances?.brand?.accepted && Number(doc?.acceptances?.brand?.acceptedVersion) === v);
  const influencerAcceptedOnCurrent = Boolean(doc?.acceptances?.influencer?.accepted && Number(doc?.acceptances?.influencer?.acceptedVersion) === v);

  const readyToSign = st === CONTRACT_STATUS.READY_TO_SIGN && Boolean(doc?.editsLockedAt) && brandAcceptedOnCurrent && influencerAcceptedOnCurrent;

  // ✅ CollabGlam is never required for "signed completion"
  const req = [...WORKFLOW_SIGNERS];
  const sigs = doc?.signatures || {};
  const fullySigned = req.every((r) => Boolean(sigs?.[r]?.signed));

  const canEditBrandFields =
    !doc?.lockedAt &&
    !doc?.editsLockedAt &&
    !rejected &&
    ["brand"].includes(doc?.awaitingRole) &&
    [
      CONTRACT_STATUS.BRAND_SENT_DRAFT,
      CONTRACT_STATUS.BRAND_EDITED,
      CONTRACT_STATUS.INFLUENCER_EDITED,
      CONTRACT_STATUS.BRAND_ACCEPTED,
      CONTRACT_STATUS.INFLUENCER_ACCEPTED,
    ].includes(st);

  const canEditInfluencerFields =
    !doc?.lockedAt &&
    !doc?.editsLockedAt &&
    !rejected &&
    ["influencer"].includes(doc?.awaitingRole) &&
    [
      CONTRACT_STATUS.BRAND_SENT_DRAFT,
      CONTRACT_STATUS.BRAND_EDITED,
      CONTRACT_STATUS.INFLUENCER_EDITED,
      CONTRACT_STATUS.BRAND_ACCEPTED,
      CONTRACT_STATUS.INFLUENCER_ACCEPTED,
    ].includes(st);

  const canSignBrand = readyToSign && !doc?.lockedAt && req.includes("brand");
  const canSignInfluencer = readyToSign && !doc?.lockedAt && req.includes("influencer");

  const isResendChild = Boolean(doc?.resendIteration > 0 || doc?.resendOf);

  // ✅ Never expose awaitingRole="collabglam"
  const safeAwaitingRole = (() => {
    if (isLocked || rejected) return null;
    if (readyToSign) {
      const next = req.find((r) => !sigs?.[r]?.signed) || null;
      return next;
    }
    return ["brand", "influencer"].includes(doc?.awaitingRole || "") ? doc.awaitingRole : null;
  })();

  return {
    isDraft,
    isSent: isSentLike,
    isViewed,
    isNegotiation: [
      CONTRACT_STATUS.BRAND_SENT_DRAFT,
      CONTRACT_STATUS.BRAND_EDITED,
      CONTRACT_STATUS.INFLUENCER_EDITED,
      CONTRACT_STATUS.BRAND_ACCEPTED,
      CONTRACT_STATUS.INFLUENCER_ACCEPTED,
    ].includes(st),
    isFinalized,
    isSigning,
    isLocked,
    isRejected: rejected,

    isBrandInitiate: !isDraft,

    isBrandConfirmed: brandConfirmed,
    isInfluencerConfirm: influencerConfirmed,

    statusCanonical: st,
    awaitingRole: safeAwaitingRole,
    version: v,

    // ✅ based on workflow signers only
    isBothSigned: fullySigned,

    canEditBrandFields,
    canEditInfluencerFields,
    canSignBrand,
    canSignInfluencer,

    isResendChild,

    // ✅ compatibility flag (always false)
    awaitingCollabglam: false,
  };
}

contractSchema.virtual("flags").get(function () {
  return computeStatusFlags(this);
});

contractSchema.set("toJSON", {
  virtuals: true,
  versionKey: false,
  transform(doc, ret) {
    delete ret._id;

    const f = computeStatusFlags(doc);
    ret.statusFlags = f;

    ret.isBrandInitiate = f.isBrandInitiate;
    ret.isInfluencerconfirm = f.isInfluencerConfirm;
    ret.isrejected = f.isRejected;

    ret.isInfluencerConfirm = f.isInfluencerConfirm;
    ret.isRejected = f.isRejected;

    ret.isDraft = f.isDraft;
    ret.isSent = f.isSent;
    ret.isViewed = f.isViewed;
    ret.isNegotiation = f.isNegotiation;
    ret.isFinalized = f.isFinalized;
    ret.isSigning = f.isSigning;
    ret.isLocked = f.isLocked;
    ret.isBrandConfirmed = f.isBrandConfirmed;
    ret.isBothSigned = f.isBothSigned;
    ret.canEditBrandFields = f.canEditBrandFields;
    ret.canEditInfluencerFields = f.canEditInfluencerFields;
    ret.canSignBrand = f.canSignBrand;
    ret.canSignInfluencer = f.canSignInfluencer;

    ret.isResend = f.isResendChild;
    ret.isresend = f.isResendChild;

    // Helpful canonical mirrors
    ret.statusCanonical = f.statusCanonical;
    ret.awaitingRole = f.awaitingRole;
    ret.version = f.version;

    // ✅ never show awaiting collabglam
    ret.awaitingCollabglam = false;

    return ret;
  },
});

// ============================ Statics ============================

contractSchema.statics.getSupportedCurrencies = function () {
  try {
    const data = require("../data/currencies.json");
    return Object.keys(data || {});
  } catch (_e) {
    return [];
  }
};

contractSchema.statics.getCurrenciesMeta = function () {
  try {
    return require("../data/currencies.json");
  } catch (_e) {
    return {};
  }
};

contractSchema.statics.isCurrencySupported = function (code) {
  if (!code) return false;
  const c = String(code).toUpperCase();
  const data = this.getCurrenciesMeta();
  return Boolean(data && data[c]);
};

contractSchema.statics.getTimezones = function () {
  try {
    return require("../data/timezones.json");
  } catch (_e) {
    return [];
  }
};

contractSchema.statics.findTimezone = function (key) {
  if (!key) return null;
  const list = this.getTimezones();
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
};

contractSchema.statics.isTimezoneSupported = function (key) {
  return Boolean(this.findTimezone(key));
};

// ============================ Exports ============================

const Contract = mongoose.model("Contract", contractSchema);

Contract.STATUS = LEGACY_STATUS;
Contract.CANONICAL_STATUS = CANONICAL_STATUS;
Contract.STATUS_ENUM = STATUS_ENUM;
Contract.normalizeStatus = normalizeStatus;

module.exports = Contract;
module.exports.STATUS = LEGACY_STATUS;
module.exports.CANONICAL_STATUS = CANONICAL_STATUS;
module.exports.STATUS_ENUM = STATUS_ENUM;
module.exports.normalizeStatus = normalizeStatus;
