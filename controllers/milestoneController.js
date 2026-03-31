const mongoose = require("mongoose");

const Milestone = require("../models/milestone");
const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Contract = require("../models/contract");
const { BrandWalletModel } = require("../models/brandWallet");

const { createAndEmit } = require("../utils/notifier");
const { CONTRACT_STATUS } = require("../constants/contract");

const {
  sendMilestoneCreatedEmail,
  sendMilestoneReleasedEmail,
  sendMilestonePaidEmail,
} = require("../emails/milestonetemplet");

const APP_BASE_URL = process.env.APP_BASE_URL || "";

// ---------------- wallet helpers ----------------
const calcFrozenAll = (freezes = []) =>
  freezes.reduce((sum, f) => sum + (Number(f.freezeAmount) || 0), 0);

const syncUsableBalance = (wallet) => {
  const frozenAll = calcFrozenAll(wallet.freezes || []);
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

const getOrCreateBrandWallet = async (brandId, session = null) => {
  let query = BrandWalletModel.findOne({ brandId });
  if (session) query = query.session(session);

  let wallet = await query;

  if (!wallet) {
    wallet = new BrandWalletModel({
      brandId,
      walletBalance: 0,
      usableBalance: 0,
      freezes: [],
      topups: [],
    });
  }

  syncUsableBalance(wallet);

  if (session) {
    await wallet.save({ session });
  } else {
    await wallet.save();
  }

  return wallet;
};

const getWalletSnapshotByBrandId = async (brandId) => {
  const wallet = await BrandWalletModel.findOne({ brandId });

  if (!wallet) {
    return {
      walletBalance: 0,
      frozenBalance: 0,
      usableBalance: 0,
      freezes: [],
    };
  }

  const snap = syncUsableBalance(wallet);
  await wallet.save();

  return {
    walletBalance: snap.walletBalance,
    frozenBalance: snap.frozenBalance,
    usableBalance: snap.usableBalance,
    freezes: wallet.freezes || [],
  };
};

// ======================================================================
// POST /milestone/create
// body: { brandId, influencerId, campaignId, milestoneTitle, amount, milestoneDescription }
// ======================================================================
exports.createMilestone = async (req, res) => {
  const session = await mongoose.startSession();

  const abort = (status, message, extra = {}) => {
    const err = new Error(message);
    err.status = status;
    err.extra = extra;
    throw err;
  };

  const isSigned = (value) => {
    if (typeof value === "boolean") return value;
    if (value == null) return false;
    if (typeof value === "string") return value.trim() !== "";
    return true;
  };

  try {
    const {
      brandId,
      influencerId,
      campaignId,
      milestoneTitle,
      amount,
      milestoneDescription = "",
    } = req.body;

    const amountNum = Number(amount);

    if (!brandId || !influencerId || !campaignId || !milestoneTitle || amount == null) {
      return res.status(400).json({
        message:
          "brandId, influencerId, campaignId, milestoneTitle and amount are required",
      });
    }

    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        message: "amount must be a valid number > 0",
      });
    }

    let responsePayload = null;
    let emailData = null;

    await session.withTransaction(async () => {
      // 1) Verify campaign
      const camp = await Campaign.findById(campaignId).session(session).lean();
      if (!camp) {
        abort(404, "Campaign not found");
      }

      // NEW: if campaign created by admin, skip contract validation
      const isAdminCreatedCampaign =
        String(camp?.createdBy?.role ?? "").trim().toLowerCase() === "admin";

      // 2) Contract check before any mutation
      let contractDoc = null;

      if (!isAdminCreatedCampaign) {
        if (camp.contractId) {
          try {
            contractDoc = await Contract.findById(camp.contractId).session(session);
          } catch {
            contractDoc = null;
          }
        }

        if (!contractDoc) {
          contractDoc = await Contract.findOne({
            brandId,
            influencerId,
            campaignId,
          })
            .sort({ createdAt: -1 })
            .session(session);
        }

        if (!contractDoc) {
          abort(400, "Contract not found. Please create and sign the contract first.");
        }

        const canCreateMilestone =
          isSigned(contractDoc.signatureBrand) &&
          isSigned(contractDoc.signatureInfluencer);

        if (!canCreateMilestone) {
          abort(400, "Contract must be fully signed before creating milestones.");
        }
      }

      // 3) milestone doc
      let doc = await Milestone.findOne({ brandId }).session(session);
      if (!doc) {
        doc = new Milestone({
          brandId,
          totalAmount: 0,
          milestoneHistory: [],
        });
      }

      doc.totalAmount = Number(doc.totalAmount || 0);

      // 4) Previous milestone check for same influencer + campaign
      const prev = (doc.milestoneHistory || []).filter(
        (e) =>
          String(e.influencerId) === String(influencerId) &&
          String(e.campaignId) === String(campaignId)
      );

      if (prev.length > 0) {
        prev.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const last = prev[0];

        if (!last.released) {
          abort(
            400,
            "Cannot create new milestone until the previous milestone is released"
          );
        }
      }

      // 5) Campaign budget check
      const campaignBudget = Number(camp.budget);
      const hasBudget = !isNaN(campaignBudget) && campaignBudget > 0;

      if (hasBudget) {
        const existingTotalForCampaign = (doc.milestoneHistory || [])
          .filter((e) => String(e.campaignId) === String(campaignId))
          .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

        if (existingTotalForCampaign >= campaignBudget) {
          abort(
            400,
            "You have added milestone equal to campaign now not able to add now milestone"
          );
        }

        if (existingTotalForCampaign + amountNum > campaignBudget) {
          abort(400, "Total milestone amount cannot exceed campaign budget");
        }
      }

      // 6) Wallet check only
      const wallet = await getOrCreateBrandWallet(brandId, session);
      const walletSnapBefore = syncUsableBalance(wallet);

      if (walletSnapBefore.usableBalance < amountNum) {
        const needToAdd = Math.max(0, amountNum - walletSnapBefore.usableBalance);

        abort(
          400,
          `Insufficient wallet balance. Please add $${needToAdd.toFixed(2)} to your wallet.`,
          {
            walletBalance: walletSnapBefore.walletBalance,
            frozenBalance: walletSnapBefore.frozenBalance,
            usableBalance: walletSnapBefore.usableBalance,
            needToAdd,
          }
        );
      }

      // 7) First create milestone entry
      doc.milestoneHistory.push({
        influencerId,
        campaignId,
        milestoneTitle,
        amount: amountNum,
        milestoneDescription,
        released: false,
        payoutStatus: "pending",
      });

      doc.totalAmount = doc.totalAmount + amountNum;
      await doc.save({ session });

      const createdEntry = doc.milestoneHistory[doc.milestoneHistory.length - 1];

      // 8) Freeze only AFTER milestone save succeeds
      wallet.freezes = Array.isArray(wallet.freezes) ? wallet.freezes : [];

      const freezeIndex = wallet.freezes.findIndex(
        (f) =>
          String(f.brandId) === String(brandId) &&
          String(f.campaignId) === String(campaignId) &&
          String(f.influencerId) === String(influencerId)
      );

      if (freezeIndex >= 0) {
        wallet.freezes[freezeIndex].freezeAmount =
          Number(wallet.freezes[freezeIndex].freezeAmount || 0) + amountNum;
      } else {
        wallet.freezes.push({
          brandId,
          campaignId,
          influencerId,
          freezeAmount: amountNum,
        });
      }

      const walletSnapAfter = syncUsableBalance(wallet);
      await wallet.save({ session });

      // 9) Update contract status only if contract exists
      let updatedContract = null;

      if (contractDoc) {
        const alreadyMilestonesLocked =
          String(contractDoc.status || "").toUpperCase() ===
          CONTRACT_STATUS.MILESTONES_CREATED;

        if (!alreadyMilestonesLocked) {
          contractDoc.status = CONTRACT_STATUS.MILESTONES_CREATED;
          contractDoc.milestonesCreatedAt =
            contractDoc.milestonesCreatedAt || new Date();
          contractDoc.awaitingRole = null;

          contractDoc.statusFlags = contractDoc.statusFlags || {};
          contractDoc.statusFlags.awaitingCollabglam = false;

          contractDoc.audit = contractDoc.audit || [];
          contractDoc.audit.push({
            type: "MILESTONES_CREATED",
            role: "system",
            details: { brandId, influencerId, campaignId },
            at: new Date(),
          });

          await contractDoc.save({ session });
        }

        updatedContract = contractDoc;

        await Campaign.updateOne(
          { _id: campaignId },
          {
            $set: {
              contractId: contractDoc._id || contractDoc.contractId,
              isContracted: 1,
              contractStatus: contractDoc.status,
              milestonesCreatedAt: contractDoc.milestonesCreatedAt || new Date(),
            },
          },
          { session }
        );
      }

      responsePayload = {
        ...(responsePayload || {}),
        message: "Milestone created and amount frozen successfully",
        milestoneId: String(doc._id),
        totalAmount: doc.totalAmount,
        entry: {
          milestoneHistoryId: String(createdEntry._id),
          influencerId: createdEntry.influencerId,
          campaignId: createdEntry.campaignId,
          milestoneTitle: createdEntry.milestoneTitle,
          amount: createdEntry.amount,
          milestoneDescription: createdEntry.milestoneDescription,
          released: createdEntry.released,
          payoutStatus: createdEntry.payoutStatus,
          createdAt: createdEntry.createdAt,
        },
        wallet: {
          walletBalance: walletSnapAfter.walletBalance,
          frozenBalance: walletSnapAfter.frozenBalance,
          usableBalance: walletSnapAfter.usableBalance,
        },
        contractStatus: updatedContract?.status || null,
        milestonesCreatedAt: updatedContract?.milestonesCreatedAt || null,
        isAdminCreatedCampaign,
      };

      emailData = {
        brandId,
        influencerId,
        campaignName: camp.productOrServiceName || camp.campaignTitle || "",
        milestoneTitle,
        amount: amountNum,
        milestoneDescription,
      };
    });

    session.endSession();

    createAndEmit({
      influencerId: req.body.influencerId,
      type: "milestone.created",
      title: `New milestone: ${req.body.milestoneTitle}`,
      message: `An amount of $${Number(req.body.amount).toFixed(2)} was created for this campaign.`,
      entityType: "campaign",
      entityId: String(req.body.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) => console.error("notify influencer (created) failed:", e));

    createAndEmit({
      brandId: req.body.brandId,
      type: "milestone.created",
      title: `Milestone created for influencer ${req.body.influencerId}`,
      message: `${req.body.milestoneTitle} • $${Number(req.body.amount).toFixed(2)}`,
      entityType: "campaign",
      entityId: String(req.body.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error("notify brand (created) failed:", e));

    try {
      const [infDoc, brandDoc] = await Promise.all([
        Influencer.findById(emailData.influencerId, "name email").lean(),
        Brand.findById(emailData.brandId, "name").lean(),
      ]);

      if (infDoc && infDoc.email) {
        sendMilestoneCreatedEmail({
          to: infDoc.email,
          influencerName: infDoc.name || "",
          brandName: (brandDoc && brandDoc.name) || "",
          campaignName: emailData.campaignName,
          milestoneTitle: emailData.milestoneTitle,
          amount: emailData.amount,
          milestoneDescription: emailData.milestoneDescription,
          dashboardUrl: `${APP_BASE_URL}/influencer/my-campaign`,
        }).catch((e) => console.error("sendMilestoneCreatedEmail failed:", e));
      }
    } catch (emailErr) {
      console.error("Error preparing milestone created email:", emailErr);
    }

    return res.status(201).json(responsePayload);
  } catch (err) {
    await session.abortTransaction().catch(() => { });
    session.endSession();

    console.error("Error in createMilestone:", err);

    if (err.status) {
      return res.status(err.status).json({
        message: err.message,
        ...(err.extra || {}),
      });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/listByCampaign
// body: { campaignId }
// ======================================================================
exports.getMilestonesByCampaign = async (req, res) => {
  const { campaignId } = req.body;

  if (!campaignId) {
    return res.status(400).json({ message: "campaignId is required" });
  }

  try {
    const docs = await Milestone.find({
      "milestoneHistory.campaignId": String(campaignId),
    }).lean();

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter((e) => String(e.campaignId) === String(campaignId))
        .map((e) => ({
          ...e,
          milestoneHistoryId: String(e._id),
          brandId: String(doc.brandId),
          milestoneId: String(doc._id),
        }))
    );

    const influencerIds = [
      ...new Set(
        entries
          .map((e) => e.influencerId)
          .filter(Boolean)
          .map((id) => String(id))
      ),
    ];

    let influencers = [];

    if (influencerIds.length) {
      influencers = await Influencer.find(
        {
          $or: [
            { influencerId: { $in: influencerIds } },
            { _id: { $in: influencerIds } },
          ],
        },
        "_id influencerId name fullName username email"
      ).lean();
    }

    const influencerMap = new Map();

    influencers.forEach((inf) => {
      const displayName =
        inf.name || inf.fullName || inf.username || inf.email || "Unknown Influencer";

      if (inf.influencerId) {
        influencerMap.set(String(inf.influencerId), displayName);
      }

      if (inf._id) {
        influencerMap.set(String(inf._id), displayName);
      }
    });

    const contractPairs = [
      ...new Map(
        entries
          .filter((e) => e.influencerId && e.campaignId)
          .map((e) => [`${String(e.influencerId)}_${String(e.campaignId)}`, e])
      ).values(),
    ];

    const contracts = await Promise.all(
      contractPairs.map((e) =>
        Contract.findOne(
          {
            influencerId: String(e.influencerId),
            campaignId: String(e.campaignId),
          },
          {
            influencerId: 1,
            campaignId: 1,
            contractId: 1,
            paymentType: 1,
            currency: 1,
            "content.scheduleA.commercial.currency": 1,
            "content.scheduleA.commercial.totalCampaignFee": 1,
            "content.scheduleA.commercial.milestones": 1,
          }
        ).lean()
      )
    );

    const contractMap = new Map();

    contracts.forEach((contract) => {
      if (contract?.influencerId && contract?.campaignId) {
        const key = `${String(contract.influencerId)}_${String(contract.campaignId)}`;
        contractMap.set(key, contract);
      }
    });

    const entriesWithNames = entries.map((e) => {
      const contractKey = `${String(e.influencerId || "")}_${String(e.campaignId || "")}`;
      const contract = contractMap.get(contractKey) || null;

      return {
        ...e,
        influencerName: e.influencerId
          ? influencerMap.get(String(e.influencerId)) || "Unknown Influencer"
          : "Unknown Influencer",
        contractId: contract?.contractId || "",
        paymentType: contract?.paymentType || "",
        currency:
          contract?.currency ||
          contract?.content?.scheduleA?.commercial?.currency ||
          "",
        totalCampaignFee:
          contract?.content?.scheduleA?.commercial?.totalCampaignFee || 0,
        milestones:
          contract?.content?.scheduleA?.commercial?.milestones || [],
      };
    });

    entriesWithNames.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    return res.status(200).json({
      message: "Milestones fetched by campaign",
      milestones: entriesWithNames,
    });
  } catch (err) {
    console.error("Error in getMilestonesByCampaign:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/listByInfluencerAndCampaign
// body: { influencerId, campaignId, brandId? }
// ======================================================================

exports.getMilestonesByInfluencerAndCampaign = async (req, res) => {
  const { influencerId, campaignId, brandId } = req.body;

  if (!influencerId || !campaignId) {
    return res
      .status(400)
      .json({ message: "influencerId and campaignId are required" });
  }

  try {
    const filter = {
      milestoneHistory: {
        $elemMatch: {
          influencerId: String(influencerId),
          campaignId: String(campaignId),
        },
      },
    };

    if (brandId) {
      filter.brandId = String(brandId);
    }

    const [docs, campaignDoc, influencerDoc] = await Promise.all([
      Milestone.find(filter).lean(),

      Campaign.findOne({
        $or: [{ _id: campaignId }, { campaignId: String(campaignId) }],
      })
        .select("campaignTitle title")
        .lean(),

      Influencer.findOne({
        $or: [{ _id: influencerId }, { influencerId: String(influencerId) }],
      })
        .select("name fullName influencerName")
        .lean(),
    ]);

    const campaignTitle =
      campaignDoc?.campaignTitle || campaignDoc?.title || "";

    const influencerName =
      influencerDoc?.name ||
      influencerDoc?.fullName ||
      influencerDoc?.influencerName ||
      "";

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter(
          (e) =>
            String(e.influencerId) === String(influencerId) &&
            String(e.campaignId) === String(campaignId)
        )
        .map((e) => {
          let payoutStatus = e.payoutStatus;
          if (!payoutStatus) {
            payoutStatus = e.released ? "initiated" : "pending";
          }

          return {
            ...e,
            milestoneHistoryId: String(e._id),
            payoutStatus,
            brandId: doc.brandId,
            milestoneId: String(doc._id),
            campaignTitle,
            influencerName,
          };
        })
    );

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: "Milestones fetched by influencer and campaign",
      campaignTitle,
      influencerName,
      milestones: entries,
    });
  } catch (err) {
    console.error("Error in getMilestonesByInfluencerAndCampaign:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/listByInfluencer
// body: { influencerId }
// ======================================================================
exports.getMilestonesByInfluencer = async (req, res) => {
  const { influencerId } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: "influencerId is required" });
  }

  try {
    const docs = await Milestone.find({
      "milestoneHistory.influencerId": String(influencerId),
    }).lean();

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter((e) => String(e.influencerId) === String(influencerId))
        .map((e) => ({
          ...e,
          milestoneHistoryId: String(e._id),
          brandId: doc.brandId,
          milestoneId: String(doc._id),
        }))
    );

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: "Milestones fetched by influencer",
      milestones: entries,
    });
  } catch (err) {
    console.error("Error in getMilestonesByInfluencer:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/listByBrand
// body: { brandId }
// ======================================================================
exports.getMilestonesByBrand = async (req, res) => {
  const { brandId } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: "brandId is required" });
  }

  try {
    const [doc, wallet] = await Promise.all([
      Milestone.findOne({ brandId }).lean(),
      getWalletSnapshotByBrandId(brandId),
    ]);

    if (!doc) {
      return res.status(200).json({
        message: "No milestones found for this brand",
        wallet,
        milestones: [],
      });
    }

    const entries = (doc.milestoneHistory || []).map((e) => ({
      ...e,
      milestoneHistoryId: String(e._id),
      brandId: doc.brandId,
      milestoneId: String(doc._id),
    }));

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: "Milestones fetched by brand",
      wallet,
      totalAmount: Number(doc.totalAmount || 0),
      milestones: entries,
    });
  } catch (err) {
    console.error("Error in getMilestonesByBrand:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/balance
// body: { brandId }
// ======================================================================
exports.getWalletBalance = async (req, res) => {
  const { brandId } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: "brandId is required" });
  }

  try {
    const wallet = await getWalletSnapshotByBrandId(brandId);

    return res.status(200).json({
      message: "Wallet balance fetched",
      brandId,
      walletBalance: wallet.walletBalance,
      frozenBalance: wallet.frozenBalance,
      usableBalance: wallet.usableBalance,
    });
  } catch (err) {
    console.error("Error in getWalletBalance:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/release
// body: { milestoneId, milestoneHistoryId }
// ======================================================================
exports.releaseMilestone = async (req, res) => {
  const { milestoneId, milestoneHistoryId } = req.body;

  if (!milestoneId || !milestoneHistoryId) {
    return res.status(400).json({
      message: "milestoneId and milestoneHistoryId are required.",
    });
  }

  if (!mongoose.Types.ObjectId.isValid(milestoneId)) {
    return res.status(400).json({ message: "Invalid milestoneId." });
  }

  try {
    const doc = await Milestone.findById(milestoneId);
    if (!doc) {
      return res.status(404).json({ message: "Milestone not found." });
    }

    const entry = doc.milestoneHistory.id(milestoneHistoryId);
    if (!entry) {
      return res.status(404).json({ message: "Milestone history entry not found." });
    }

    if (entry.released) {
      return res.status(400).json({ message: "This milestone has already been released." });
    }

    const wallet = await getOrCreateBrandWallet(doc.brandId);

    const freezeIndex = (wallet.freezes || []).findIndex(
      (f) =>
        String(f.brandId) === String(doc.brandId) &&
        String(f.campaignId) === String(entry.campaignId) &&
        String(f.influencerId) === String(entry.influencerId)
    );

    if (freezeIndex < 0) {
      return res.status(400).json({
        message: "Frozen amount not found for this campaign and influencer.",
      });
    }

    const frozenAmount = Number(wallet.freezes[freezeIndex].freezeAmount || 0);
    const releaseAmount = Number(entry.amount || 0);

    if (frozenAmount < releaseAmount) {
      return res.status(400).json({
        message: "Frozen amount is less than milestone amount.",
        frozenAmount,
        releaseAmount,
      });
    }

    wallet.freezes[freezeIndex].freezeAmount = Math.max(0, frozenAmount - releaseAmount);

    if (wallet.freezes[freezeIndex].freezeAmount === 0) {
      wallet.freezes.splice(freezeIndex, 1);
    }

    wallet.walletBalance = Math.max(
      0,
      (Number(wallet.walletBalance) || 0) - releaseAmount
    );

    const walletSnap = syncUsableBalance(wallet);
    await wallet.save();

    entry.released = true;
    entry.releasedAt = new Date();
    entry.payoutStatus = "initiated";

    await doc.save();

    createAndEmit({
      influencerId: entry.influencerId,
      type: "milestone.initiated",
      title: `Milestone payout initiated${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ""
        }`,
      message:
        `Brand has released $${Number(entry.amount).toFixed(2)} for this campaign. ` +
        `It should be received within 24 - 48 hrs.`,
      entityType: "campaign",
      entityId: String(entry.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) => console.error("notify influencer (initiated) failed:", e));

    createAndEmit({
      brandId: doc.brandId,
      type: "milestone.released",
      title: `Milestone released${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ""}`,
      message: `You released $${Number(entry.amount).toFixed(2)} for this campaign.`,
      entityType: "campaign",
      entityId: String(entry.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error("notify brand (released) failed:", e));

    try {
      const [infDoc, brandDoc, campDoc] = await Promise.all([
        Influencer.findOne({ influencerId: entry.influencerId }, "name email").lean(),
        Brand.findOne({ brandId: doc.brandId }, "name").lean(),
        Campaign.findOne(
          { campaignsId: entry.campaignId },
          "productOrServiceName"
        ).lean(),
      ]);

      if (infDoc && infDoc.email) {
        sendMilestoneReleasedEmail({
          to: infDoc.email,
          influencerName: infDoc.name || "",
          brandName: (brandDoc && brandDoc.name) || "",
          campaignName: (campDoc && campDoc.productOrServiceName) || "",
          milestoneTitle: entry.milestoneTitle,
          amount: entry.amount,
          milestoneDescription: entry.milestoneDescription,
          dashboardUrl: `${APP_BASE_URL}/influencer/my-campaign`,
        }).catch((e) => console.error("sendMilestoneReleasedEmail failed:", e));
      }
    } catch (emailErr) {
      console.error("Error preparing milestone released email:", emailErr);
    }

    return res.status(200).json({
      message: "Milestone released successfully (payout initiated).",
      releasedAmount: entry.amount,
      payoutStatus: entry.payoutStatus,
      wallet: {
        walletBalance: walletSnap.walletBalance,
        frozenBalance: walletSnap.frozenBalance,
        usableBalance: walletSnap.usableBalance,
      },
    });
  } catch (err) {
    console.error("Error in releaseMilestone:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ======================================================================
// POST /milestone/paidTotal
// body: { influencerId }
// ======================================================================
exports.getInfluencerPaidTotal = async (req, res) => {
  const { influencerId } = req.body;

  if (!influencerId) {
    return res.status(400).json({ message: "influencerId is required." });
  }

  if (!mongoose.Types.ObjectId.isValid(influencerId)) {
    return res.status(400).json({ message: "Invalid influencerId." });
  }

  try {
    const result = await Milestone.aggregate([
      { $unwind: "$milestoneHistory" },
      {
        $match: {
          "milestoneHistory.influencerId": new mongoose.Types.ObjectId(influencerId),
        },
      },
      {
        $group: {
          _id: null,
          totalPaid: {
            $sum: {
              $cond: [
                { $eq: ["$milestoneHistory.payoutStatus", "paid"] },
                "$milestoneHistory.amount",
                0,
              ],
            },
          },
          totalUpcoming: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$milestoneHistory.payoutStatus", "pending"] },
                    { $eq: ["$milestoneHistory.released", false] },
                  ],
                },
                "$milestoneHistory.amount",
                0,
              ],
            },
          },
          totalInitiated: {
            $sum: {
              $cond: [
                { $eq: ["$milestoneHistory.payoutStatus", "initiated"] },
                "$milestoneHistory.amount",
                0,
              ],
            },
          },
        },
      },
    ]);

    const summary = result[0] || {
      totalPaid: 0,
      totalUpcoming: 0,
      totalInitiated: 0,
    };

    return res.status(200).json({
      influencerId,
      totalPaid: summary.totalPaid,
      totalPending: summary.totalPending,
      totalUpcoming: summary.totalUpcoming,
      totalInitiated: summary.totalInitiated,
    });
  } catch (err) {
    console.error("Error getting influencer payout totals:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ======================================================================
// POST /milestone/adminListPayouts
// body: { status = 'all' | 'initiated' | 'paid' | [...], page, limit }
// ======================================================================
exports.adminListPayouts = async (req, res) => {
  try {
    const { status = "all", page = 1, limit = 20, search = "" } = req.body || {};

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Number(limit) || 20);
    const searchText = String(search || "").trim().toLowerCase();

    let statusFilter;
    if (status === "all" || status === undefined || status === null || status === "") {
      statusFilter = "all";
    } else if (Array.isArray(status)) {
      statusFilter = status.map(String);
    } else {
      statusFilter = [String(status)];
    }

    const docs = await Milestone.find({ "milestoneHistory.released": true }).lean();

    let entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter((e) => e.released)
        .map((e) => ({
          ...e,
          milestoneHistoryId: String(e._id),
          brandId: String(doc.brandId || ""),
          milestoneId: String(doc._id),
        }))
    );

    if (statusFilter !== "all") {
      entries = entries.filter((e) =>
        statusFilter.includes(String(e.payoutStatus || "initiated"))
      );
    }

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const brandIds = [...new Set(entries.map((e) => String(e.brandId || "")).filter(Boolean))];
    const influencerIds = [...new Set(entries.map((e) => String(e.influencerId || "")).filter(Boolean))];
    const campaignIds = [...new Set(entries.map((e) => String(e.campaignId || "")).filter(Boolean))];

    const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

    const brandObjectIds = brandIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));
    const influencerObjectIds = influencerIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));
    const campaignObjectIds = campaignIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));

    const [brands, influencers, campaigns] = await Promise.all([
      Brand.find(
        {
          $or: [
            { brandId: { $in: brandIds } },
            { _id: { $in: brandObjectIds } },
          ],
        },
        "_id brandId name email companyName"
      ).lean(),
      Influencer.find(
        {
          $or: [
            { influencerId: { $in: influencerIds } },
            { _id: { $in: influencerObjectIds } },
          ],
        },
        "_id influencerId name fullName username email"
      ).lean(),
      Campaign.find(
        {
          $or: [
            { campaignsId: { $in: campaignIds } },
            { _id: { $in: campaignObjectIds } },
          ],
        },
        "_id campaignsId campaignTitle productOrServiceName brandName"
      ).lean(),
    ]);

    const brandMap = new Map();
    brands.forEach((b) => {
      const displayName = b.name || b.companyName || b.email || "Unknown Brand";
      if (b.brandId) brandMap.set(String(b.brandId), displayName);
      if (b._id) brandMap.set(String(b._id), displayName);
    });

    const influencerMap = new Map();
    influencers.forEach((i) => {
      const displayName =
        i.name || i.fullName || i.username || i.email || "Unknown Influencer";

      const value = {
        name: displayName,
        email: i.email || null,
      };

      if (i.influencerId) influencerMap.set(String(i.influencerId), value);
      if (i._id) influencerMap.set(String(i._id), value);
    });

    const campaignMap = new Map();
    campaigns.forEach((c) => {
      const value = {
        title: c.campaignTitle || c.productOrServiceName || "Untitled Campaign",
        brandName: c.brandName || null,
      };

      if (c.campaignsId) campaignMap.set(String(c.campaignsId), value);
      if (c._id) campaignMap.set(String(c._id), value);
    });

    let items = entries.map((e) => {
      const inf = influencerMap.get(String(e.influencerId || "")) || {};
      const campaign = campaignMap.get(String(e.campaignId || "")) || {};

      return {
        milestoneId: e.milestoneId,
        milestoneHistoryId: e.milestoneHistoryId,
        milestoneTitle: e.milestoneTitle || null,
        milestoneDescription: e.milestoneDescription || null,
        brandId: e.brandId,
        brandName: brandMap.get(String(e.brandId || "")) || campaign.brandName || null,
        influencerId: e.influencerId,
        influencerName: inf.name || null,
        influencerEmail: inf.email || null,
        campaignId: e.campaignId,
        campaignTitle: campaign.title || null,
        amount: Number(e.amount || 0),
        payoutStatus: e.payoutStatus || "initiated",
        releasedAt: e.releasedAt || null,
        paidAt: e.paidAt || null,
        createdAt: e.createdAt,
      };
    });

    if (searchText) {
      items = items.filter((item) =>
        [
          item.brandName,
          item.influencerName,
          item.influencerEmail,
          item.campaignTitle,
          item.milestoneTitle,
          item.brandId,
          item.influencerId,
          item.campaignId,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(searchText))
      );
    }

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const start = (pageNum - 1) * limitNum;
    const pagedItems = items.slice(start, start + limitNum);

    return res.status(200).json({
      message: "Milestone payouts for admin",
      page: pageNum,
      limit: limitNum,
      total,
      totalPages,
      items: pagedItems,
    });
  } catch (err) {
    console.error("Error in adminListPayouts:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/adminMarkMilestonePaid
// body: { milestoneId, milestoneHistoryId }
// ======================================================================
exports.adminMarkMilestonePaid = async (req, res) => {
  const { milestoneId, milestoneHistoryId } = req.body;

  if (!milestoneId || !milestoneHistoryId) {
    return res.status(400).json({
      message: "milestoneId and milestoneHistoryId are required.",
    });
  }

  if (!mongoose.Types.ObjectId.isValid(milestoneId)) {
    return res.status(400).json({ message: "Invalid milestoneId." });
  }

  try {
    const doc = await Milestone.findById(milestoneId);
    if (!doc) {
      return res.status(404).json({ message: "Milestone not found." });
    }

    const entry = doc.milestoneHistory.id(milestoneHistoryId);
    if (!entry) {
      return res.status(404).json({ message: "Milestone history entry not found." });
    }

    if (!entry.released) {
      return res.status(400).json({ message: "Milestone not released yet." });
    }

    if (entry.payoutStatus === "paid") {
      return res.status(400).json({
        message: "This milestone is already marked as paid.",
      });
    }

    entry.payoutStatus = "paid";
    entry.paidAt = new Date();

    await doc.save();

    createAndEmit({
      influencerId: entry.influencerId,
      type: "milestone.paid",
      title: `Milestone paid${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ""}`,
      message: `Your payout of $${Number(entry.amount).toFixed(
        2
      )} has been approved and marked as paid.`,
      entityType: "campaign",
      entityId: String(entry.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) => console.error("notify influencer (paid) failed:", e));

    createAndEmit({
      brandId: doc.brandId,
      type: "milestone.paid",
      title: "Payout completed",
      message: `${entry.milestoneTitle || "Milestone"} of $${Number(
        entry.amount
      ).toFixed(2)} has been marked as paid.`,
      entityType: "campaign",
      entityId: String(entry.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error("notify brand (paid) failed:", e));

    try {
      const [infDoc, brandDoc, campDoc] = await Promise.all([
        Influencer.findOne({ influencerId: entry.influencerId }, "name email").lean(),
        Brand.findOne({ brandId: doc.brandId }, "name").lean(),
        Campaign.findOne(
          { campaignsId: entry.campaignId },
          "productOrServiceName"
        ).lean(),
      ]);

      if (infDoc && infDoc.email) {
        sendMilestonePaidEmail({
          to: infDoc.email,
          influencerName: infDoc.name || "",
          brandName: (brandDoc && brandDoc.name) || "",
          campaignName: (campDoc && campDoc.productOrServiceName) || "",
          milestoneTitle: entry.milestoneTitle,
          amount: entry.amount,
          milestoneDescription: entry.milestoneDescription,
          dashboardUrl: `${APP_BASE_URL}/influencer/my-campaign`,
        }).catch((e) => console.error("sendMilestonePaidEmail failed:", e));
      }
    } catch (emailErr) {
      console.error("Error preparing milestone paid email:", emailErr);
    }

    return res.status(200).json({
      message: "Milestone marked as paid.",
      payoutStatus: entry.payoutStatus,
    });
  } catch (err) {
    console.error("Error in adminMarkMilestonePaid:", err);
    return res.status(500).json({ message: "Internal server error." });
  }
};

exports.getPayoutDetailsByInfluencer = async (req, res) => {
  const { influencerId } = req.body;

  if (!influencerId) {
    return res.status(400).json({ message: "influencerId is required" });
  }

  try {
    const docs = await Milestone.find({
      "milestoneHistory.influencerId": String(influencerId),
    }).lean();

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter((e) => String(e.influencerId) === String(influencerId))
        .map((e) => ({
          campaignId: String(e.campaignId),
          amount: Number(e.amount || 0),
          payoutStatus: e.payoutStatus || (e.released ? "initiated" : "pending"),
          createdAt: e.createdAt,
        }))
    );

    const campaignIds = [
      ...new Set(entries.map((e) => e.campaignId).filter(Boolean)),
    ];

    let campaigns = [];
    if (campaignIds.length) {
      campaigns = await Campaign.find(
        {
          $or: [
            { _id: { $in: campaignIds } },
            { campaignsId: { $in: campaignIds } },
          ],
        },
        "_id campaignsId campaignTitle title productOrServiceName"
      ).lean();
    }

    const campaignMap = new Map();
    campaigns.forEach((camp) => {
      const title =
        camp.campaignTitle || camp.title || camp.productOrServiceName || "";

      if (camp._id) {
        campaignMap.set(String(camp._id), title);
      }
      if (camp.campaignsId) {
        campaignMap.set(String(camp.campaignsId), title);
      }
    });

    const payoutList = entries
      .map((e) => ({
        campaignId: e.campaignId,
        campaignTitle: campaignMap.get(String(e.campaignId)) || "",
        amount: e.amount,
        payoutStatus: e.payoutStatus,
        createdAt: e.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: "Payout details fetched successfully",
      influencerId,
      payouts: payoutList,
    });
  } catch (err) {
    console.error("Error in getPayoutDetailsByInfluencer:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};