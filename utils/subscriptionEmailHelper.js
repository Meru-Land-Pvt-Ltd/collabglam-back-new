const { sendEmail, uploadEmailRecordToS3 } = require("../services/emailService");

function getUserEmail(user) {
  return String(
    user?.email ||
    user?.proxyEmail ||
    user?.contactEmail ||
    ""
  ).trim().toLowerCase();
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
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
      <h2>${heading}</h2>
      <p>Hello ${userName},</p>
      <p>${intro}</p>
      <p><strong>Plan:</strong> ${planName || "N/A"}</p>
      <p><strong>Ends on:</strong> ${endDate}</p>
      <p>If you need help, please contact support.</p>
      <p>- ${appName}</p>
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

module.exports = {
  sendSubscriptionLifecycleEmail,
};