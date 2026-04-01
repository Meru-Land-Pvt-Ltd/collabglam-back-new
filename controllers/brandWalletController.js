const Stripe = require("stripe");
const { ApiResponse } = require("../core/http/ApiResponse");
const { HttpStatus } = require("../core/http/HttpStatus");
const { BrandWalletModel } = require("../models/brandWallet");

// ---------------- Helpers ----------------
const clean = (v) => String(v ?? "").trim();

const getRequestId = (req) =>
  req.requestId || req.id || req.headers?.["x-request-id"] || "NA";

const EC = (code) => code;

const toNumber = (v, def = 0) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
  return def;
};

const calcAllocationTotal = (allocations = []) =>
  allocations.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

const calcReleasedTotal = (allocations = []) =>
  allocations.reduce((sum, item) => sum + (Number(item.releasedAmount) || 0), 0);

const syncCampaignFreeze = (freeze) => {
  if (!freeze) return null;

  freeze.influencerAllocations = Array.isArray(freeze.influencerAllocations)
    ? freeze.influencerAllocations
    : [];

  const totalFrozenAmount = Number(freeze.totalFrozenAmount || 0);
  const totalAllocatedAmount = calcAllocationTotal(freeze.influencerAllocations);
  const totalReleasedAmount = calcReleasedTotal(freeze.influencerAllocations);

  freeze.totalAllocatedAmount = totalAllocatedAmount;
  freeze.totalReleasedAmount = totalReleasedAmount;

  freeze.currentFrozenAmount = Math.max(
    0,
    totalFrozenAmount - totalReleasedAmount
  );

  freeze.availableToAllocate = Math.max(
    0,
    totalFrozenAmount - totalAllocatedAmount
  );

  return freeze;
};

const calcFrozenAll = (freezes = []) =>
  freezes.reduce((sum, freeze) => {
    syncCampaignFreeze(freeze);
    return sum + (Number(freeze.currentFrozenAmount) || 0);
  }, 0);

const syncUsableBalance = (wallet) => {
  wallet.freezes = Array.isArray(wallet.freezes) ? wallet.freezes : [];
  wallet.freezes.forEach(syncCampaignFreeze);

  const frozenAll = calcFrozenAll(wallet.freezes);
  wallet.usableBalance = Math.max(
    0,
    (Number(wallet.walletBalance) || 0) - frozenAll
  );

  return {
    walletBalance: Number(wallet.walletBalance) || 0,
    frozenBalance: frozenAll,
    usableBalance: wallet.usableBalance,
  };
};

const ensureCampaignFreeze = (wallet, brandId, campaignId) => {
  wallet.freezes = Array.isArray(wallet.freezes) ? wallet.freezes : [];

  let campaignFreeze = wallet.freezes.find(
    (f) =>
      String(f.brandId) === String(brandId) &&
      String(f.campaignId) === String(campaignId)
  );

  if (!campaignFreeze) {
    campaignFreeze = {
      brandId,
      campaignId,
      totalFrozenAmount: 0,
      currentFrozenAmount: 0,
      totalAllocatedAmount: 0,
      totalReleasedAmount: 0,
      availableToAllocate: 0,
      influencerAllocations: [],
    };

    wallet.freezes.push(campaignFreeze);
  }

  syncCampaignFreeze(campaignFreeze);
  return campaignFreeze;
};

const getOrCreateWallet = async (brandId) => {
  let wallet = await BrandWalletModel.findOne({ brandId });

  if (!wallet) {
    wallet = await BrandWalletModel.create({
      brandId,
      walletBalance: 0,
      usableBalance: 0,
      freezes: [],
      topups: [],
    });
  }

  syncUsableBalance(wallet);
  await wallet.save();
  return wallet;
};

let stripeClient = null;

const getStripeClient = () => {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  return stripeClient;
};

// ======================================================================
// GET /brand-wallet?brandId=xxxx
// ======================================================================
const getBrandWallet = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId });

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          walletBalance: 0,
          frozenBalance: 0,
          usableBalance: 0,
          freezes: [],
        },
        requestId
      );
    }

    const snap = syncUsableBalance(wallet);
    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        walletBalance: snap.walletBalance,
        frozenBalance: snap.frozenBalance,
        usableBalance: snap.usableBalance,
        freezes: wallet.freezes || [],
      },
      requestId
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/topup
// body: { brandId, campaignId, amount, currency, successUrl, cancelUrl }
// Creates Stripe Checkout Session
// ======================================================================
const topupBrandWallet = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);
    const amount = Math.max(0, toNumber(req.body.amount, 0));
    const currency = clean(req.body.currency || "inr").toLowerCase();
    const successUrl = clean(req.body.successUrl);
    const cancelUrl = clean(req.body.cancelUrl);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!campaignId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "campaignId is required",
        requestId
      );
    }

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "amount must be > 0",
        requestId
      );
    }

    if (!successUrl || !cancelUrl) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "successUrl and cancelUrl are required",
        requestId
      );
    }

    const stripe = getStripeClient();

    await getOrCreateWallet(brandId);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: "Campaign wallet topup",
              description: `Wallet topup for campaign ${campaignId}`,
            },
          },
        },
      ],
      metadata: {
        brandId,
        campaignId,
        amount: String(amount),
        currency,
      },
    });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Stripe checkout session created",
        brandId,
        campaignId,
        amount,
        currency,
        sessionId: session.id,
        checkoutUrl: session.url,
      },
      requestId
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// POST /brand-wallet/topup/confirm
// body: { brandId, sessionId }
// Verifies Stripe payment and credits wallet + freezes that amount to campaign
// ======================================================================
const confirmBrandWalletTopup = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const sessionId = clean(req.body.sessionId);

    if (!brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!sessionId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "sessionId is required",
        requestId
      );
    }

    const stripe = getStripeClient();

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });

    if (!session) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.NOT_FOUND,
        EC("NOT_FOUND"),
        "Stripe session not found",
        requestId
      );
    }

    if (clean(session.metadata?.brandId) !== brandId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "brandId does not match Stripe session",
        requestId
      );
    }

    if (session.payment_status !== "paid") {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("PAYMENT_NOT_COMPLETED"),
        "Stripe payment is not completed",
        requestId
      );
    }

    const amount = toNumber(session.amount_total, 0) / 100;
    const currency = clean(session.currency || "inr").toLowerCase();
    const campaignId = clean(session.metadata?.campaignId);

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Invalid paid amount received from Stripe",
        requestId
      );
    }

    if (!campaignId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "campaignId missing in Stripe session metadata",
        requestId
      );
    }

    const wallet = await getOrCreateWallet(brandId);

    wallet.topups = Array.isArray(wallet.topups) ? wallet.topups : [];

    const alreadyCredited = wallet.topups.some(
      (t) =>
        clean(t?.stripeSessionId) === session.id &&
        clean(t?.status).toLowerCase() === "success"
    );

    if (!alreadyCredited) {
      wallet.walletBalance = Math.max(
        0,
        (Number(wallet.walletBalance) || 0) + amount
      );

      wallet.topups.push({
        amount,
        currency,
        campaignId,
        status: "success",
        stripeSessionId: session.id,
        stripePaymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id || "",
        createdAt: new Date(),
      });

      const campaignFreeze = ensureCampaignFreeze(wallet, brandId, campaignId);
      campaignFreeze.totalFrozenAmount =
        Number(campaignFreeze.totalFrozenAmount || 0) + amount;

      syncCampaignFreeze(campaignFreeze);
      syncUsableBalance(wallet);
      await wallet.save();
    } else {
      syncUsableBalance(wallet);
      await wallet.save();
    }

    const campaignFreeze = (wallet.freezes || []).find(
      (f) =>
        String(f.brandId) === String(brandId) &&
        String(f.campaignId) === String(campaignId)
    );

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: alreadyCredited
          ? "Wallet topup already confirmed"
          : "Campaign wallet topped up successfully",
        brandId,
        campaignId,
        addedAmount: amount,
        walletBalance: wallet.walletBalance,
        frozenBalance: calcFrozenAll(wallet.freezes || []),
        usableBalance: wallet.usableBalance,
        campaignFreeze: campaignFreeze || null,
      },
      requestId
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

// ======================================================================
// GET /brand-wallet/freeze-amount?brandId=xxx&campaignId=xxx&influencerId=xxx
// ======================================================================
const getFrozenAmountForCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(
      typeof req.query.brandId === "string" ? req.query.brandId : ""
    );
    const campaignId = clean(
      typeof req.query.campaignId === "string" ? req.query.campaignId : ""
    );
    const influencerId = clean(
      typeof req.query.influencerId === "string" ? req.query.influencerId : ""
    );

    if (!brandId || !campaignId) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "brandId and campaignId are required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({ brandId });

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          campaignId,
          totalFrozenAmount: 0,
          currentFrozenAmount: 0,
          totalAllocatedAmount: 0,
          totalReleasedAmount: 0,
          availableToAllocate: 0,
          influencer: influencerId
            ? {
                influencerId,
                amount: 0,
                releasedAmount: 0,
                pendingAmount: 0,
              }
            : null,
        },
        requestId
      );
    }

    const campaignFreeze = (wallet.freezes || []).find(
      (f) =>
        String(f.brandId) === String(brandId) &&
        String(f.campaignId) === String(campaignId)
    );

    if (!campaignFreeze) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          campaignId,
          totalFrozenAmount: 0,
          currentFrozenAmount: 0,
          totalAllocatedAmount: 0,
          totalReleasedAmount: 0,
          availableToAllocate: 0,
          influencer: influencerId
            ? {
                influencerId,
                amount: 0,
                releasedAmount: 0,
                pendingAmount: 0,
              }
            : null,
        },
        requestId
      );
    }

    syncCampaignFreeze(campaignFreeze);

    let influencer = null;

    if (influencerId) {
      const allocation = (campaignFreeze.influencerAllocations || []).find(
        (a) => String(a.influencerId) === String(influencerId)
      );

      influencer = allocation
        ? {
            influencerId,
            amount: Number(allocation.amount || 0),
            releasedAmount: Number(allocation.releasedAmount || 0),
            pendingAmount: Math.max(
              0,
              Number(allocation.amount || 0) -
                Number(allocation.releasedAmount || 0)
            ),
          }
        : {
            influencerId,
            amount: 0,
            releasedAmount: 0,
            pendingAmount: 0,
          };
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        campaignId,
        totalFrozenAmount: Number(campaignFreeze.totalFrozenAmount || 0),
        currentFrozenAmount: Number(campaignFreeze.currentFrozenAmount || 0),
        totalAllocatedAmount: Number(campaignFreeze.totalAllocatedAmount || 0),
        totalReleasedAmount: Number(campaignFreeze.totalReleasedAmount || 0),
        availableToAllocate: Number(campaignFreeze.availableToAllocate || 0),
        influencer,
      },
      requestId
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

module.exports = {
  getBrandWallet,
  topupBrandWallet,
  confirmBrandWalletTopup,
  getFrozenAmountForCampaign,
  calcFrozenAll,
  syncCampaignFreeze,
  syncUsableBalance,
  ensureCampaignFreeze,
  getOrCreateWallet,
};