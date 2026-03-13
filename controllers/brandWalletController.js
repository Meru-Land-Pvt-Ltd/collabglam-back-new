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
// body: { brandId, amount }
// Directly adds amount to wallet
// ======================================================================
const topupBrandWallet = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const amount = Math.max(0, toNumber(req.body.amount, 0));

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

    const wallet = await getOrCreateWallet(brandId);

    wallet.walletBalance = Math.max(
      0,
      (Number(wallet.walletBalance) || 0) + amount
    );

    wallet.topups = wallet.topups || [];
    wallet.topups.push({
      amount,
      currency: "inr",
      status: "success",
      createdAt: new Date(),
    });

    const { frozenAll, usableBalance } = syncUsableBalance(wallet);
    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Wallet topped up successfully",
        brandId,
        addedAmount: amount,
        walletBalance: wallet.walletBalance,
        frozenBalance: frozenAll,
        usableBalance,
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
  getFrozenAmountForCampaign,
  calcFrozenAll,
  syncUsableBalance,
  getOrCreateWallet,
};