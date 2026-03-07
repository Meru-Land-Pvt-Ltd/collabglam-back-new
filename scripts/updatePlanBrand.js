/**
 * scripts/migrate_all_to_free.js
 *
 * Usage:
 *   node scripts/migrate_all_to_free.js --dry-run
 *   node scripts/migrate_all_to_free.js
 *
 * Env:
 *   MONGO_URI=mongodb+srv://...
 *   BRAND_FREE_PLAN_ID=...            (optional override)
 *   INFLUENCER_FREE_PLAN_ID=...       (optional override)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

// ✅ Update these paths if your project structure differs
const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const SubscriptionPlan = require("../models/subscription"); // model name is SubscriptionPlan in this file

// From your schema
const DEFAULT_BRAND_FREE_PLAN_ID = "4c6e497d-a6f9-4c3b-8d64-65bf843be685";

// ---------------- CLI flags (simple parsing, no deps) ----------------
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getArgVal = (k) => {
  const idx = args.indexOf(k);
  if (idx === -1) return undefined;
  return args[idx + 1];
};

const DRY_RUN = hasFlag("--dry-run");
const ONLY_BRANDS = hasFlag("--only-brands");
const ONLY_INFLUENCERS = hasFlag("--only-influencers");
const BATCH_SIZE = Number(getArgVal("--batch") || 500);

const BRAND_FREE_PLAN_ID_OVERRIDE =
  getArgVal("--brand-free-plan-id") || process.env.BRAND_FREE_PLAN_ID;

const INFLUENCER_FREE_PLAN_ID_OVERRIDE =
  getArgVal("--influencer-free-plan-id") || process.env.INFLUENCER_FREE_PLAN_ID;

// ---------------- Helpers ----------------
function nowISO() {
  return new Date().toISOString();
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Convert SubscriptionPlan.features -> embedded subscription.features
 * Works with different shapes:
 * - if value is number -> treat as limit
 * - if value is object and has limit/max -> use that
 * - else -> unlimited (-1)
 */
function buildEmbeddedFeatures(plan) {
  const features = Array.isArray(plan?.features) ? plan.features : [];
  return features.map((f) => {
    let limit = -1; // -1 = unlimited by your note "<= 0 => unlimited"; we keep -1 safe
    const value = f?.value ?? null;

    if (typeof value === "number") limit = value;
    else if (value && typeof value === "object") {
      if (typeof value.limit === "number") limit = value.limit;
      else if (typeof value.max === "number") limit = value.max;
    }

    return {
      key: String(f.key),
      value,
      limit,
      used: 0,
      note: f.note ?? null,
      resetsEvery: null,
      resetsAt: null,
    };
  });
}

/**
 * Influencer embedded feature schema is: { key, limit, used }
 * We’ll map similarly, dropping value/note fields.
 */
function buildInfluencerFeatures(plan) {
  const features = Array.isArray(plan?.features) ? plan.features : [];
  return features.map((f) => {
    let limit = -1;
    const value = f?.value ?? null;

    if (typeof value === "number") limit = value;
    else if (value && typeof value === "object") {
      if (typeof value.limit === "number") limit = value.limit;
      else if (typeof value.max === "number") limit = value.max;
    }

    return {
      key: String(f.key),
      limit,
      used: 0,
    };
  });
}

async function getFreePlanForRole(role) {
  // If override IDs are provided, try to load by planId first.
  const override =
    role === "Brand" ? BRAND_FREE_PLAN_ID_OVERRIDE : INFLUENCER_FREE_PLAN_ID_OVERRIDE;

  if (override) {
    const p = await SubscriptionPlan.findOne({ planId: override }).lean();
    if (!p) {
      throw new Error(
        `Override ${role} free planId "${override}" not found in SubscriptionPlan`
      );
    }
    return p;
  }

  // Auto-discover latest active "free" plan for role
  const p = await SubscriptionPlan.findOne({
    role,
    name: "free",
    status: "active",
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!p) {
    // Brand has a schema default free planId; fallback only for Brand if not found
    if (role === "Brand") {
      return {
        _id: null,
        planId: DEFAULT_BRAND_FREE_PLAN_ID,
        role: "Brand",
        name: "free",
        monthlyCost: 0,
        annualCost: 0,
        durationMins: 43200,
        features: [],
      };
    }
    throw new Error(
      `No active free plan found in SubscriptionPlan for role="${role}". Provide INFLUENCER_FREE_PLAN_ID or create a free plan.`
    );
  }

  return p;
}

// ---------------- Main migration ----------------
async function migrateBrands(freePlan, csvStream) {
  const startedAt = new Date();
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  const cursor = Brand.find(
    {},
    { email: 1, brandId: 1, subscription: 1, subscriptionExpired: 1 }
  )
    .lean()
    .cursor();

  let ops = [];

  for await (const b of cursor) {
    scanned++;

    const oldPlanId = b?.subscription?.planId ?? "";
    const oldPlanName = b?.subscription?.planName ?? "";
    const alreadyFree =
      String(oldPlanName).toLowerCase() === "free" &&
      String(oldPlanId) === String(freePlan.planId);

    // Write audit line always (so you have a complete mapping)
    csvStream.write(
      [
        "Brand",
        b._id,
        b.brandId ?? "",
        b.email ?? "",
        oldPlanName,
        oldPlanId,
        "free",
        freePlan.planId,
        nowISO(),
        alreadyFree ? "SKIP_ALREADY_FREE" : DRY_RUN ? "DRY_RUN" : "UPDATED",
      ]
        .map(csvEscape)
        .join(",") + "\n"
    );

    if (alreadyFree) {
      skipped++;
      continue;
    }

    updated++;

    if (!DRY_RUN) {
      const embeddedFeatures = buildEmbeddedFeatures(freePlan);

      ops.push({
        updateOne: {
          filter: { _id: b._id },
          update: {
            $set: {
              "subscription.planId": freePlan.planId,
              "subscription.planName": "free",
              "subscription.role": "Brand",
              "subscription.planRef": freePlan._id ?? null,
              "subscription.monthlyCost": freePlan.monthlyCost ?? 0,
              "subscription.annualCost": freePlan.annualCost ?? 0,
              "subscription.billingCycle": "monthly",
              "subscription.autoRenew": false,
              "subscription.status": "active",
              "subscription.startedAt": startedAt,
              "subscription.expiresAt": null,
              "subscription.durationMins": freePlan.durationMins ?? 43200,
              "subscription.features": embeddedFeatures,
              "subscription.internalCredits": { used: 0, resetsAt: null },
              subscriptionExpired: false,
            },
          },
        },
      });

      if (ops.length >= BATCH_SIZE) {
        await Brand.bulkWrite(ops, { ordered: false });
        ops = [];
      }
    }
  }

  if (!DRY_RUN && ops.length) {
    await Brand.bulkWrite(ops, { ordered: false });
  }

  return { scanned, updated, skipped };
}

async function migrateInfluencers(freePlan, csvStream) {
  const startedAt = new Date();
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  const cursor = Influencer.find(
    {},
    { email: 1, influencerId: 1, subscription: 1, subscriptionExpired: 1 }
  )
    .lean()
    .cursor();

  let ops = [];

  for await (const inf of cursor) {
    scanned++;

    const oldPlanId = inf?.subscription?.planId ?? "";
    const oldPlanName = inf?.subscription?.planName ?? "";
    const alreadyFree =
      String(oldPlanName).toLowerCase() === "free" &&
      String(oldPlanId) === String(freePlan.planId);

    csvStream.write(
      [
        "Influencer",
        inf._id,
        inf.influencerId ?? "",
        inf.email ?? "",
        oldPlanName,
        oldPlanId,
        "free",
        freePlan.planId,
        nowISO(),
        alreadyFree ? "SKIP_ALREADY_FREE" : DRY_RUN ? "DRY_RUN" : "UPDATED",
      ]
        .map(csvEscape)
        .join(",") + "\n"
    );

    if (alreadyFree) {
      skipped++;
      continue;
    }

    updated++;

    if (!DRY_RUN) {
      const embeddedFeatures = buildInfluencerFeatures(freePlan);

      ops.push({
        updateOne: {
          filter: { _id: inf._id },
          update: {
            $set: {
              "subscription.planId": freePlan.planId,
              "subscription.planName": "free",
              "subscription.startedAt": startedAt,
              "subscription.expiresAt": null,
              "subscription.features": embeddedFeatures,
              subscriptionExpired: false,
            },
          },
        },
      });

      if (ops.length >= BATCH_SIZE) {
        await Influencer.bulkWrite(ops, { ordered: false });
        ops = [];
      }
    }
  }

  if (!DRY_RUN && ops.length) {
    await Influencer.bulkWrite(ops, { ordered: false });
  }

  return { scanned, updated, skipped };
}

async function main() {
  const MONGO_URI = process.env.MONGODB_URI;
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI in environment.");
  }

  await mongoose.connect(MONGO_URI, {
    autoIndex: false,
    serverSelectionTimeoutMS: 30000,
  });

  const brandFree = await getFreePlanForRole("Brand");
  const influencerFree = await getFreePlanForRole("Influencer");

  const outDir = path.join(process.cwd(), "migration_reports");
  fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(
    outDir,
    `plan_to_free_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`
  );
  const csvStream = fs.createWriteStream(outFile, { encoding: "utf8" });

  csvStream.write(
    [
      "userType",
      "mongoId",
      "publicId",
      "email",
      "oldPlanName",
      "oldPlanId",
      "newPlanName",
      "newPlanId",
      "loggedAt",
      "action",
    ].join(",") + "\n"
  );

  const summary = {
    dryRun: DRY_RUN,
    batchSize: BATCH_SIZE,
    brandFreePlan: { planId: brandFree.planId, _id: brandFree._id ?? null },
    influencerFreePlan: {
      planId: influencerFree.planId,
      _id: influencerFree._id ?? null,
    },
    brands: null,
    influencers: null,
  };

  if (!ONLY_INFLUENCERS) {
    summary.brands = await migrateBrands(brandFree, csvStream);
  }
  if (!ONLY_BRANDS) {
    summary.influencers = await migrateInfluencers(influencerFree, csvStream);
  }

  csvStream.end();

  console.log("\n✅ Migration finished");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n📄 Report written to: ${outFile}\n`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("❌ Migration failed:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
