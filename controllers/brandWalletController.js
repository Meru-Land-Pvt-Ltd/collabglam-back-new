const { Types } = require("mongoose");

const { ApiResponse } = require("../core/http/ApiResponse");
const { HttpStatus } = require("../core/http/HttpStatus");

const { BrandWalletModel } = require("../models/brandWallet");
const { CampaignModel } = require("../models/campaign");

// ---------------- Helpers ----------------
const clean = (v) => (v ?? "").trim();

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
  wallet.usableBalance = Math.max(0, (Number(wallet.walletBalance) || 0) - frozenAll);
  return { frozenAll, usableBalance: wallet.usableBalance };
};

const getOrCreateWallet = async (brandId) => {
  let wallet = await BrandWalletModel.findOne({ brandId: new Types.ObjectId(brandId) });

  if (!wallet) {
    wallet = await BrandWalletModel.create({
      brandId: new Types.ObjectId(brandId),
      walletBalance: 0,
      usableBalance: 0,
      freezes: [],
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
    const brandId = clean(typeof req.query.brandId === "string" ? req.query.brandId : "");

    if (!brandId || !Types.ObjectId.isValid(brandId)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne({
      brandId: new Types.ObjectId(brandId),
    });

    if (!wallet) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        { brandId, walletBalance: 0, frozenBalance: 0, usableBalance: 0, freezes: [] },
        requestId
      );
    }

    const frozenBalance = calcFrozenAll(wallet.freezes || []);
    const correctUsable = Math.max(0, (Number(wallet.walletBalance) || 0) - frozenBalance);

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
// ======================================================================
const topupBrandWallet = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const amount = Math.max(0, toNumber(req.body.amount, 0));

    if (!brandId || !Types.ObjectId.isValid(brandId)) {
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

    wallet.walletBalance = Math.max(0, (Number(wallet.walletBalance) || 0) + amount);

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
// POST /brand-wallet/freeze-for-campaign
// body: { brandId, campaignId }
// rule: if walletBalance >= campaignBudget -> freeze campaignBudget
// ======================================================================
const freezeFundsForCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);

    if (!brandId || !Types.ObjectId.isValid(brandId)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!campaignId || !Types.ObjectId.isValid(campaignId)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid campaignId is required",
        requestId
      );
    }

    const campaign = await CampaignModel.findById(campaignId).select(
      "_id brandId campaignBudget campaignTitle"
    );

    if (!campaign) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.NOT_FOUND,
        EC("NOT_FOUND"),
        "Campaign not found",
        requestId
      );
    }

    if (String(campaign.brandId) !== String(brandId)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Campaign does not belong to this brand",
        requestId
      );
    }

    const campaignBudget = Math.max(0, toNumber(campaign.campaignBudget, 0));

    if (!campaignBudget || campaignBudget <= 0) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "campaignBudget must be > 0",
        requestId
      );
    }

    const wallet = await getOrCreateWallet(brandId);

    if (wallet.walletBalance < campaignBudget) {
      const needToAdd = Math.max(0, campaignBudget - wallet.walletBalance);

      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        `Insufficient wallet balance. Please add ₹${needToAdd} to freeze this campaign budget.`,
        requestId,
        {
          campaignId,
          campaignTitle: campaign.campaignTitle,
          campaignBudget,
          walletBalance: wallet.walletBalance,
          usableBalance: wallet.usableBalance,
          needToAdd,
        }
      );
    }

    const idx = (wallet.freezes || []).findIndex(
      (f) =>
        String(f.brandId) === String(brandId) &&
        String(f.campaignId) === String(campaignId)
    );

    if (idx >= 0) {
      wallet.freezes[idx].freezeAmount = campaignBudget;
    } else {
      wallet.freezes.push({
        brandId: new Types.ObjectId(brandId),
        campaignId: new Types.ObjectId(campaignId),
        freezeAmount: campaignBudget,
      });
    }

    const { frozenAll, usableBalance } = syncUsableBalance(wallet);
    await wallet.save();

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Campaign budget frozen successfully",
        brandId,
        campaignId,
        campaignTitle: campaign.campaignTitle,
        frozenForCampaign: campaignBudget,
        walletBalance: wallet.walletBalance,
        frozenBalance: frozenAll,
        usableBalance,
        freezes: wallet.freezes,
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
// GET /brand-wallet/freeze-amount?brandId=xxx&campaignId=xxx
// ======================================================================
const getFrozenAmountForCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(typeof req.query.brandId === "string" ? req.query.brandId : "");
    const campaignId = clean(typeof req.query.campaignId === "string" ? req.query.campaignId : "");

    if (!brandId || !Types.ObjectId.isValid(brandId)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid brandId is required",
        requestId
      );
    }

    if (!campaignId || !Types.ObjectId.isValid(campaignId)) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Valid campaignId is required",
        requestId
      );
    }

    const wallet = await BrandWalletModel.findOne(
      {
        brandId: new Types.ObjectId(brandId),
        "freezes.campaignId": new Types.ObjectId(campaignId),
      },
      {
        walletBalance: 1,
        usableBalance: 1,
        "freezes.$": 1,
      }
    );

    if (!wallet || !wallet.freezes || !wallet.freezes.length) {
      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          brandId,
          campaignId,
          frozenAmount: 0,
        },
        requestId
      );
    }

    const frozenAmount = Number(wallet.freezes[0]?.freezeAmount) || 0;

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        brandId,
        campaignId,
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
  freezeFundsForCampaign,
  getFrozenAmountForCampaign,
};