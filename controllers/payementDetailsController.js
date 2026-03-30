const PaymentDetails = require("../models/paymentDetails");
const mongoose = require("mongoose");

// Add new payment method
exports.addPaymentDetails = async (req, res) => {
  try {
    const {
      influencerId,
      label,
      type,
      bank,
      paypal,
      isDefault,
    } = req.body;

    if (!influencerId) {
      return res.status(400).json({
        success: false,
        message: "influencerId is required",
      });
    }

    if (type !== 0 && type !== 1) {
      return res.status(400).json({
        success: false,
        message: "type must be 0 (PayPal) or 1 (Bank)",
      });
    }

    if (type === 1 && !bank) {
      return res.status(400).json({
        success: false,
        message: "bank details are required for Bank payment method",
      });
    }

    if (type === 0 && !paypal) {
      return res.status(400).json({
        success: false,
        message: "paypal details are required for PayPal payment method",
      });
    }

    // optional duplicate prevention
    if (type === 0 && paypal?.email) {
      const existingPaypal = await PaymentDetails.findOne({
        influencerId,
        type: 0,
        "paypal.email": paypal.email,
      });

      if (existingPaypal) {
        return res.status(409).json({
          success: false,
          message: "This PayPal method already exists for this influencer",
        });
      }
    }

    if (type === 1 && bank?.accountNumber) {
      const existingBank = await PaymentDetails.findOne({
        influencerId,
        type: 1,
        "bank.accountNumber": bank.accountNumber,
      });

      if (existingBank) {
        return res.status(409).json({
          success: false,
          message: "This bank account already exists for this influencer",
        });
      }
    }

    // if new one is default, unset old defaults
    if (isDefault === true) {
      await PaymentDetails.updateMany(
        { influencerId },
        { $set: { isDefault: false } }
      );
    }

    const paymentDetails = new PaymentDetails({
      influencerId,
      label: label || "",
      type,
      bank: type === 1 ? bank : undefined,
      paypal: type === 0 ? paypal : undefined,
      isDefault: isDefault || false,
    });

    await paymentDetails.save();

    return res.status(201).json({
      success: true,
      message: "Payment method added successfully",
      data: paymentDetails,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to add payment method",
      error: error.message,
    });
  }
};

// Edit payment details
exports.editPaymentDetails = async (req, res) => {
  try {
    const { paymentMethodId, influencerId, label, type, bank, paypal, isDefault } = req.body;

    if (!paymentMethodId) {
      return res.status(400).json({
        success: false,
        message: "paymentMethodId is required",
      });
    }

    const paymentDetails = await PaymentDetails.findById(paymentMethodId);

    if (!paymentDetails) {
      return res.status(404).json({
        success: false,
        message: "Payment method not found",
      });
    }

    if (influencerId && paymentDetails.influencerId.toString() !== influencerId) {
      return res.status(403).json({
        success: false,
        message: "This payment method does not belong to the provided influencerId",
      });
    }

    if (label !== undefined) {
      paymentDetails.label = label;
    }

    if (type !== undefined) {
      if (type !== 0 && type !== 1) {
        return res.status(400).json({
          success: false,
          message: "type must be 0 (PayPal) or 1 (Bank)",
        });
      }

      paymentDetails.type = type;
    }

    if (paymentDetails.type === 1) {
      paymentDetails.bank = {
        ...(paymentDetails.bank ? paymentDetails.bank.toObject() : {}),
        ...(bank || {}),
      };
      paymentDetails.paypal = undefined;
    }

    if (paymentDetails.type === 0) {
      paymentDetails.paypal = {
        ...(paymentDetails.paypal ? paymentDetails.paypal.toObject() : {}),
        ...(paypal || {}),
      };
      paymentDetails.bank = undefined;
    }

    if (typeof isDefault === "boolean") {
      if (isDefault === true) {
        await PaymentDetails.updateMany(
          { influencerId: paymentDetails.influencerId },
          { $set: { isDefault: false } }
        );
      }
      paymentDetails.isDefault = isDefault;
    }

    await paymentDetails.save();

    return res.status(200).json({
      success: true,
      message: "Payment method updated successfully",
      data: paymentDetails,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update payment method",
      error: error.message,
    });
  }
};

// Delete payment details
exports.deletePaymentDetails = async (req, res) => {
  try {
    const { paymentMethodId, influencerId } = req.body;

    if (!paymentMethodId) {
      return res.status(400).json({
        success: false,
        message: "paymentMethodId is required",
      });
    }

    const paymentDetails = await PaymentDetails.findById(paymentMethodId);

    if (!paymentDetails) {
      return res.status(404).json({
        success: false,
        message: "Payment method not found",
      });
    }

    if (influencerId && paymentDetails.influencerId.toString() !== influencerId) {
      return res.status(403).json({
        success: false,
        message: "This payment method does not belong to the provided influencerId",
      });
    }

    await PaymentDetails.findByIdAndDelete(paymentMethodId);

    return res.status(200).json({
      success: true,
      message: "Payment method deleted successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete payment method",
      error: error.message,
    });
  }
};

// Get payment details by influencerId
exports.getPaymentDetails = async (req, res) => {
  try {
    const { influencerId } = req.body;

    if (!influencerId) {
      return res.status(400).json({
        success: false,
        message: "influencerId is required",
      });
    }

    const paymentDetails = await PaymentDetails.find({ influencerId }).sort({
      isDefault: -1,
      createdAt: -1,
    });

    return res.status(200).json({
      success: true,
      count: paymentDetails.length,
      data: paymentDetails,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch payment methods",
      error: error.message,
    });
  }
};