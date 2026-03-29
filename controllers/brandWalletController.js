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

const calcFrozenAll = (freezes) =>
  (freezes || []).reduce((sum, f) => sum + (Number(f.freezeAmount) || 0), 0);

const syncUsableBalance = (wallet) => {
  const frozenAll = calcFrozenAll(wallet.freezes || []);
  wallet.usableBalance = Math.max(
    0,
    (Number(wallet.walletBalance) || 0) - frozenAll
  );
  return { frozenAll, usableBalance: wallet.usableBalance };
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

    const frozenBalance = calcFrozenAll(wallet.freezes || []);
    const correctUsable = Math.max(
      0,
      (Number(wallet.walletBalance) || 0) - frozenBalance
    );

    if (Number(wallet.usableBalance) !== correctUsable) {
      wallet.usableBalance = correctUsable;
      await wallet.save();
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        walletBalance: wallet.walletBalance,
        frozenBalance,
        usableBalance: wallet.usableBalance,
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
              name: "Brand wallet topup",
              description: campaignId
                ? `Wallet topup for campaign ${campaignId}`
                : "Wallet topup",
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
// Verifies Stripe payment and credits wallet
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

    if (!amount || amount <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Invalid paid amount received from Stripe",
        requestId
      );
    }

    const wallet = await getOrCreateWallet(brandId);

    wallet.topups = wallet.topups || [];

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
        status: "success",
        stripeSessionId: session.id,
        stripePaymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id || "",
        createdAt: new Date(),
      });

      syncUsableBalance(wallet);
      await wallet.save();
    } else {
      syncUsableBalance(wallet);
      await wallet.save();
    }

    const frozenBalance = calcFrozenAll(wallet.freezes || []);

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: alreadyCredited
          ? "Wallet topup already confirmed"
          : "Wallet topped up successfully",
        brandId,
        addedAmount: amount,
        walletBalance: wallet.walletBalance,
        frozenBalance,
        usableBalance: wallet.usableBalance,
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
          influencerId: influencerId || null,
          frozenAmount: 0,
        },
        requestId
      );
    }

    let frozenAmount = 0;

    for (const f of wallet.freezes || []) {
      const sameCampaign = String(f.campaignId) === String(campaignId);
      const sameInfluencer = influencerId
        ? String(f.influencerId) === String(influencerId)
        : true;

      if (sameCampaign && sameInfluencer) {
        frozenAmount += Number(f.freezeAmount) || 0;
      }
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        campaignId,
        influencerId: influencerId || null,
        frozenAmount,
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
  syncUsableBalance,
  getOrCreateWallet,
};