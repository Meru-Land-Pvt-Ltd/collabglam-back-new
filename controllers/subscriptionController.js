// controllers/subscriptionController.js

const SubscriptionPlan = require("../models/subscription");

const BrandModelImport = require("../models/brand");
const InfluencerModelImport = require("../models/influencer");

const Brand =
  BrandModelImport?.BrandModel ||
  BrandModelImport?.default ||
  BrandModelImport;

const Influencer =
  InfluencerModelImport?.InfluencerModel ||
  InfluencerModelImport?.default ||
  InfluencerModelImport;

const subscriptionHelper = require("../utils/subscriptionHelper");
const { sendEmail, uploadEmailRecordToS3 } = require("../services/emailService");

function assertValidModel(Model, label) {
  if (!Model || typeof Model.find !== "function") {
    throw new Error(`${label} model is invalid. Expected a Mongoose model.`);
  }
}

assertValidModel(Brand, "Brand");
assertValidModel(Influencer, "Influencer");

function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

function getUserEmail(user) {
  return String(
    user?.email ||
      user?.proxyEmail ||
      user?.contactEmail ||
      ""
  )
    .trim()
    .toLowerCase();
}

function getUserDisplayName(user, userType) {
  if (userType === "Brand") {
    return user?.brandName || user?.name || "Brand User";
  }

  return user?.name || user?.fullName || user?.username || "Influencer";
}

function formatDateTime(value) {
  if (!value) return "N/A";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "N/A";
  return d.toUTCString();
}

function buildSubscriptionEmailTemplate({
  userType,
  userName,
  planName,
  oldPlanName,
  expiresAt,
  eventType,
}) {
  const endDate = formatDateTime(expiresAt);
  const appName = "Collabglam";

  let subject = "";
  let heading = "";
  let intro = "";

  if (eventType === "upgraded") {
    subject = `${appName}: Your ${userType} plan has been upgraded`;
    heading = "Your subscription has been upgraded";
    intro = oldPlanName
      ? `Your plan has been upgraded from <strong>${oldPlanName}</strong> to <strong>${planName}</strong>.`
      : `Your subscription is now active on the <strong>${planName}</strong> plan.`;
  } else if (eventType === "renewed") {
    subject = `${appName}: Your ${userType} plan has been renewed`;
    heading = "Your subscription has been renewed";
    intro = `Your <strong>${planName}</strong> subscription has been renewed successfully.`;
  } else if (eventType === "expiring_soon") {
    subject = `${appName}: Your ${userType} subscription is about to end`;
    heading = "Your subscription is ending soon";
    intro = `Your <strong>${planName}</strong> subscription is about to expire.`;
  } else if (eventType === "expired") {
    subject = `${appName}: Your ${userType} subscription has ended`;
    heading = "Your subscription has ended";
    intro = `Your <strong>${planName}</strong> subscription has expired.`;
  } else {
    subject = `${appName}: Subscription update`;
    heading = "Subscription update";
    intro = `There is an update on your <strong>${planName}</strong> subscription.`;
  }

  const text = [
    `Hello ${userName},`,
    "",
    intro.replace(/<[^>]+>/g, ""),
    `Plan: ${planName || "N/A"}`,
    `Ends on: ${endDate}`,
    "",
    "If you need help, please contact support.",
    "",
    `- ${appName}`,
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;">
      <h2>${heading}</h2>
      <p>Hello ${userName},</p>
      <p>${intro}</p>
      <p><strong>Plan:</strong> ${planName || "N/A"}</p>
      <p><strong>Ends on:</strong> ${endDate}</p>
      <p>If you need help, please contact support.</p>
      <p>– ${appName}</p>
    </div>
  `;

  return { subject, text, html };
}

async function sendSubscriptionLifecycleEmail({
  userType,
  user,
  plan,
  oldPlanName = null,
  eventType,
}) {
  try {
    const to = getUserEmail(user);

    if (!to) {
      console.warn(`[subscription-email] skipped: no email for ${userType}`, {
        userId: user?._id || user?.influencerId,
        eventType,
      });
      return;
    }

    const userName = getUserDisplayName(user, userType);
    const planName =
      plan?.displayName ||
      plan?.label ||
      plan?.name ||
      user?.subscription?.planName ||
      "Plan";
    const expiresAt = user?.subscription?.expiresAt || null;

    const { subject, text, html } = buildSubscriptionEmailTemplate({
      userType,
      userName,
      planName,
      oldPlanName,
      expiresAt,
      eventType,
    });

    const emailResp = await sendEmail({
      to,
      subject,
      text,
      html,
      emailTags: [
        { Name: "module", Value: "subscription" },
        { Name: "event", Value: eventType },
        { Name: "userType", Value: String(userType).toLowerCase() },
      ],
    });

    try {
      await uploadEmailRecordToS3({
        type: "subscription_lifecycle",
        eventType,
        userType,
        userId: String(user?._id || user?.influencerId || ""),
        email: to,
        planId: plan?.planId || user?.subscription?.planId || null,
        planName,
        oldPlanName,
        expiresAt,
        emailMessageId: emailResp?.messageId || null,
        sentAt: new Date().toISOString(),
      });
    } catch (archiveErr) {
      console.error("[subscription-email] archive failed:", archiveErr);
    }
  } catch (err) {
    console.error("[subscription-email] send failed:", err);
  }
}

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

function getQueryForUser(userType, userId) {
  return userType === "Brand" ? { _id: userId } : { _id: userId };
}

function buildFeatureSnapshot(plan) {
  return (plan.features || []).map((f) => ({
    key: f.key,
    limit: featureValueToLimit(f.value),
    used: 0,
  }));
}

function normalizedMonthlyCost(plan) {
  if (!plan) return 0;
  if (plan.isCustomPricing) return Number.MAX_SAFE_INTEGER;
  if (typeof plan.monthlyCost === "number") return plan.monthlyCost;
  if (typeof plan.annualCost === "number") return plan.annualCost / 12;
  return 0;
}

// POST /subscription-plans/create
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
exports.getPlans = async (req, res) => {
  const { role, includeArchived } = req.body || {};
  const filter = {};

  if (role) filter.role = role;
  if (!includeArchived) filter.status = "active";

  try {
    const plans = await SubscriptionPlan.find(filter)
      .sort({ sortOrder: 1, monthlyCost: 1 })
      .lean();

    const safePlans = sanitizePlansForResponse(plans);

    return res.status(200).json({ message: "Plans retrieved", plans: safePlans });
  } catch (err) {
    console.error("getPlans error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /subscription-plans/getById?id=<planId>
exports.getPlanById = async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ message: "Query param id is required" });

  try {
    const plan = await SubscriptionPlan.findOne({ planId: id }).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const safePlan = sanitizePlanForResponse(plan);
    return res.status(200).json({ message: "Plan retrieved", plan: safePlan });
  } catch (err) {
    console.error("getPlanById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/update
exports.updatePlan = async (req, res) => {
  const { planId, id, ...updates } = req.body || {};
  const targetPlanId = planId || id;

  if (!targetPlanId) {
    return res.status(400).json({ message: "planId (or id) is required" });
  }

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

    if (!plan) {
      return res.status(404).json({ message: "Plan not found" });
    }

    const {
      billingCycle,
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt,
    } = req.body || {};

    const now = new Date();

    const expire = subscriptionHelper.computeExpiry(plan, {
      billingCycle: billingCycle || "monthly",
      durationDays,
      durationMinutes,
      durationMins,
      expiresAt,
    });

    const featureSnapshot = buildFeatureSnapshot(plan);
    const query = getQueryForUser(userType, userId);

    const existingUser = await Model.findOne(query);
    if (!existingUser) {
      return res
        .status(404)
        .json({ message: `${userType} with ID ${userId} not found` });
    }

    const oldPlanName = existingUser?.subscription?.planName || "free";

    existingUser.subscription = existingUser.subscription || {};
    existingUser.subscription.planId = plan.planId;
    existingUser.subscription.planName = plan.name;
    existingUser.subscription.startedAt = now;
    existingUser.subscription.expiresAt = expire;
    existingUser.subscription.features = featureSnapshot;
    existingUser.subscription.lastExpiringSoonEmailSentAt = null;
    existingUser.subscription.lastExpiredEmailSentAt = null;
    existingUser.subscriptionExpired = false;

    await existingUser.save();

    await sendSubscriptionLifecycleEmail({
      userType,
      user: existingUser,
      plan,
      oldPlanName,
      eventType: "upgraded",
    });

    return res.json({
      message: `${userType} subscribed to "${plan.name}". It will expire at ${expire.toISOString()}`,
      subscription: existingUser.subscription,
    });
  } catch (error) {
    console.error("assignPlan error:", error);
    return res
      .status(500)
      .json({ message: "Internal server error while assigning plan." });
  }
};

// POST /subscription-plans/renew
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
    const query = getQueryForUser(userType, userId);

    const user = await Model.findOne(query);

    if (!user) {
      return res
        .status(404)
        .json({ message: `${userType} with ID ${userId} not found` });
    }

    const currentPlanId = user?.subscription?.planId;
    if (!currentPlanId) {
      return res.status(400).json({ message: "User has no active subscription planId" });
    }

    const plan = await SubscriptionPlan.findOne({ planId: currentPlanId }).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const now = new Date();
    const newExpires = subscriptionHelper.computeExpiry(plan, {
      billingCycle: "monthly",
      expiresAt: user.subscription.expiresAt,
    });

    user.subscription.planId = plan.planId;
    user.subscription.planName = plan.name;
    user.subscription.startedAt = now;
    user.subscription.expiresAt = newExpires;
    user.subscription.features = buildFeatureSnapshot(plan);
    user.subscription.lastExpiringSoonEmailSentAt = null;
    user.subscription.lastExpiredEmailSentAt = null;
    user.subscriptionExpired = false;

    await user.save();

    await sendSubscriptionLifecycleEmail({
      userType,
      user,
      plan,
      eventType: "renewed",
    });

    return res.json({
      message: `${userType} subscription renewed until ${newExpires.toISOString()}`,
      subscription: user.subscription,
    });
  } catch (err) {
    console.error("renewPlan error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/me
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
    const query = getQueryForUser(userType, userId);

    const user = await Model.findOne(query).lean();
    if (!user) return res.status(404).json({ message: `${userType} not found` });

    const sub = user.subscription || {};
    const planDoc = sub.planId
      ? await SubscriptionPlan.findOne({ planId: sub.planId }).lean()
      : null;

    const safePlanDoc = planDoc ? sanitizePlanForResponse(planDoc) : null;

    return res.json({
      message: "Current subscription fetched",
      plan: safePlanDoc,
      startedAt: sub.startedAt || null,
      expiresAt: sub.expiresAt || null,
      expired: !!user.subscriptionExpired,
    });
  } catch (err) {
    console.error("getMyPlan error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.checkBrandPlanChange = async (req, res) => {
  try {
    const { brandId, userId, planId } = req.body || {};
    const targetBrandId = brandId || userId;

    if (!targetBrandId || !planId) {
      return res.status(400).json({ message: "brandId/userId & planId are required" });
    }

    const brand = await Brand.findOne({ _id: targetBrandId }).lean();
    if (!brand) return res.status(404).json({ message: "Brand not found" });

    const requestedPlan = await SubscriptionPlan.findOne({ planId }).lean();
    if (!requestedPlan) {
      return res.status(404).json({ message: "Requested plan not found" });
    }

    const sub = brand.subscription || {};
    const currentPlanId = sub.planId;

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

    if (currentPlanId === requestedPlan.planId) {
      return res.status(200).json({
        status: "same_plan",
        canProceed: false,
        message: "You are already subscribed to the same plan.",
        currentPlanId,
        requestedPlanId: requestedPlan.planId,
      });
    }

    const currentPlan = await SubscriptionPlan.findOne({ planId: currentPlanId }).lean();

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

    const brand = await Brand.findOne({ _id: brandId }).lean();
    if (!brand) {
      return res.status(404).json({ message: "Brand not found" });
    }

    const sub = brand.subscription || {};
    const now = new Date();

    const isExpired =
      brand.subscriptionExpired === true ||
      (sub.expiresAt && new Date(sub.expiresAt).getTime() < now.getTime());

    if (isExpired || !sub.planId) {
      return res.status(200).json({
        brandPlanId: null,
        brandPlanName: "free",
      });
    }

    let brandPlanId = sub.planId || null;
    let brandPlanName = sub.planName || null;

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

exports.sendExpiringSoonEmails = async (req, res) => {
  try {
    const now = new Date();
    const withinHours = Number(req.body?.withinHours || 48);
    const end = new Date(now.getTime() + withinHours * 60 * 60 * 1000);

    const processUsers = async (Model, userType) => {
      assertValidModel(Model, userType);

      const users = await Model.find({
        "subscription.planId": { $exists: true, $ne: null },
        subscriptionExpired: { $ne: true },
        "subscription.expiresAt": { $gt: now, $lte: end },
        $or: [
          { "subscription.lastExpiringSoonEmailSentAt": { $exists: false } },
          { "subscription.lastExpiringSoonEmailSentAt": null },
        ],
      });

      let count = 0;

      for (const user of users) {
        const plan = await SubscriptionPlan.findOne({
          planId: user?.subscription?.planId,
        }).lean();

        await sendSubscriptionLifecycleEmail({
          userType,
          user,
          plan,
          eventType: "expiring_soon",
        });

        user.subscription = user.subscription || {};
        user.subscription.lastExpiringSoonEmailSentAt = new Date();
        await user.save();

        count += 1;
      }

      return count;
    };

    const brandCount = await processUsers(Brand, "Brand");
    const influencerCount = await processUsers(Influencer, "Influencer");

    return res.status(200).json({
      message: "Expiring soon emails processed",
      brandCount,
      influencerCount,
      total: brandCount + influencerCount,
    });
  } catch (err) {
    console.error("sendExpiringSoonEmails error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.sendExpiredSubscriptionEmails = async (req, res) => {
  try {
    const now = new Date();

    const processUsers = async (Model, userType) => {
      assertValidModel(Model, userType);

      const users = await Model.find({
        "subscription.planId": { $exists: true, $ne: null },
        "subscription.expiresAt": { $lte: now },
        $or: [
          { subscriptionExpired: { $ne: true } },
          { "subscription.lastExpiredEmailSentAt": { $exists: false } },
          { "subscription.lastExpiredEmailSentAt": null },
        ],
      });

      let count = 0;

      for (const user of users) {
        const plan = await SubscriptionPlan.findOne({
          planId: user?.subscription?.planId,
        }).lean();

        await sendSubscriptionLifecycleEmail({
          userType,
          user,
          plan,
          eventType: "expired",
        });

        user.subscriptionExpired = true;
        user.subscription = user.subscription || {};
        user.subscription.lastExpiredEmailSentAt = new Date();
        await user.save();

        count += 1;
      }

      return count;
    };

    const brandCount = await processUsers(Brand, "Brand");
    const influencerCount = await processUsers(Influencer, "Influencer");

    return res.status(200).json({
      message: "Expired subscription emails processed",
      brandCount,
      influencerCount,
      total: brandCount + influencerCount,
    });
  } catch (err) {
    console.error("sendExpiredSubscriptionEmails error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};