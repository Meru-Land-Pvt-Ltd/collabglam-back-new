// controllers/subscriptionController.js

const SubscriptionPlan = require("../models/subscription");
const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const { computeExpiry } = require("../utils/subscriptionHelper");

// Helper: normalize feature value into a numeric limit for usage tracking snapshot
// - number => that number
// - { unlimited: true } => -1
// - other => 0
function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

/**
 * HIDE THESE FROM ANY "GET PLANS" RESPONSE
 * Brand: marketplace_fee_percent
 * Influencer: platform_fee_on_payouts_percent
 */
const HIDDEN_FEATURE_KEYS = new Set([
  "marketplace_fee_percent",
  "platform_fee_on_payouts_percent",
]);

function sanitizePlanForResponse(plan) {
  if (!plan || typeof plan !== "object") return plan;

  const out = { ...plan };

  if (Array.isArray(plan.features)) {
    out.features = plan.features.filter(
      (f) => f && typeof f === "object" && !HIDDEN_FEATURE_KEYS.has(f.key)
    );
  }

  return out;
}

function sanitizePlansForResponse(plans) {
  if (!Array.isArray(plans)) return [];
  return plans.map(sanitizePlanForResponse);
}

// POST /subscription-plans/create
// body: full plan object (role, name, monthlyCost required)
exports.createPlan = async (req, res) => {
  try {
    const {
      role,
      name,
      displayName,
      label,

      monthlyCost,
      annualCost,
      currency,

      isCustomPricing,
      isStartingAt,

      bestFor,
      mainOutcome,
      overview,
      cta,

      features,
      addons,

      durationDays,
      durationMins,
      durationMinutes,
      autoRenew,
      status,
      sortOrder,
    } = req.body;

    if (!role || !name || monthlyCost == null) {
      return res
        .status(400)
        .json({ message: "role, name and monthlyCost are required" });
    }

    // Basic guard (you can loosen if your schema allows more)
    if (!["Brand", "Influencer"].includes(role)) {
      return res.status(400).json({ message: "role must be Brand or Influencer" });
    }

    const plan = new SubscriptionPlan({
      role,
      name,
      displayName: displayName || name.toUpperCase(),
      label: label || undefined,

      monthlyCost,
      annualCost: annualCost ?? undefined,
      currency: currency || "USD",

      isCustomPricing: !!isCustomPricing,
      isStartingAt: !!isStartingAt,

      bestFor: bestFor || undefined,
      mainOutcome: mainOutcome || undefined,
      overview: overview || undefined,
      cta: cta || undefined,

      features: Array.isArray(features) ? features : [],
      addons: Array.isArray(addons) ? addons : [],

      durationDays: durationDays ?? undefined,
      durationMins: durationMins ?? undefined,
      durationMinutes: durationMinutes ?? undefined,

      autoRenew: autoRenew ?? true,
      status: status || "active",
      sortOrder: sortOrder ?? 100,
    });

    await plan.save();
    return res.status(201).json({ message: "Subscription plan created", plan });
  } catch (err) {
    console.error("createPlan error:", err);

    // Duplicate key (role+name unique) or planId unique conflicts
    if (err?.code === 11000) {
      return res.status(409).json({
        message: "Plan already exists (duplicate role+name or planId).",
        detail: err.keyValue,
      });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/list
// body: { role?, includeArchived? }
exports.getPlans = async (req, res) => {
  const { role, includeArchived } = req.body || {};
  const filter = {};

  if (role) filter.role = role;
  if (!includeArchived) filter.status = "active";

  try {
    // sortOrder first (pricing table order), then monthlyCost
    const plans = await SubscriptionPlan.find(filter)
      .sort({ sortOrder: 1, monthlyCost: 1 })
      .lean();

    // Hide fee features in response
    const safePlans = sanitizePlansForResponse(plans);

    return res.status(200).json({ message: "Plans retrieved", plans: safePlans });
  } catch (err) {
    console.error("getPlans error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /subscription-plans/get?id=<planId>
exports.getPlanById = async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ message: "Query param id is required" });

  try {
    const plan = await SubscriptionPlan.findOne({ planId: id }).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    // Hide fee features in response
    const safePlan = sanitizePlanForResponse(plan);

    return res.status(200).json({ message: "Plan retrieved", plan: safePlan });
  } catch (err) {
    console.error("getPlanById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/update
// body: { planId?: <planId>, id?: <planId>, ...fieldsToUpdate }
exports.updatePlan = async (req, res) => {
  const { planId, id, ...updates } = req.body || {};
  const targetPlanId = planId || id;

  if (!targetPlanId) {
    return res.status(400).json({ message: "planId (or id) is required" });
  }

  // Prevent changing planId via update
  delete updates.planId;

  try {
    const plan = await SubscriptionPlan.findOneAndUpdate(
      { planId: targetPlanId },
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (!plan) return res.status(404).json({ message: "Plan not found" });

    return res.status(200).json({ message: "Plan updated", plan });
  } catch (err) {
    console.error("updatePlan error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        message: "Update causes duplicate role+name (or duplicate unique field).",
        detail: err.keyValue,
      });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/delete
// body: { planId?: <planId>, id?: <planId> }
exports.deletePlan = async (req, res) => {
  const { planId, id } = req.body || {};
  const targetPlanId = planId || id;

  if (!targetPlanId) {
    return res.status(400).json({ message: "Plan id (planId or id) is required" });
  }

  try {
    const plan = await SubscriptionPlan.findOneAndDelete({ planId: targetPlanId });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    return res.status(200).json({ message: "Plan deleted" });
  } catch (err) {
    console.error("deletePlan error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/assign
// body: { userType: 'Brand'|'Influencer', userId, planId }
exports.assignPlan = async (req, res) => {
  try {
    const { userType, userId, planId } = req.body || {};
    if (!userType || !userId || !planId) {
      return res
        .status(400)
        .json({ message: "userType, userId & planId are required" });
    }

    if (!["Brand", "Influencer"].includes(userType)) {
      return res.status(400).json({ message: "userType must be Brand or Influencer" });
    }

    const Model = userType === "Brand" ? Brand : Influencer;

    const plan = await SubscriptionPlan.findOne({
      planId,
      role: userType,
      status: "active",
    }).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const now = new Date();
    const { billingCycle, durationDays, durationMinutes, durationMins, expiresAt } = req.body || {};

    const expire = subscriptionHelper.computeExpiry(plan, {
      billingCycle: billingCycle || "monthly",
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt
    });

    // Snapshot for usage tracking:
    const featureSnapshot = (plan.features || []).map((f) => ({
      key: f.key,
      limit: featureValueToLimit(f.value),
      used: 0,
    }));

    const update = {
      "subscription.planId": plan.planId,
      "subscription.planName": plan.name,
      "subscription.startedAt": now,
      "subscription.expiresAt": expire,
      "subscription.features": featureSnapshot,
      subscriptionExpired: false,
    };

    const query =
      userType === "Brand" ? { brandId: userId } : { influencerId: userId };

    const updated = await Model.findOneAndUpdate(query, update, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res
        .status(404)
        .json({ message: `${userType} with ID ${userId} not found` });
    }

    return res.json({
      message: `${userType} subscribed to "${plan.name}". It will expire at ${expire.toISOString()}`,
      subscription: updated.subscription,
    });
  } catch (error) {
    console.error("assignPlan error:", error);
    return res
      .status(500)
      .json({ message: "Internal server error while assigning plan." });
  }
};

// POST /subscription-plans/renew
// body: { userType: 'Brand'|'Influencer', userId }
exports.renewPlan = async (req, res) => {
  try {
    const { userType, userId } = req.body || {};
    if (!userType || !userId) {
      return res.status(400).json({ message: "userType & userId required" });
    }

    if (!["Brand", "Influencer"].includes(userType)) {
      return res.status(400).json({ message: "userType must be Brand or Influencer" });
    }

    const Model = userType === "Brand" ? Brand : Influencer;

    const user = await Model.findOne(
      userType === "Brand" ? { brandId: userId } : { influencerId: userId }
    );

    if (!user) {
      return res
        .status(404)
        .json({ message: `${userType} with ID ${userId} not found` });
    }

    const currentPlanId = user?.subscription?.planId;
    if (!currentPlanId) {
      return res.status(400).json({ message: "User has no active subscription planId" });
    }

    const plan = await SubscriptionPlan.findOne({ planId: currentPlanId });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const now = new Date();
    const newExpires = subscriptionHelper.computeExpiry(
      plan,
      user.subscription.expiresAt
    );

    user.subscription.startedAt = now;
    user.subscription.expiresAt = newExpires;
    user.subscription.features = (plan.features || []).map((f) => ({
      key: f.key,
      limit: featureValueToLimit(f.value),
      used: 0,
    }));
    user.subscriptionExpired = false;

    await user.save();

    return res.json({
      message: `${userType} subscription renewed until ${newExpires.toISOString()}`,
      subscription: user.subscription,
    });
  } catch (err) {
    console.error("renewPlan error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/my-plan
// body: { userType: 'Brand'|'Influencer', userId }
exports.getMyPlan = async (req, res) => {
  try {
    const { userType, userId } = req.body || {};
    if (!userType || !userId) {
      return res.status(400).json({ message: "userType & userId required" });
    }

    if (!["Brand", "Influencer"].includes(userType)) {
      return res.status(400).json({ message: "userType must be Brand or Influencer" });
    }

    const Model = userType === "Brand" ? Brand : Influencer;

    const user = await Model.findOne(
      userType === "Brand" ? { brandId: userId } : { influencerId: userId }
    ).lean();

    if (!user) return res.status(404).json({ message: `${userType} not found` });

    const sub = user.subscription || {};
    const planDoc = sub.planId
      ? await SubscriptionPlan.findOne({ planId: sub.planId }).lean()
      : null;

    // Hide fee features in response
    const safePlanDoc = planDoc ? sanitizePlanForResponse(planDoc) : null;

    return res.json({
      message: "Current subscription fetched",
      plan: safePlanDoc, // full plan metadata (with hidden fee features removed)
      startedAt: sub.startedAt || null,
      expiresAt: sub.expiresAt || null,
      expired: !!user.subscriptionExpired,
    });
  } catch (err) {
    console.error("getMyPlan error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

function normalizedMonthlyCost(plan) {
  if (!plan) return 0;

  // Treat custom pricing as highest tier (so it always counts as "higher")
  if (plan.isCustomPricing) return Number.MAX_SAFE_INTEGER;

  if (typeof plan.monthlyCost === "number") return plan.monthlyCost;

  // fallback: if only annual exists
  if (typeof plan.annualCost === "number") return plan.annualCost / 12;

  return 0;
}

exports.checkBrandPlanChange = async (req, res) => {
  try {
    const { brandId, planId } = req.body || {};

    if (!brandId || !planId) {
      return res.status(400).json({ message: "brandId & planId are required" });
    }

    const brand = await Brand.findOne({ brandId }).lean();
    if (!brand) return res.status(404).json({ message: "Brand not found" });

    const requestedPlan = await SubscriptionPlan.findOne({ planId }).lean();
    if (!requestedPlan) return res.status(404).json({ message: "Requested plan not found" });

    const sub = brand.subscription || {};
    const currentPlanId = sub.planId;

    // No subscription at all
    if (!currentPlanId) {
      return res.status(200).json({
        status: "can_subscribe",
        canProceed: true,
        message: "You have no active plan. You can subscribe to this plan.",
        currentPlanId: null,
        requestedPlanId: requestedPlan.planId,
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    // Expired subscription -> treat as can subscribe
    const now = new Date();
    const isExpired =
      brand.subscriptionExpired === true ||
      (sub.expiresAt && new Date(sub.expiresAt).getTime() < now.getTime());

    if (isExpired) {
      return res.status(200).json({
        status: "expired_can_subscribe",
        canProceed: true,
        message: "Your subscription is expired. You can subscribe to this plan.",
        currentPlanId,
        requestedPlanId: requestedPlan.planId,
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    // Same plan
    if (currentPlanId === requestedPlan.planId) {
      return res.status(200).json({
        status: "same_plan",
        canProceed: false,
        message: "You are already subscribed to the same plan.",
        currentPlanId,
        requestedPlanId: requestedPlan.planId,
      });
    }

    // Load current plan doc
    const currentPlan = await SubscriptionPlan.findOne({ planId: currentPlanId }).lean();

    // If current plan doc missing in DB, allow subscribe (fallback)
    if (!currentPlan) {
      return res.status(200).json({
        status: "can_subscribe",
        canProceed: true,
        message: "Current plan details not found, you can subscribe to this plan.",
        currentPlanId,
        requestedPlanId: requestedPlan.planId,
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    const currentRank = normalizedMonthlyCost(currentPlan);
    const requestedRank = normalizedMonthlyCost(requestedPlan);

    // Requested is lower (downgrade attempt)
    if (requestedRank < currentRank) {
      return res.status(200).json({
        status: "already_higher",
        canProceed: false,
        message: `You are already on a higher plan (${currentPlan.name}).`,
        currentPlanId: currentPlan.planId,
        requestedPlanId: requestedPlan.planId,
        currentPlan: sanitizePlanForResponse(currentPlan),
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    // Requested is higher (upgrade)
    if (requestedRank > currentRank) {
      return res.status(200).json({
        status: "can_upgrade",
        canProceed: true,
        message: `You can upgrade from ${currentPlan.name} to ${requestedPlan.name}.`,
        currentPlanId: currentPlan.planId,
        requestedPlanId: requestedPlan.planId,
        currentPlan: sanitizePlanForResponse(currentPlan),
        requestedPlan: sanitizePlanForResponse(requestedPlan),
      });
    }

    // Same "rank" (same price), but different planId (rare)
    return res.status(200).json({
      status: "same_tier_different_plan",
      canProceed: true,
      message: `This plan is in the same tier as your current plan (${currentPlan.name}). You can switch if allowed.`,
      currentPlanId: currentPlan.planId,
      requestedPlanId: requestedPlan.planId,
      currentPlan: sanitizePlanForResponse(currentPlan),
      requestedPlan: sanitizePlanForResponse(requestedPlan),
    });
  } catch (err) {
    console.error("checkBrandPlanChange error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getCurrentBrandPlanLite = async (req, res) => {
  try {
    const brandId = req.query?.brandId;

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required in query" });
    }

    const brand = await Brand.findOne({ brandId }).lean();
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const sub = brand.subscription || {};
    const now = new Date();

    const isExpired =
      brand.subscriptionExpired === true ||
      (sub.expiresAt && new Date(sub.expiresAt).getTime() < now.getTime());

    // ✅ expired OR no plan => free
    if (isExpired || !sub.planId) {
      return res.status(200).json({
        brandPlanId: null,
        brandPlanName: "free",
      });
    }

    let brandPlanId = sub.planId || null;
    let brandPlanName = sub.planName || null;

    // fallback if planName missing
    if (brandPlanId && !brandPlanName) {
      const plan = await SubscriptionPlan.findOne({ planId: brandPlanId })
        .select("name")
        .lean();
      brandPlanName = plan?.name || null;
    }

    return res.status(200).json({
      brandPlanId,
      brandPlanName: brandPlanName ? String(brandPlanName).toLowerCase() : null,
    });
  } catch (err) {
    console.error("getCurrentBrandPlanLite error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};