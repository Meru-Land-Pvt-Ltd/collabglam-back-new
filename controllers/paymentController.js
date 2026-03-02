require("dotenv").config();
const crypto = require("crypto");
const Stripe = require("stripe");

const Payment = require("../models/payment");
const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const subscriptionHelper = require("../utils/subscriptionHelper");
const MilestonePayment = require("../models/milestonePayment");
const SubscriptionPlan = require("../models/subscription");

const { nextInvoiceNumber } = require("../utils/invoiceNumber");
const {
  sendPaymentSuccessEmailWithInvoice,
  generateInvoicePdfBuffer,
} = require("../emails/paymentEmailController");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const clientUrl = (process.env.CAMPAIGN_BASE_URL || "https://collabglam.com").replace(/\/$/, "");
const brandSuccessPath = process.env.STRIPE_BRAND_SUCCESS_PATH || "/brand/subscriptions";
const influencerSuccessPath = process.env.STRIPE_INFLUENCER_SUCCESS_PATH || "/influencer/subscriptions";
const milestoneSuccessPath =
  process.env.STRIPE_MILESTONE_SUCCESS_PATH || "/brand/active-campaign/active-inf";

const roleToSuccessPath = (role) => (role === "Influencer" ? influencerSuccessPath : brandSuccessPath);

function safeText(v) {
  return String(v ?? "").trim();
}

function formatDateUS(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", year: "numeric" }).format(dt);
}

function safeRedirectUrl(url, fallbackAbsoluteUrl) {
  try {
    if (!url) return fallbackAbsoluteUrl;
    if (typeof url === "string" && url.startsWith("/")) return `${clientUrl}${url}`;
    const u = new URL(url);
    if (u.origin === clientUrl) return url;
    return fallbackAbsoluteUrl;
  } catch {
    return fallbackAbsoluteUrl;
  }
}

async function resolvePlanName({ planId, role, planName, name }) {
  const direct = (planName || name || "").trim();
  if (direct) return direct;
  try {
    const plan = await SubscriptionPlan.findOne({ planId, role }).lean();
    return (plan?.displayName || plan?.name || "").trim();
  } catch {
    return "";
  }
}

function extractTaxId(session) {
  const cd = session.customer_details;
  if (Array.isArray(cd?.tax_ids) && cd.tax_ids.length) return cd.tax_ids[0]?.value || "";
  const taxData = session.customer?.tax_ids?.data;
  if (Array.isArray(taxData) && taxData.length) return taxData[0]?.value || "";
  return "";
}

function addDays(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function addMonths(d, months) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + months);
  return x;
}

async function computeServicePeriod({ role, planId, paidAt }) {
  try {
    const plan = await SubscriptionPlan.findOne({ planId, role }).lean();
    const days = Number(plan?.durationDays || plan?.validityDays || 0);
    const months = Number(plan?.durationMonths || plan?.validityMonths || 0);

    if (days > 0) return { start: paidAt, end: addDays(paidAt, days) };
    if (months > 0) return { start: paidAt, end: addMonths(paidAt, months) };
  } catch {}

  return { start: paidAt, end: addDays(paidAt, 30) };
}

/**
 * ✅ Create Stripe Checkout Session for plan purchase
 * route: /payment/Order
 */
exports.createOrder = async (req, res) => {
  try {
    const {
      amount,
      receipt,
      userId,
      role,
      planId,
      planName,
      name,
      successUrl,
      cancelUrl,
    } = req.body;

    if (!userId || !role || !planId) {
      return res.status(400).json({ success: false, message: "Missing required fields: userId, role, planId" });
    }
    if (!["Brand", "Influencer"].includes(String(role))) {
      return res.status(400).json({ success: false, message: 'role must be "Brand" or "Influencer"' });
    }

    let user;
    if (role === "Brand") user = await Brand.findOne({ brandId: userId });
    else user = await Influencer.findOne({ influencerId: userId });

    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    // FREE plan logic (unchanged)
    const isInfluencerFree = role === "Influencer" && planId === "a58683f0-8d6e-41b0-addd-a718c2622142";
    const isBrandFree = role === "Brand" && planId === "ca41f2c1-7fbd-4e22-b27c-d537ecbaf02a";

    if (isInfluencerFree || isBrandFree) {
      const freePlan = await subscriptionHelper.getFreePlan(role);
      if (!freePlan) return res.status(500).json({ success: false, message: "Free plan is not configured" });

      const features = (freePlan.features || []).map((f) => ({
        key: f.key,
        limit: typeof f.value === "number" ? f.value : 0,
        used: 0,
      }));

      const subPayload = {
        planId: freePlan.planId || planId,
        planName: freePlan.name || "free",
        startedAt: new Date(),
        expiresAt: subscriptionHelper.computeExpiry(freePlan),
        features,
      };

      user.subscription = subPayload;
      user.subscriptionExpired = false;
      await user.save();

      return res.status(200).json({ success: true, free: true, message: "Free plan activated", subscription: subPayload });
    }

    const amountNum = Number(amount);
    if (!amountNum || isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: "amount is required for paid plans" });
    }

    const finalPlanName = await resolvePlanName({ planId, role, planName, name });
    const receiptId = receipt || crypto.randomBytes(10).toString("hex");

    const defaultSuccess = `${clientUrl}${roleToSuccessPath(role)}?stripe_success=1&session_id={CHECKOUT_SESSION_ID}`;
    const defaultCancel = `${clientUrl}${roleToSuccessPath(role)}?stripe_cancel=1`;

    const finalSuccessUrl = safeRedirectUrl(successUrl, defaultSuccess);
    const finalCancelUrl = safeRedirectUrl(cancelUrl, defaultCancel);

    // ✅ USD ONLY
    const stripeCurrency = "usd";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: user.email,

      // ✅ enterprise requirements
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      automatic_tax: { enabled: true },
      allow_promotion_codes: true,

      // ✅ ok to keep
      customer_creation: "always",

      // ❌ REMOVED customer_update (was causing StripeInvalidRequestError)

      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            tax_behavior: "exclusive",
            product_data: {
              name: `CollabGlam – ${role} Subscription (${finalPlanName || "Subscription"})`,
            },
            unit_amount: Math.round(amountNum * 100),
          },
          quantity: 1,
        },
      ],

      metadata: {
        kind: "plan",
        userId: String(userId),
        role: String(role),
        planId: String(planId),
        planName: String(finalPlanName || ""),
        name: String(finalPlanName || ""),
        receipt: String(receiptId),
      },

      success_url: finalSuccessUrl,
      cancel_url: finalCancelUrl,
    });

    await Payment.create({
      orderId: session.id,
      amount: Math.round(amountNum * 100),
      currency: "USD",
      receipt: receiptId,
      userId,
      planId,
      role,
      planName: finalPlanName || "",
      status: "created",
      createdAt: new Date(),
    });

    return res.status(201).json({ success: true, sessionId: session.id, url: session.url });
  } catch (error) {
    console.error("Error in createOrder:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ Verify Stripe Checkout Session and mark payment paid + store invoice data
 * route: /payment/verify
 * body: { sessionId }
 */
exports.verifyPayment = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: "sessionId is required" });

    let existing = await Payment.findOne({ orderId: sessionId });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["customer", "customer.tax_ids"],
    });

    if (!session || session.payment_status !== "paid") {
      await Payment.findOneAndUpdate({ orderId: sessionId }, { status: "failed" });
      return res.status(400).json({
        success: false,
        message: `Payment not completed (status: ${session?.payment_status || "unknown"})`,
      });
    }

    const metaPlanName = (session.metadata?.planName || session.metadata?.name || "").trim();
    let finalPlanName = metaPlanName;
    if (!finalPlanName && existing?.planName) finalPlanName = existing.planName;

    if (!finalPlanName) {
      finalPlanName = await resolvePlanName({
        planId: session.metadata?.planId,
        role: session.metadata?.role,
        planName: "",
        name: "",
      });
    }

    const paidAt = existing?.paidAt || new Date();

    let invoiceNumber = existing?.invoiceNumber;
    if (!invoiceNumber) invoiceNumber = await nextInvoiceNumber(paidAt);

    const cd = session.customer_details || {};
    const addr = cd.address || {};

    const subtotalCents = Number(session.amount_subtotal || existing?.amount || 0);
    const totalCents = Number(session.amount_total || existing?.amount || 0);
    const taxCents = Number(session.total_details?.amount_tax || 0);
    const discountCents = Number(session.total_details?.amount_discount || 0);

    let customerLegalName = safeText(cd.name);
    let customerEmail = safeText(cd.email);
    const customerTaxId = safeText(extractTaxId(session));

    if (!customerLegalName || !customerEmail) {
      const r = session.metadata?.role;
      const uid = session.metadata?.userId;
      const u = await (r === "Brand"
        ? Brand.findOne({ brandId: uid }).lean()
        : Influencer.findOne({ influencerId: uid }).lean());

      customerLegalName = customerLegalName || (u?.name || u?.brandName || u?.influencerName || "Customer");
      customerEmail = customerEmail || (u?.email || "");
    }

    const { start: servicePeriodStart, end: servicePeriodEnd } = await computeServicePeriod({
      role: session.metadata?.role,
      planId: session.metadata?.planId,
      paidAt,
    });

    const updated = await Payment.findOneAndUpdate(
      { orderId: sessionId },
      {
        paymentId: session.payment_intent || null,
        status: "paid",
        paidAt,
        currency: "USD",

        invoiceNumber,
        invoiceIssuedAt: existing?.invoiceIssuedAt || paidAt,

        customerLegalName,
        customerEmail,
        customerTaxId,
        billingAddress: {
          line1: safeText(addr.line1),
          line2: safeText(addr.line2),
          city: safeText(addr.city),
          state: safeText(addr.state),
          postal_code: safeText(addr.postal_code),
          country: safeText(addr.country),
        },

        subtotalCents,
        discountCents,
        taxCents,
        totalCents,

        servicePeriodStart,
        servicePeriodEnd,

        role: session.metadata?.role,
        userId: session.metadata?.userId,
        planId: session.metadata?.planId,
        planName: finalPlanName || "",
      },
      { new: true, upsert: true }
    );

    if (!updated.invoiceEmailSentAt) {
      try {
        const servicePeriodText = `${formatDateUS(updated.servicePeriodStart)} – ${formatDateUS(updated.servicePeriodEnd)}`;

        const r = await sendPaymentSuccessEmailWithInvoice({
          kind: "plan",
          role: updated.role,
          userId: updated.userId,
          paidAt: updated.paidAt,
          invoice: {
            invoiceNumber: updated.invoiceNumber,
            issueDate: formatDateUS(updated.invoiceIssuedAt || updated.paidAt),
            paymentStatus: "Paid",
            paymentDate: formatDateUS(updated.paidAt),
            customer: {
              legalName: updated.customerLegalName,
              email: updated.customerEmail,
              taxId: updated.customerTaxId || "",
              billingAddress: updated.billingAddress || {},
            },
            lineItem: {
              name: `CollabGlam – ${updated.role} Subscription (${updated.planName || "Subscription"})`,
              servicePeriodText,
              qty: 1,
              unitPriceCents: updated.subtotalCents,
              amountCents: updated.subtotalCents,
            },
            totals: {
              subtotalCents: updated.subtotalCents,
              discountCents: updated.discountCents || 0,
              taxCents: updated.taxCents || 0,
              totalCents: updated.totalCents,
            },
          },
        });

        await Payment.findOneAndUpdate(
          { orderId: sessionId },
          {
            invoiceFilePath: r.invoiceFilePath,
            invoiceEmailTo: r.recipientEmail,
            invoiceEmailSentAt: new Date(),
          }
        );
      } catch (e) {
        console.error("Invoice email failed:", e);
      }
    }

    return res.json({
      success: true,
      message: "Payment verified successfully",
      planId: updated.planId,
      planName: updated.planName,
      role: updated.role,
      userId: updated.userId,
      invoiceNumber: updated.invoiceNumber,
    });
  } catch (error) {
    console.error("Error in verifyPayment:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ Create Stripe Checkout Session for milestone payment
 * route: /payment/milestone-order
 */
exports.createMilestoneOrder = async (req, res) => {
  try {
    const {
      amount,
      receipt,
      brandId,
      influencerId,
      campaignId,
      campaignName,
      milestoneTitle,
      successUrl,
      cancelUrl,
    } = req.body;

    if (!amount || !brandId || !influencerId || !campaignId) {
      return res.status(400).json({
        success: false,
        message: "amount, brandId, influencerId and campaignId are required for milestone payments",
      });
    }

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: "amount must be a positive number" });
    }

    const brand = await Brand.findOne({ brandId });
    const influencer = await Influencer.findOne({ influencerId });

    if (!brand) return res.status(404).json({ success: false, message: "Brand not found" });
    if (!influencer) return res.status(404).json({ success: false, message: "Influencer not found" });

    const receiptId = receipt || crypto.randomBytes(10).toString("hex");

    const basePath = (milestoneSuccessPath || "/brand/active-campaign/active-inf").startsWith("/")
      ? milestoneSuccessPath
      : `/${milestoneSuccessPath}`;

    const qs = `id=${encodeURIComponent(campaignId)}&name=${encodeURIComponent(campaignName || "")}`;

    const defaultSuccessUrl = `${clientUrl}${basePath}?${qs}&stripe_success=1&session_id={CHECKOUT_SESSION_ID}`;
    const defaultCancelUrl = `${clientUrl}${basePath}?${qs}&stripe_cancel=1`;

    const finalSuccessUrl = safeRedirectUrl(successUrl, defaultSuccessUrl);
    const finalCancelUrl = safeRedirectUrl(cancelUrl, defaultCancelUrl);

    const stripeCurrency = "usd";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: brand.email,

      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      automatic_tax: { enabled: true },
      allow_promotion_codes: true,

      customer_creation: "always",

      // ❌ REMOVED customer_update (same Stripe error)

      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            tax_behavior: "exclusive",
            product_data: {
              name: `CollabGlam – Milestone Payment (${milestoneTitle || "Milestone"})`,
            },
            unit_amount: Math.round(amountNum * 100),
          },
          quantity: 1,
        },
      ],

      metadata: {
        kind: "milestone",
        receipt: String(receiptId),
        brandId: String(brandId),
        influencerId: String(influencerId),
        campaignId: String(campaignId),
        campaignName: String(campaignName || ""),
        milestoneTitle: String(milestoneTitle || ""),
      },

      success_url: finalSuccessUrl,
      cancel_url: finalCancelUrl,
    });

    await MilestonePayment.create({
      orderId: session.id,
      amount: Math.round(amountNum * 100),
      currency: "USD",
      receipt: receiptId,
      brandId,
      influencerId,
      campaignId,
      campaignName: campaignName || "",
      milestoneTitle: milestoneTitle || "",
      status: "created",
      createdAt: new Date(),
    });

    return res.status(201).json({ success: true, sessionId: session.id, url: session.url });
  } catch (error) {
    console.error("Error in createMilestoneOrder:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ Verify milestone payment + store invoice data
 * route: /payment/milestone-verify
 * body: { sessionId }
 */
exports.verifyMilestonePayment = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: "sessionId is required" });

    let existing = await MilestonePayment.findOne({ orderId: sessionId });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["customer", "customer.tax_ids"],
    });

    if (!session || session.payment_status !== "paid") {
      await MilestonePayment.findOneAndUpdate({ orderId: sessionId }, { status: "failed" });
      return res.status(400).json({
        success: false,
        message: `Payment not completed (status: ${session?.payment_status || "unknown"})`,
      });
    }

    const paidAt = existing?.paidAt || new Date();

    let invoiceNumber = existing?.invoiceNumber;
    if (!invoiceNumber) invoiceNumber = await nextInvoiceNumber(paidAt);

    const cd = session.customer_details || {};
    const addr = cd.address || {};

    const subtotalCents = Number(session.amount_subtotal || existing?.amount || 0);
    const totalCents = Number(session.amount_total || existing?.amount || 0);
    const taxCents = Number(session.total_details?.amount_tax || 0);
    const discountCents = Number(session.total_details?.amount_discount || 0);

    const brand = await Brand.findOne({ brandId: session.metadata?.brandId }).lean();

    const customerLegalName = safeText(cd.name) || safeText(brand?.name || brand?.brandName || "Brand");
    const customerEmail = safeText(cd.email) || safeText(brand?.email || "");
    const customerTaxId = safeText(extractTaxId(session));

    const updated = await MilestonePayment.findOneAndUpdate(
      { orderId: sessionId },
      {
        paymentId: session.payment_intent || null,
        status: "paid",
        paidAt,
        currency: "USD",

        invoiceNumber,
        invoiceIssuedAt: existing?.invoiceIssuedAt || paidAt,

        customerLegalName,
        customerEmail,
        customerTaxId,
        billingAddress: {
          line1: safeText(addr.line1),
          line2: safeText(addr.line2),
          city: safeText(addr.city),
          state: safeText(addr.state),
          postal_code: safeText(addr.postal_code),
          country: safeText(addr.country),
        },

        subtotalCents,
        discountCents,
        taxCents,
        totalCents,

        brandId: session.metadata?.brandId,
        influencerId: session.metadata?.influencerId,
        campaignId: session.metadata?.campaignId,
        campaignName: session.metadata?.campaignName,
        milestoneTitle: session.metadata?.milestoneTitle,
      },
      { new: true, upsert: true }
    );

    if (!updated.invoiceEmailSentAt && brand?.email) {
      try {
        const r = await sendPaymentSuccessEmailWithInvoice({
          kind: "milestone",
          toEmail: brand.email,
          toName: brand.name || brand.brandName || "Brand",
          paidAt: updated.paidAt,
          invoice: {
            invoiceNumber: updated.invoiceNumber,
            issueDate: formatDateUS(updated.invoiceIssuedAt || updated.paidAt),
            paymentStatus: "Paid",
            paymentDate: formatDateUS(updated.paidAt),
            customer: {
              legalName: updated.customerLegalName,
              email: updated.customerEmail,
              taxId: updated.customerTaxId || "",
              billingAddress: updated.billingAddress || {},
            },
            lineItem: {
              name: `CollabGlam – Milestone Payment (${updated.milestoneTitle || "Milestone"})`,
              qty: 1,
              unitPriceCents: updated.subtotalCents,
              amountCents: updated.subtotalCents,
            },
            totals: {
              subtotalCents: updated.subtotalCents,
              discountCents: updated.discountCents || 0,
              taxCents: updated.taxCents || 0,
              totalCents: updated.totalCents,
            },
          },
        });

        await MilestonePayment.findOneAndUpdate(
          { orderId: sessionId },
          {
            invoiceFilePath: r.invoiceFilePath,
            invoiceEmailTo: r.recipientEmail,
            invoiceEmailSentAt: new Date(),
          }
        );
      } catch (e) {
        console.error("Milestone invoice email failed:", e);
      }
    }

    return res.json({
      success: true,
      message: "Milestone payment verified successfully",
      payment: updated,
      invoiceNumber: updated.invoiceNumber,
    });
  } catch (error) {
    console.error("Error in verifyMilestonePayment:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ Preview invoice PDF by invoiceNumber (INLINE only)
 * route: POST /payment/invoices/preview
 * body: { invoiceNumber }
 */
exports.previewInvoiceByInvoiceNumber = async (req, res) => {
  try {
    const { invoiceNumber } = req.body || {};
    if (!invoiceNumber) return res.status(400).json({ success: false, message: "invoiceNumber is required" });

    let record = await Payment.findOne({ invoiceNumber: String(invoiceNumber) }).lean();
    let kind = "plan";

    if (!record) {
      record = await MilestonePayment.findOne({ invoiceNumber: String(invoiceNumber) }).lean();
      kind = "milestone";
    }

    if (!record) return res.status(404).json({ success: false, message: "Invoice not found" });

    const paymentStatus = record.status === "paid" ? "Paid" : "Unpaid";
    const issueDate = formatDateUS(record.invoiceIssuedAt || record.paidAt || record.createdAt || Date.now());
    const paymentDate = record.paidAt ? formatDateUS(record.paidAt) : "";

    const customer = {
      legalName: record.customerLegalName || "Customer",
      email: record.customerEmail || record.invoiceEmailTo || "",
      taxId: record.customerTaxId || "",
      billingAddress: record.billingAddress || {},
    };

    const totals = {
      subtotalCents: Number(record.subtotalCents || record.amount || 0),
      discountCents: Number(record.discountCents || 0),
      taxCents: Number(record.taxCents || 0),
      totalCents: Number(record.totalCents || record.amount || 0),
    };

    let lineItem;
    if (kind === "milestone") {
      lineItem = {
        name: `CollabGlam – Milestone Payment (${record.milestoneTitle || "Milestone"})`,
        qty: 1,
        unitPriceCents: totals.subtotalCents,
        amountCents: totals.subtotalCents,
      };
    } else {
      const spText =
        record.servicePeriodStart && record.servicePeriodEnd
          ? `${formatDateUS(record.servicePeriodStart)} – ${formatDateUS(record.servicePeriodEnd)}`
          : "";
      lineItem = {
        name: `CollabGlam – ${record.role} Subscription (${record.planName || "Subscription"})`,
        servicePeriodText: spText,
        qty: 1,
        unitPriceCents: totals.subtotalCents,
        amountCents: totals.subtotalCents,
      };
    }

    const pdf = await generateInvoicePdfBuffer({
      invoiceNumber: record.invoiceNumber,
      issueDate,
      paymentStatus,
      paymentDate,
      customer,
      lineItem,
      totals,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${pdf.filename}"`);
    return res.status(200).send(pdf.buffer);
  } catch (err) {
    console.error("previewInvoiceByInvoiceNumber error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

exports.getInvoicesByUserId = async (req, res) => {
  try {
    const { userId, role } = req.body || {};

    if (!userId || !role) {
      return res.status(400).json({ success: false, message: "userId and role are required" });
    }
    if (!["Brand", "Influencer"].includes(String(role))) {
      return res.status(400).json({ success: false, message: 'role must be "Brand" or "Influencer"' });
    }

    // Plans (optional: also return amount for consistency)
    const planInvoicesRaw = await Payment.find({
      userId: String(userId),
      role: String(role),
      status: "paid",
      invoiceNumber: { $exists: true, $ne: "" },
    })
      .sort({ paidAt: -1, createdAt: -1 })
      .select(
        "invoiceNumber invoiceIssuedAt paidAt status planName role userId currency amount subtotalCents discountCents taxCents totalCents billingAddress customerLegalName customerEmail customerTaxId invoiceFilePath invoiceEmailTo invoiceEmailSentAt"
      )
      .lean();

    const planInvoices = planInvoicesRaw.map((inv) => ({
      ...inv,
      // amount in cents (fallback)
      amount: Number(inv.amount ?? inv.totalCents ?? inv.subtotalCents ?? 0),
    }));

    // Milestones (Brand only)
    let milestoneInvoices = [];
    if (String(role) === "Brand") {
      const milestoneInvoicesRaw = await MilestonePayment.find({
        brandId: String(userId),
        status: "paid",
        invoiceNumber: { $exists: true, $ne: "" },
      })
        .sort({ paidAt: -1, createdAt: -1 })
        .select(
          "invoiceNumber invoiceIssuedAt paidAt status campaignId campaignName milestoneTitle currency amount subtotalCents discountCents taxCents totalCents billingAddress customerLegalName customerEmail customerTaxId invoiceFilePath invoiceEmailTo invoiceEmailSentAt"
        )
        .lean();

      milestoneInvoices = milestoneInvoicesRaw.map((inv) => ({
        ...inv,
        amount: Number(inv.amount ?? inv.totalCents ?? inv.subtotalCents ?? 0),
      }));
    }

    return res.json({
      success: true,
      userId,
      role,
      invoices: { plans: planInvoices, milestones: milestoneInvoices },
      counts: {
        plans: planInvoices.length,
        milestones: milestoneInvoices.length,
        total: planInvoices.length + milestoneInvoices.length,
      },
    });
  } catch (err) {
    console.error("getInvoicesByUserId error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};