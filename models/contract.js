"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { CONTRACT_STATUS, LEGACY_STATUS_MAP } = require("../constants/contract");

const CANONICAL_STATUS = Object.freeze(Object.values(CONTRACT_STATUS));
const LEGACY_STATUS = Object.freeze(Object.keys(LEGACY_STATUS_MAP));
const STATUS_ENUM = Object.freeze(Array.from(new Set([...CANONICAL_STATUS, ...LEGACY_STATUS])));

const WORKFLOW_SIGNERS = Object.freeze(["brand", "influencer"]);

const CAMPAIGN_TYPES = Object.freeze({
  FIXED_PAYMENT: "fixed_payment",
  MILESTONE_BASED: "milestone_based",
  PRODUCT_GIFTING: "product_gifting",
});

function normalizeStatus(status) {
  if (!status) return CONTRACT_STATUS.DRAFT;
  if (CANONICAL_STATUS.includes(status)) return status;
  if (LEGACY_STATUS_MAP[status]) return LEGACY_STATUS_MAP[status];
  return CONTRACT_STATUS.BRAND_SENT_DRAFT;
}

const SignatureSchema = new mongoose.Schema(
  {
    signed: { type: Boolean, default: false },
    byUserId: { type: String, default: "" },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    at: { type: Date, default: null },
    sigImageDataUrl: { type: String, default: "" },
    sigImageBytes: { type: Number, default: 0 },
  },
  { _id: false }
);

const AcceptanceSchema = new mongoose.Schema(
  {
    accepted: { type: Boolean, default: false },
    acceptedVersion: { type: Number, default: 0 },
    at: { type: Date, default: null },
    byUserId: { type: String, default: "" },
  },
  { _id: false }
);

const ConfirmationSchema = new mongoose.Schema(
  {
    confirmed: { type: Boolean, default: false },
    at: { type: Date, default: null },
    byUserId: { type: String, default: "" },
  },
  { _id: false }
);

const DeliverableRowSchema = new mongoose.Schema(
  {
    srNo: { type: Number, default: 1 },
    platformHandle: { type: String, default: "" },
    deliverableFormat: { type: String, default: "" },
    qty: { type: Number, default: 1 },
    draftDue: { type: String, default: "" },
    liveDate: { type: String, default: "" },
  },
  { _id: false }
);

const UsageRightRowSchema = new mongoose.Schema(
  {
    usageRight: { type: String, default: "" },
    selected: { type: Boolean, default: false },
    duration: { type: String, default: "" },
    territoryNotes: { type: String, default: "" },
  },
  { _id: false }
);

const ContentBrandSchema = new mongoose.Schema(
  {
    legalName: { type: String, default: "" },
    contactPersonName: { type: String, default: "" },
    noticeEmail: { type: String, default: "" },
    noticePhone: { type: String, default: "" },
    billingAddress: { type: String, default: "" },
  },
  { _id: false }
);

const ContentInfluencerSchema = new mongoose.Schema(
  {
    legalName: { type: String, default: "" },
    contactName: { type: String, default: "" },
    postingHandleUrl: { type: String, default: "" },
    contactEmail: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    whatsApp: { type: String, default: "" },
    address: { type: String, default: "" },
  },
  { _id: false }
);

const ContentCollabGlamSchema = new mongoose.Schema(
  {
    legalName: { type: String, default: "CollabGlam LLC" },
    address: {
      type: String,
      default: "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",
    },
    email: { type: String, default: "help@collabglam.com" },
    signatoryName: { type: String, default: "" },
  },
  { _id: false }
);

const ContentCampaignSchema = new mongoose.Schema(
  {
    productsServicesCovered: { type: String, default: "" },
    territoryTargetCountry: { type: String, default: "Worldwide" },
    effectiveDate: { type: Date, default: null },
    campaignTitleOrId: { type: String, default: "" },
    campaignType: {
      type: String,
      enum: Object.values(CAMPAIGN_TYPES),
      default: CAMPAIGN_TYPES.FIXED_PAYMENT,
    },
  },
  { _id: false }
);

const ReviewSchema = new mongoose.Schema(
  {
    includedRevisionRounds: { type: Number, default: 1 },
    additionalRevisionFee: { type: String, default: "" },
    reshootObligation: { type: String, default: "" },
    reshootFee: { type: String, default: "" },
    minimumLivePeriod: { type: String, default: "" },
  },
  { _id: false }
);

const CommercialSchema = new mongoose.Schema(
  {
    totalCampaignFee: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    platformMilestonePaymentStructure: { type: String, default: "" },
    customSplit: { type: String, default: "" },
    advancePaymentTrigger: { type: String, default: "" },
    remainingPaymentTrigger: { type: String, default: "" },
    paymentProcessorFeesBorneBy: { type: String, default: "" },
    paymentProcessorFeesNotes: { type: String, default: "" },
    laneAMarketplaceFeeNote: {
      type: String,
      default:
        "Unless expressly stated otherwise, 10% of the applicable Influencer compensation funded through the Platform is deducted from the Influencer payout and retained by CollabGlam; the Brand-funded campaign amount remains fixed.",
    },
  },
  { _id: false }
);

const RawFilesSchema = new mongoose.Schema(
  {
    rawSourceFileDelivery: { type: String, default: "" },
    deliveryDue: { type: String, default: "" },
    format: { type: String, default: "" },
    analyticsReportingDeadline: { type: String, default: "" },
    analyticsReportingItems: { type: String, default: "" },
  },
  { _id: false }
);

const ShippingSchema = new mongoose.Schema(
  {
    productShippingApplicable: { type: String, default: "No" },
    shipToName: { type: String, default: "" },
    shipToAddress: { type: String, default: "" },
    shipToPhone: { type: String, default: "" },
    productReceiptConfirmationDeadline: { type: String, default: "" },
    productReturnable: { type: String, default: "" },
    returnWindowMethod: { type: String, default: "" },
    riskOfLossNotes: { type: String, default: "" },
  },
  { _id: false }
);

const UsageRightsSchema = new mongoose.Schema(
  {
    rows: {
      type: [UsageRightRowSchema],
      default: [
        { usageRight: "Organic repost on Brand-owned social channels", selected: false, duration: "", territoryNotes: "" },
        { usageRight: "Brand website / blog / PDP / retailer listing", selected: false, duration: "", territoryNotes: "" },
        { usageRight: "Email / CRM / deck / internal presentation use", selected: false, duration: "", territoryNotes: "" },
        { usageRight: "Paid social / boosting / ads", selected: false, duration: "", territoryNotes: "" },
        { usageRight: "Whitelisting / Spark Ads / dark posting / creator handle", selected: false, duration: "", territoryNotes: "" },
        { usageRight: "Perpetual rights / buyout / work-made-for-hire", selected: false, duration: "", territoryNotes: "" },
      ],
    },
    attributionRequirement: { type: String, default: "" },
    attributionText: { type: String, default: "" },
    editingRights: { type: String, default: "" },
    musicStockAssetResponsibility: { type: String, default: "" },
  },
  { _id: false }
);

const ComplianceSchema = new mongoose.Schema(
  {
    creativeBriefMandatoryTalkingPoints: { type: String, default: "" },
    restrictedStatements: { type: String, default: "" },
  },
  { _id: false }
);

const ExclusivitySchema = new mongoose.Schema(
  {
    competitorBlackout: { type: String, default: "None" },
    categoryCompetitorList: { type: String, default: "" },
    blackoutPeriod: { type: String, default: "" },
    optionalMoralsClause: { type: String, default: "" },
  },
  { _id: false }
);

const CancellationSchema = new mongoose.Schema(
  {
    killFeeOrProrata: { type: String, default: "" },
    refundOfUnearnedAdvance: { type: String, default: "" },
  },
  { _id: false }
);

const DisputeSchema = new mongoose.Schema(
  {
    governingLaw: { type: String, default: "Nevada, USA" },
    disputeResolutionMethod: { type: String, default: "AAA Arbitration" },
    disputeVenue: { type: String, default: "" },
    arbitrationSeat: { type: String, default: "Las Vegas, Nevada, USA" },
    attorneysFees: { type: String, default: "" },
  },
  { _id: false }
);

const ScheduleASchema = new mongoose.Schema(
  {
    deliverables: { type: [DeliverableRowSchema], default: [] },
    minimumVideoSpecs: { type: String, default: "" },
    preShootScriptRequired: { type: Boolean, default: false },
    preShootScriptDue: { type: String, default: "" },
    preShootScriptReviewBusinessDays: { type: Number, default: 2 },
    mandatoryTagsMentionsLinksCodes: { type: String, default: "" },

    review: { type: ReviewSchema, default: () => ({}) },
    commercial: { type: CommercialSchema, default: () => ({}) },
    rawFiles: { type: RawFilesSchema, default: () => ({}) },
    shipping: { type: ShippingSchema, default: () => ({}) },
    usageRights: { type: UsageRightsSchema, default: () => ({}) },
    compliance: { type: ComplianceSchema, default: () => ({}) },
    exclusivity: { type: ExclusivitySchema, default: () => ({}) },
    cancellation: { type: CancellationSchema, default: () => ({}) },
    dispute: { type: DisputeSchema, default: () => ({}) },
  },
  { _id: false }
);

const EditorLooseSectionSchema = new mongoose.Schema({}, { _id: false, strict: false });

const EditorStateSchema = new mongoose.Schema(
  {
    partiesAndIdentity: { type: EditorLooseSectionSchema, default: () => ({}) },
    deliverablesTimeline: { type: EditorLooseSectionSchema, default: () => ({}) },

    fixedPaymentTerms: { type: EditorLooseSectionSchema, default: () => ({}) },
    fixedPaymentTermsPrivate: { type: EditorLooseSectionSchema, default: () => ({}) },

    milestonePaymentSchedule: { type: EditorLooseSectionSchema, default: () => ({}) },
    milestonePaymentSchedulePrivate: { type: EditorLooseSectionSchema, default: () => ({}) },

    productGiftingShipping: { type: EditorLooseSectionSchema, default: () => ({}) },

    additionalCashCompensation: { type: EditorLooseSectionSchema, default: () => ({}) },
    additionalCashCompensationPrivate: { type: EditorLooseSectionSchema, default: () => ({}) },

    usageRightsContentOwnership: { type: EditorLooseSectionSchema, default: () => ({}) },
    reportingAnalytics: { type: EditorLooseSectionSchema, default: () => ({}) },
    exclusivityComplianceClaims: { type: EditorLooseSectionSchema, default: () => ({}) },
    governingLawDisputeResolution: { type: EditorLooseSectionSchema, default: () => ({}) },
  },
  { _id: false, strict: false }
);

const ObjectionSchema = new mongoose.Schema(
  {
    fieldKey: { type: String, required: true },
    raisedByRole: { type: String, enum: ["brand", "influencer"], required: true },
    text: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ContentSchema = new mongoose.Schema(
  {
    brand: { type: ContentBrandSchema, default: () => ({}) },
    influencer: { type: ContentInfluencerSchema, default: () => ({}) },
    collabglam: { type: ContentCollabGlamSchema, default: () => ({}) },
    campaign: { type: ContentCampaignSchema, default: () => ({}) },
    scheduleA: { type: ScheduleASchema, default: () => ({}) },
    editor: { type: EditorStateSchema, default: () => ({}) },
  },
  { _id: false }
);

const AdminSchema = new mongoose.Schema(
  {
    timezone: { type: String, default: "America/Los_Angeles" },
    jurisdiction: { type: String, default: "USA" },
    arbitrationSeat: { type: String, default: "San Francisco, CA" },
    fxSource: { type: String, default: "ECB" },
    extraRevisionFee: { type: Number, default: 0 },
    escrowAMLFlags: { type: String, default: "" },
    collabglamSignatoryName: { type: String, default: "" },
    collabglamSignatoryEmail: { type: String, default: "" },

    legalTemplateVersion: { type: Number, default: 1 },
    legalTemplateText: { type: String, default: "" },
    legalTemplateHistory: {
      type: [
        new mongoose.Schema(
          {
            version: Number,
            text: String,
            updatedAt: Date,
            updatedBy: String,
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { _id: false }
);

const OtherSchema = new mongoose.Schema(
  {
    brandProfile: {
      type: new mongoose.Schema(
        {
          legalName: String,
          address: String,
          contactName: String,
          email: String,
          country: String,
        },
        { _id: false }
      ),
      default: () => ({}),
    },
    influencerProfile: {
      type: new mongoose.Schema(
        {
          legalName: String,
          address: String,
          contactName: String,
          email: String,
          country: String,
          handle: String,
        },
        { _id: false }
      ),
      default: () => ({}),
    },
    autoCalcs: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const VersionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true },
    at: { type: Date, default: Date.now },
    byRole: { type: String, default: "system" },
    byUserId: { type: String, default: "" },
    editedFields: { type: [String], default: [] },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const AuditSchema = new mongoose.Schema(
  {
    type: { type: String, default: "" },
    role: { type: String, default: "system" },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ContractSchema = new mongoose.Schema(
  {
    contractId: { type: String, unique: true, index: true },

    brandId: { type: String, index: true, required: true },
    influencerId: { type: String, index: true, required: true },
    campaignId: { type: String, index: true, required: true },

    campaignType: {
      type: String,
      enum: Object.values(CAMPAIGN_TYPES),
      default: CAMPAIGN_TYPES.FIXED_PAYMENT,
      index: true,
    },

    status: {
      type: String,
      enum: STATUS_ENUM,
      default: CONTRACT_STATUS.DRAFT,
      index: true,
    },
    awaitingRole: { type: String, default: "influencer", index: true },

    requiredSigners: {
      type: [String],
      default: [...WORKFLOW_SIGNERS],
    },

    version: { type: Number, default: 0 },
    versions: { type: [VersionSchema], default: [] },

    acceptances: {
      brand: { type: AcceptanceSchema, default: () => ({}) },
      influencer: { type: AcceptanceSchema, default: () => ({}) },
    },

    confirmations: {
      brand: { type: ConfirmationSchema, default: () => ({}) },
      influencer: { type: ConfirmationSchema, default: () => ({}) },
    },

    signatures: {
      brand: { type: SignatureSchema, default: () => ({}) },
      influencer: { type: SignatureSchema, default: () => ({}) },
      collabglam: { type: SignatureSchema, default: () => ({}) },
    },

    content: { type: ContentSchema, default: () => ({}) },
    admin: { type: AdminSchema, default: () => ({}) },
    other: { type: OtherSchema, default: () => ({}) },

    objections: {
      type: Map,
      of: ObjectionSchema,
      default: {},
    },

    requestedEffectiveDate: { type: Date, default: null },
    requestedEffectiveDateTimezone: { type: String, default: "America/Los_Angeles" },
    effectiveDate: { type: Date, default: null },
    effectiveDateOverride: { type: Date, default: null },
    effectiveDateTimezone: { type: String, default: "" },

    templateVersion: { type: Number, default: 1 },
    templateTokensSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    renderedTextSnapshot: { type: String, default: "" },

    brandName: { type: String, default: "" },
    brandAddress: { type: String, default: "" },
    influencerName: { type: String, default: "" },
    influencerAddress: { type: String, default: "" },
    influencerHandle: { type: String, default: "" },

    lastSentAt: { type: Date, default: null },
    lastViewedAt: {
      brand: { type: Date, default: null },
      influencer: { type: Date, default: null },
    },

    reminders: { type: mongoose.Schema.Types.Mixed, default: {} },
    emailLog: { type: [mongoose.Schema.Types.Mixed], default: [] },

    milestonesCreatedAt: { type: Date, default: null },
    milestones: { type: [mongoose.Schema.Types.Mixed], default: [] },

    audit: { type: [AuditSchema], default: [] },
    statusFlags: { type: mongoose.Schema.Types.Mixed, default: {} },

    editsLockedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },

    lastActionAt: { type: Date, default: null },
    lastActionByRole: { type: String, default: "" },

    resendIteration: { type: Number, default: 0 },
    resendOf: { type: String, default: null, index: true },
    supersededBy: { type: String, default: null, index: true },
    resentAt: { type: Date, default: null },

    isAssigned: { type: Number, default: 1 },
    isAccepted: { type: Number, default: 0 },
    isRejected: { type: Number, default: 0 },

    feeAmount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
  },
  { timestamps: true }
);

ContractSchema.index({ brandId: 1, influencerId: 1, campaignId: 1, createdAt: -1 });

ContractSchema.pre("validate", function contractPreValidate(next) {
  this.status = normalizeStatus(this.status);

  if (!this.contractId) {
    this.contractId = uuidv4().replace(/-/g, "").slice(0, 16).toUpperCase();
  }

  if (!Array.isArray(this.requiredSigners) || !this.requiredSigners.length) {
    this.requiredSigners = [...WORKFLOW_SIGNERS];
  }

  if (!this.campaignType) {
    this.campaignType = this.content?.campaign?.campaignType || CAMPAIGN_TYPES.FIXED_PAYMENT;
  }

  this.content = this.content || {};
  this.content.campaign = this.content.campaign || {};
  this.content.campaign.campaignType = this.campaignType;

  if (!this.brandName) this.brandName = this.content?.brand?.legalName || "";
  if (!this.brandAddress) this.brandAddress = this.content?.brand?.billingAddress || "";
  if (!this.influencerName) this.influencerName = this.content?.influencer?.legalName || "";
  if (!this.influencerAddress) this.influencerAddress = this.content?.influencer?.address || "";
  if (!this.influencerHandle) this.influencerHandle = this.content?.influencer?.postingHandleUrl || "";

  if (!this.feeAmount) {
    this.feeAmount = Number(this.content?.scheduleA?.commercial?.totalCampaignFee || 0);
  }
  if (!this.currency) {
    this.currency = this.content?.scheduleA?.commercial?.currency || "USD";
  }

  next();
});

ContractSchema.statics.normalizeStatus = normalizeStatus;
ContractSchema.statics.CANONICAL_STATUS = CANONICAL_STATUS;
ContractSchema.statics.WORKFLOW_SIGNERS = WORKFLOW_SIGNERS;
ContractSchema.statics.CAMPAIGN_TYPES = CAMPAIGN_TYPES;

module.exports = mongoose.model("Contract", ContractSchema);