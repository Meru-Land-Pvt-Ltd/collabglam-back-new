// scripts/seedSubscriptionPlans.js
require("dotenv").config();
const mongoose = require("mongoose");
const SubscriptionPlan = require("../models/subscription");

const BRAND_CURRENCY = "USD";
const INFLUENCER_CURRENCY = "USD";

// ─────────────────────────────────────────────────────────────────────────────
// Influencer: remove profile boost, campaign analytics, team seats, early access,
//            team workspace, media kit pdf export, verified badge, AI pitch system,
//            manage creators, AND platform_fee_on_payouts_percent
// Brand: remove post campaign analytics, AND marketplace_fee_percent
// ─────────────────────────────────────────────────────────────────────────────
const REMOVED_FEATURE_KEYS_BY_ROLE = {
  Brand: new Set([
    "post_campaign_analytics_report",
    "marketplace_fee_percent",
  ]),
  Influencer: new Set([
    "profile_boosts_in_brand_browse_per_month",
    "campaign_analytics",
    "team_seats",
    "early_access_to_new_campaigns",
    "team_workspace",
    "media_kit_pdf_export",
    "verified_badge",
    "ai_pitch_assistant_drafts_per_month",
    "manage_creators_for_agency",

    "featured_placement_boosts_per_month",
  ]),
};

function stripRemovedFeatures(plan) {
  const removedKeys = REMOVED_FEATURE_KEYS_BY_ROLE[plan.role];
  if (!removedKeys) return plan;

  return {
    ...plan,
    features: (plan.features || []).filter((f) => !removedKeys.has(f.key)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BRAND PLANS (USD)
// FREE / GROWTH / PRO / FULLY MANAGED
// ─────────────────────────────────────────────────────────────────────────────
const brandPlans = [
  {
    role: "Brand",
    name: "free",
    displayName: "FREE",
    monthlyCost: 0,
    annualCost: 0,
    currency: BRAND_CURRENCY,
    bestFor: "Trying CollabGlam",
    mainOutcome: "Launch your first campaign",
    cta: { text: "Start Free", action: "start" },
    sortOrder: 1,
    autoRenew: true,

    durationMins: 43200,

    features: [
      { key: "influencer_search_per_month", value: 20 },
      { key: "influencer_profile_views_per_month", value: 3 },
      { key: "invites_per_month", value: 10 },
      { key: "active_campaigns", value: 5 },

      { key: "platforms_supported", value: ["IG", "TikTok", "YouTube"] },

      { key: "direct_email_messaging_efs", value: true, note: "Included" },
      { key: "milestones_and_payouts", value: true, note: "Included" },

      { key: "message_templates", value: "1 basic" },
      { key: "advanced_filters", value: false, note: "—" },
      { key: "dispute_assistance", value: false, note: "—" },

      { key: "support", value: "Standard" },
      { key: "creator_sourcing_and_outreach", value: "Self-serve" },
      { key: "shortlist_delivered", value: "—" },
      { key: "negotiation_and_followups", value: "Self-serve" },
      { key: "post_campaign_analytics_report", value: "—" }, // stripped

      { key: "marketplace_fee_percent", value: 10, note: "Deducted from creator payouts" }, // stripped
    ],
    addons: [],
  },
  {
    role: "Brand",
    name: "growth",
    displayName: "GROWTH",
    monthlyCost: 99,
    annualCost: 948,
    currency: BRAND_CURRENCY,
    bestFor: "DIY teams starting influencer outreach",
    mainOutcome: "Find creators + start inviting",
    cta: { text: "Start Growth", action: "start" },
    sortOrder: 2,
    autoRenew: true,
    features: [
      { key: "influencer_search_per_month", value: 150 },
      { key: "influencer_profile_views_per_month", value: 50 },
      { key: "invites_per_month", value: 100 },
      { key: "active_campaigns", value: 10 },

      { key: "platforms_supported", value: ["IG", "TikTok", "YouTube"] },

      { key: "direct_email_messaging_efs", value: true, note: "Included" },
      { key: "milestones_and_payouts", value: true, note: "Included" },

      { key: "message_templates", value: "Custom messaging" },
      { key: "advanced_filters", value: true },
      { key: "dispute_assistance", value: true },

      { key: "support", value: "Email support" },
      { key: "creator_sourcing_and_outreach", value: "Self-serve" },
      { key: "shortlist_delivered", value: "—" },
      { key: "negotiation_and_followups", value: "Self-serve" },
      { key: "post_campaign_analytics_report", value: "—" }, // stripped

      { key: "marketplace_fee_percent", value: 10, note: "Deducted from creator payouts" }, // stripped
    ],
    addons: [],
  },
  {
    role: "Brand",
    name: "pro",
    displayName: "PRO",
    monthlyCost: 299,
    annualCost: 2988,
    currency: BRAND_CURRENCY,
    bestFor: "DIY teams scaling monthly campaigns",
    mainOutcome: "Run repeatable influencer ops",
    cta: { text: "Start Pro", action: "start" },
    sortOrder: 3,
    autoRenew: true,
    features: [
      { key: "influencer_search_per_month", value: 750 },
      { key: "influencer_profile_views_per_month", value: 150 },
      { key: "invites_per_month", value: 750 },
      { key: "active_campaigns", value: 30 },

      { key: "platforms_supported", value: ["IG", "TikTok", "YouTube"] },

      { key: "direct_email_messaging_efs", value: true, note: "Included" },
      { key: "milestones_and_payouts", value: true, note: "Included" },

      { key: "message_templates", value: "Custom + saved templates" },
      { key: "advanced_filters", value: true },
      { key: "dispute_assistance", value: true },

      { key: "support", value: "Phone/Email support" },
      { key: "creator_sourcing_and_outreach", value: "Self-serve" },
      { key: "shortlist_delivered", value: "—" },
      { key: "negotiation_and_followups", value: "Self-serve" },
      { key: "post_campaign_analytics_report", value: "Basic" }, // stripped

      { key: "marketplace_fee_percent", value: 10, note: "Deducted from creator payouts" }, // stripped
    ],
    addons: [],
  },
  {
    role: "Brand",
    name: "fully_managed",
    displayName: "FULLY MANAGED",
    monthlyCost: 2999,
    currency: BRAND_CURRENCY,
    isCustomPricing: true,
    isStartingAt: true,
    bestFor: "Brands who want us to run everything end-to-end",
    mainOutcome: "Get shortlists + execution without doing the work",
    cta: { text: "Start Fully Managed", action: "start" }, // updated (no book a call)
    sortOrder: 4,
    autoRenew: false,
    features: [
      { key: "influencer_search_per_month", value: { unlimited: true }, note: "Unlimited (we do it)" },
      { key: "influencer_profile_views_per_month", value: { unlimited: true }, note: "Unlimited (we do it)" },
      { key: "invites_per_month", value: { unlimited: true }, note: "Unlimited (we do it)" },
      { key: "active_campaigns", value: "As needed", note: "managed capacity" },

      { key: "platforms_supported", value: ["IG", "TikTok", "YouTube"] },

      { key: "direct_email_messaging_efs", value: true, note: "Included (managed inbox)" },
      { key: "milestones_and_payouts", value: true, note: "Included (we manage milestones)" },

      { key: "message_templates", value: "We write + send for you" },
      { key: "advanced_filters", value: true },
      { key: "dispute_assistance", value: true, note: "Priority" },

      { key: "support", value: "Dedicated campaign manager" },
      { key: "creator_sourcing_and_outreach", value: "Done-for-you" },
      { key: "shortlist_delivered", value: "Shortlist in 48 hours" },
      { key: "negotiation_and_followups", value: "Done-for-you" },
      { key: "post_campaign_analytics_report", value: "Full reporting pack" }, // stripped

      { key: "managed_plan_budget_note", value: true, note: "Creator budget paid separately; you set budget, we execute" },
      { key: "marketplace_fee_percent", value: 10, note: "Deducted from creator payouts" }, // stripped
    ],
    addons: [],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// INFLUENCER PLANS (USD)
// FREE / CREATOR PLUS / CREATOR PRO / TALENT MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
const influencerPlans = [
  {
    role: "Influencer",
    name: "free",
    displayName: "FREE",
    monthlyCost: 0,
    annualCost: 0,
    currency: INFLUENCER_CURRENCY,
    bestFor: "New creators starting",
    cta: { text: "Start Free", action: "start" },
    sortOrder: 1,
    autoRenew: true,

    // Optional: for local testing (remove in prod)
    durationMins: 5,

    features: [
      { key: "campaign_applications_per_month", value: 10 },
      { key: "priority_applications_per_month", value: 0, note: "shown higher to brands" },
      { key: "active_collaborations", value: 1 },

      { key: "profile_boosts_in_brand_browse_per_month", value: 0 },
      { key: "recommended_to_brands", value: false, note: "matching campaigns" },

      { key: "verified_badge", value: false },

      { key: "media_kit", value: "Standard" },
      { key: "media_kit_pdf_export", value: false },
      { key: "rate_card_builder", value: false },

      { key: "ai_pitch_assistant_drafts_per_month", value: 10 },
      { key: "pitch_templates", value: "Basic" },
      { key: "campaign_analytics", value: "Basic" },

      { key: "milestone_payment_protection", value: true },
      { key: "payout_speed_after_milestone_approval", value: "Standard (14 days)" },
      { key: "platform_fee_on_payouts_percent", value: 10 }, // stripped

      { key: "dispute_help", value: false, note: "—" },
      { key: "support", value: "Chat" },

      { key: "featured_placement_boosts_per_month", value: 0 },

      { key: "manage_creators_for_agency", value: "—" },
      { key: "team_seats", value: "—" },
      { key: "early_access_to_new_campaigns", value: "—" },
      { key: "team_workspace", value: false },
    ],
    addons: [],
  },
  {
    role: "Influencer",
    name: "creator_plus",
    displayName: "CREATOR PLUS",
    monthlyCost: 19,
    annualCost: 180,
    currency: INFLUENCER_CURRENCY,
    bestFor: "Growing creators applying more",
    cta: { text: "Start Creator Plus", action: "start" },
    sortOrder: 2,
    autoRenew: true,
    features: [
      { key: "campaign_applications_per_month", value: 50 },
      { key: "priority_applications_per_month", value: 10, note: "shown higher to brands" },
      { key: "active_collaborations", value: 5 },

      { key: "profile_boosts_in_brand_browse_per_month", value: 2, note: "boosts / month" },
      { key: "recommended_to_brands", value: true, note: "matching campaigns" },

      { key: "verified_badge", value: false },

      { key: "media_kit", value: "Full" },
      { key: "media_kit_pdf_export", value: true },
      { key: "rate_card_builder", value: true },

      { key: "ai_pitch_assistant_drafts_per_month", value: 50 },
      { key: "pitch_templates", value: "Included" },
      { key: "campaign_analytics", value: "Standard" },

      { key: "milestone_payment_protection", value: true },
      { key: "payout_speed_after_milestone_approval", value: "Faster (7 days)" },
      { key: "platform_fee_on_payouts_percent", value: 10 }, // stripped

      { key: "dispute_help", value: true },
      { key: "support", value: "Chat" },

      { key: "featured_placement_boosts_per_month", value: 2 },

      { key: "manage_creators_for_agency", value: "—" },
      { key: "team_seats", value: "—" },
      { key: "early_access_to_new_campaigns", value: "6 hours early" },
      { key: "team_workspace", value: false },
    ],
    addons: [],
  },
  {
    role: "Influencer",
    name: "creator_pro",
    displayName: "CREATOR PRO",
    monthlyCost: 29,
    annualCost: 276,
    currency: INFLUENCER_CURRENCY,
    bestFor: "Creators who want more wins",
    cta: { text: "Start Creator Pro", action: "start" },
    sortOrder: 3,
    autoRenew: true,
    features: [
      { key: "campaign_applications_per_month", value: 100 },
      { key: "priority_applications_per_month", value: 30, note: "shown higher to brands" },
      { key: "active_collaborations", value: 15 },

      { key: "profile_boosts_in_brand_browse_per_month", value: 6, note: "boosts / month" },
      { key: "recommended_to_brands", value: true, note: "matching campaigns" },

      { key: "verified_badge", value: true },

      { key: "media_kit", value: "Full + PDF export" },
      { key: "media_kit_pdf_export", value: true },
      { key: "rate_card_builder", value: true },

      { key: "ai_pitch_assistant_drafts_per_month", value: 200 },
      { key: "pitch_templates", value: "Advanced" },
      { key: "campaign_analytics", value: "Advanced" },

      { key: "milestone_payment_protection", value: true },
      { key: "payout_speed_after_milestone_approval", value: "Express (3 days)" },
      { key: "platform_fee_on_payouts_percent", value: 9 }, // stripped

      { key: "dispute_help", value: true, note: "Priority" },
      { key: "support", value: "Email + Chat" },

      { key: "featured_placement_boosts_per_month", value: 6 },

      { key: "manage_creators_for_agency", value: "—" },
      { key: "team_seats", value: "—" },
      { key: "early_access_to_new_campaigns", value: "24 hours early" },
      { key: "team_workspace", value: false },
    ],
    addons: [],
  },
  {
    role: "Influencer",
    name: "talent_management",
    displayName: "TALENT MANAGEMENT",
    monthlyCost: 199,
    annualCost: 1908,
    currency: INFLUENCER_CURRENCY,
    bestFor: "Talent managers & agencies",
    cta: { text: "Start Talent Management", action: "start" },
    sortOrder: 4,
    autoRenew: true,
    features: [
      { key: "campaign_applications_per_month", value: { unlimited: true, fair_use: true }, note: "Unlimited (fair use)" },
      { key: "priority_applications_per_month", value: { unlimited: true, fair_use: true }, note: "Unlimited (fair use)" },
      { key: "active_collaborations", value: { unlimited: true }, note: "Unlimited (team)" },

      { key: "profile_boosts_in_brand_browse_per_month", value: 20, note: "boosts / month" },
      { key: "recommended_to_brands", value: true, note: "matching campaigns" },

      { key: "verified_badge", value: true, note: "Agency verified" },

      { key: "media_kit", value: "Shared team kit + PDF export" },
      { key: "media_kit_pdf_export", value: true },
      { key: "rate_card_builder", value: true, note: "team rate cards" },

      { key: "ai_pitch_assistant_drafts_per_month", value: 500 },
      { key: "pitch_templates", value: "Team templates" },
      { key: "campaign_analytics", value: "Team analytics" },

      { key: "milestone_payment_protection", value: true },
      { key: "payout_speed_after_milestone_approval", value: "Express+ (2 days)" },
      { key: "platform_fee_on_payouts_percent", value: 8 }, // stripped

      { key: "dispute_help", value: true, note: "Priority + escalation" },
      { key: "support", value: "Email + Phone" },

      { key: "featured_placement_boosts_per_month", value: 20 },

      { key: "manage_creators_for_agency", value: "5 creators included", note: "add more as needed" },
      { key: "team_seats", value: "2 seats included" },
      { key: "early_access_to_new_campaigns", value: "Immediate" },
      { key: "team_workspace", value: true },
    ],
    addons: [],
  },
];

const plans = [...brandPlans, ...influencerPlans].map(stripRemovedFeatures);

async function seed() {
  try {
    const { MONGODB_URI } = process.env;
    if (!MONGODB_URI) throw new Error("Set MONGODB_URI in .env");

    await mongoose.connect(MONGODB_URI);
    console.log("✅ MongoDB connected");

    await SubscriptionPlan.deleteMany({});
    console.log("🗑️  Cleared existing subscription plans");

    const inserted = await SubscriptionPlan.insertMany(plans);
    console.log(`✅ Inserted ${inserted.length} subscription plans`);
  } catch (err) {
    console.error("❌ Error seeding plans:", err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 MongoDB disconnected");
    process.exit(0);
  }
}

seed();
