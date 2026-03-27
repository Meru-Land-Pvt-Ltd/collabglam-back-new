const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const BrandModelImport = require("../models/brand");
const VerifyOtpModelImport = require("../models/verifyOtp");
const OtpTemplateImport = require("../template/otpTemplate");
const ResetOtpTemplateImport = require("../template/resetOtp");
const EmailServiceImport = require("../services/emailService");
const ApiResponseImport = require("../core/http/ApiResponse");
const HttpStatusImport = require("../core/http/HttpStatus");
const ApiErrorImport = require("../core/http/ApiError");
const SubscriptionPlan = require("../models/subscription");

const BrandModel =
  BrandModelImport.BrandModel || BrandModelImport.default || BrandModelImport;

const VerifyOtpModel =
  VerifyOtpModelImport.VerifyOtpModel ||
  VerifyOtpModelImport.default ||
  VerifyOtpModelImport;

const buildOtpEmailTemplate =
  OtpTemplateImport.buildOtpEmailTemplate ||
  OtpTemplateImport.default ||
  OtpTemplateImport;

const resetOtpEmailTemplate =
  ResetOtpTemplateImport.resetOtpEmailTemplate ||
  ResetOtpTemplateImport.default ||
  ResetOtpTemplateImport;

const sendEmail =
  EmailServiceImport.sendEmail ||
  EmailServiceImport.default ||
  EmailServiceImport;

const ApiResponse =
  ApiResponseImport.ApiResponse ||
  ApiResponseImport.default ||
  ApiResponseImport;

const HttpStatus =
  HttpStatusImport.HttpStatus ||
  HttpStatusImport.default ||
  HttpStatusImport;

const ApiError = ApiErrorImport.ApiError || ApiErrorImport;
const ValidationError = ApiErrorImport.ValidationError;
const UnauthorizedError = ApiErrorImport.UnauthorizedError;
const ConflictError = ApiErrorImport.ConflictError;
const InternalError = ApiErrorImport.InternalError;
const NotFoundError = ApiErrorImport.NotFoundError;
const RateLimitError = ApiErrorImport.RateLimitError;

let ErrorCodes;
try {
  ErrorCodes = require("../core/http/errorCodes").ErrorCodes;
} catch {
  ErrorCodes = {
    AUTH_INVALID_TOKEN: "AUTH_INVALID_TOKEN",
    AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
    OTP_RATE_LIMIT: "OTP_RATE_LIMIT",
    OTP_DAILY_LIMIT: "OTP_DAILY_LIMIT",
    SIGNIN_RATE_LIMIT: "SIGNIN_RATE_LIMIT",
    SIGNIN_DAILY_LIMIT: "SIGNIN_DAILY_LIMIT",
    INTERNAL_ERROR: "INTERNAL_ERROR",
    CONFLICT: "CONFLICT",
    VALIDATION_FAILED: "VALIDATION_FAILED",
    RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
    RATE_LIMITED: "RATE_LIMITED",
  };
}

const OTP_TTL_MIN = Number(process.env.OTP_TTL_MINUTES || 3);
const RESET_TTL_MIN = Number(process.env.RESET_PASSWORD_TTL_MINUTES || 15);

const OTP_TTL_MS = OTP_TTL_MIN * 60 * 1000;
const RESET_TTL_MS = RESET_TTL_MIN * 60 * 1000;

const OTP_TOTAL = 6;
const OTP_BATCH_LIMIT = 3;
const OTP_COOLDOWN_MIN = 15;
const OTP_RESET_HOURS = 24;

const SIGNIN_TOTAL = 9;
const SIGNIN_BATCH = 3;
const SIGNIN_LOCK_1_MIN = 1;
const SIGNIN_LOCK_15_MIN = 15;
const SIGNIN_LOCK_24_HOURS = 24;

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const safeTrim = (value) => String(value || "").trim();

const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

const isPasswordLenOk = (password) => {
  const len = String(password || "").trim().length;
  return len >= 8 && len <= 16;
};

const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));

function assertCallable(fn, name) {
  if (typeof fn !== "function") {
    throw new Error(`${name} export is invalid`);
  }
}

assertCallable(buildOtpEmailTemplate, "buildOtpEmailTemplate");
assertCallable(resetOtpEmailTemplate, "resetOtpEmailTemplate");
assertCallable(sendEmail, "sendEmail");

const hashOtp = (email, otp) => {
  const secret = process.env.OTP_SECRET || "dev-secret";
  return crypto
    .createHash("sha256")
    .update(`${normalizeEmail(email)}:${String(otp)}:${secret}`)
    .digest("hex");
};

function signJwt(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new InternalError("JWT_SECRET is missing in env");

  return jwt.sign(payload, secret, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function signResetJwt(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new InternalError("JWT_SECRET is missing in env");

  return jwt.sign(payload, secret, {
    expiresIn: `${RESET_TTL_MIN}m`,
  });
}

function getBearerToken(req) {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid Authorization header");
  }

  return auth.slice(7).trim();
}

function isQAArray(value) {
  if (!Array.isArray(value)) return false;

  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    if (typeof item.question !== "string" || !item.question.trim()) return false;
    if (!Array.isArray(item.answers) || item.answers.length === 0) return false;

    return item.answers.every(
      (answer) => typeof answer === "string" && answer.trim().length > 0
    );
  });
}

function msToWaitString(ms) {
  const sec = Math.ceil(ms / 1000);
  if (sec <= 60) return `${sec} seconds`;

  const min = Math.ceil(sec / 60);
  if (min <= 60) return `${min} minutes`;

  const hr = Math.ceil(min / 60);
  return `${hr} hours`;
}

function buildSafeSignupPayload(body) {
  return {
    brandName: safeTrim(body.brandName),
    name: safeTrim(body.name) || safeTrim(body.brandName),
    companySize: safeTrim(body.companySize),
    industry: safeTrim(body.industry),
    passwordHash: String(body.password || ""),
  };
}


function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

function buildSubscriptionFromPlan(plan) {
  const now = new Date();

  return {
    planId: plan.planId,
    planName: plan.name,
    role: plan.role || "Brand",
    planRef: plan._id,
    monthlyCost: plan.monthlyCost ?? 0,
    annualCost: plan.annualCost ?? 0,
    billingCycle: "monthly",
    autoRenew: plan.autoRenew ?? false,
    status: plan.status || "active",
    durationMins: plan.durationMins ?? 43200,
    startedAt: now,
    expiresAt: null,
    features: (plan.features || []).map((feature) => ({
      key: feature.key,
      value: feature.value ?? null,
      limit: featureValueToLimit(feature.value),
      used: 0,
      note: feature.note ?? null,
      resetsEvery: null,
      resetsAt: null,
    })),
    internalCredits: {
      used: 0,
      resetsAt: null,
    },
  };
}

function validateSignupRequest(body) {
  const brandName = safeTrim(body.brandName);
  const email = normalizeEmail(body.email);
  const industry = safeTrim(body.industry);
  const password = String(body.password || "");

  if (!brandName) throw new ValidationError("Brand name is required");
  if (!email || !isValidEmail(email)) {
    throw new ValidationError("Valid email is required");
  }
  if (!industry) throw new ValidationError("Industry is required");
  if (!password.trim()) throw new ValidationError("Password is required");
  if (!isPasswordLenOk(password)) {
    throw new ValidationError("Password must be 8 to 16 characters.");
  }
}

function rethrowAsApiError(err) {
  if (err instanceof ApiError) throw err;

  if (err && err.code === 11000) {
    const field =
      Object.keys(err.keyPattern || err.keyValue || {})[0] || "unknown";
    const value = err.keyValue?.[field];

    if (field === "email") {
      throw new ConflictError("Email already registered. Please login.", {
        field,
        value,
      });
    }

    throw new ConflictError(
      `${field} already exists. Please use a different value.`,
      { field, value }
    );
  }

  if (err && err.name === "ValidationError") {
    const fields = err.errors ? Object.keys(err.errors) : [];
    throw new ValidationError(err.message, { fields });
  }

  if (err && err.name === "CastError") {
    throw new ValidationError("Invalid input", { field: err.path });
  }

  throw err;
}

function handleControllerError(next, err, context = "brandController") {
  try {
    rethrowAsApiError(err);
  } catch (mapped) {
    err = mapped;
  }

  if (!(err instanceof ApiError)) {
    console.error(`[${context}]`, {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
  }

  if (err instanceof ApiError) return next(err);
  return next(new InternalError("Internal server error", null, err));
}

async function findBrandByEmail(email, includePassword = false) {
  let query = BrandModel.findOne({ email: normalizeEmail(email) });

  if (includePassword) {
    query = query.select("+password");
  }

  return query.exec();
}

async function clearPendingOtpDocs(email, purpose) {
  await VerifyOtpModel.deleteMany({
    email: normalizeEmail(email),
    role: "brand",
    docType: "otp",
    purpose,
    status: 0,
  }).exec();
}

async function clearAllOtpDocs(email, purpose) {
  await VerifyOtpModel.deleteMany({
    email: normalizeEmail(email),
    role: "brand",
    docType: "otp",
    purpose,
  }).exec();
}

async function createOtpDoc({
  email,
  purpose,
  otpPlain,
  userId = null,
  signupPayload = null,
}) {
  return VerifyOtpModel.create({
    email: normalizeEmail(email),
    role: "brand",
    otp: hashOtp(email, otpPlain),
    status: 0,
    userId,
    docType: "otp",
    purpose,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    signupPayload,
  });
}

async function getLatestPendingOtp(email, purpose) {
  return VerifyOtpModel.findOne({
    email: normalizeEmail(email),
    role: "brand",
    docType: "otp",
    purpose,
    status: 0,
  })
    .sort({ createdAt: -1 })
    .exec();
}

function assertValidOtpDoc(otpDoc, email, otp) {
  if (!otpDoc) {
    throw new ValidationError(
      "OTP not requested or expired. Please request a new OTP."
    );
  }

  if (otpDoc.expiresAt && Date.now() > new Date(otpDoc.expiresAt).getTime()) {
    throw new ValidationError("OTP expired. Please request a new OTP.");
  }

  const incomingHash = hashOtp(email, String(otp));
  if (incomingHash !== otpDoc.otp) {
    throw new ValidationError("Invalid OTP");
  }
}

async function markOtpUsed(otpDoc, options = {}) {
  const { userId = null, extendExpiryMs = null } = options;

  const update = {
    status: 1,
    userId: userId || otpDoc.userId || null,
  };

  if (extendExpiryMs && Number(extendExpiryMs) > 0) {
    update.expiresAt = new Date(Date.now() + Number(extendExpiryMs));
  }

  await VerifyOtpModel.updateOne(
    { _id: otpDoc._id, status: 0 },
    { $set: update }
  ).exec();
}

async function getSigninLimitDoc(email) {
  return VerifyOtpModel.findOneAndUpdate(
    {
      email: normalizeEmail(email),
      role: "brand",
      docType: "limit",
      key: "signin_limit",
    },
    {
      $setOnInsert: {
        email: normalizeEmail(email),
        role: "brand",
        docType: "limit",
        key: "signin_limit",
        otp: "__SIGNIN_LIMIT__",
        status: 0,
        userId: null,
        signinFailedCount: 0,
        signinCooldownUntil: null,
        signinResetAt: null,
      },
    },
    { new: true, upsert: true }
  ).exec();
}

async function enforceOtpLimitByKey(email, key) {
  const normalizedEmail = normalizeEmail(email);
  const nowMs = Date.now();

  const limitDoc = await VerifyOtpModel.findOneAndUpdate(
    { email: normalizedEmail, role: "brand", docType: "limit", key },
    {
      $setOnInsert: {
        email: normalizedEmail,
        role: "brand",
        otp: key === "signup_limit" ? "__SIGNUP_LIMIT__" : "__FORGOT_LIMIT__",
        status: 0,
        userId: null,
        docType: "limit",
        key,
        signupOtpSend: OTP_TOTAL,
        signupOtpBatchCount: 0,
        signupOtpCooldownUntil: null,
        signupOtpResetAt: null,
      },
    },
    { new: true, upsert: true }
  ).exec();

  if (
    limitDoc.signupOtpResetAt &&
    nowMs >= new Date(limitDoc.signupOtpResetAt).getTime()
  ) {
    limitDoc.signupOtpSend = OTP_TOTAL;
    limitDoc.signupOtpBatchCount = 0;
    limitDoc.signupOtpCooldownUntil = null;
    limitDoc.signupOtpResetAt = null;
    await limitDoc.save();
  }

  if ((limitDoc.signupOtpSend ?? OTP_TOTAL) <= 0) {
    if (!limitDoc.signupOtpResetAt) {
      limitDoc.signupOtpResetAt = new Date(
        nowMs + OTP_RESET_HOURS * 60 * 60 * 1000
      );
      await limitDoc.save();
    }

    throw new RateLimitError("Try again after 24 hours.", {
      code: ErrorCodes.OTP_DAILY_LIMIT,
    });
  }

  if (
    limitDoc.signupOtpCooldownUntil &&
    nowMs < new Date(limitDoc.signupOtpCooldownUntil).getTime()
  ) {
    const waitMs =
      new Date(limitDoc.signupOtpCooldownUntil).getTime() - nowMs;

    throw new RateLimitError(`Try again in ${msToWaitString(waitMs)}.`, {
      code: ErrorCodes.OTP_RATE_LIMIT,
    });
  }

  limitDoc.signupOtpSend = (limitDoc.signupOtpSend ?? OTP_TOTAL) - 1;
  limitDoc.signupOtpBatchCount = (limitDoc.signupOtpBatchCount ?? 0) + 1;

  if (limitDoc.signupOtpBatchCount >= OTP_BATCH_LIMIT) {
    limitDoc.signupOtpCooldownUntil = new Date(
      nowMs + OTP_COOLDOWN_MIN * 60 * 1000
    );
    limitDoc.signupOtpBatchCount = 0;
  }

  if (limitDoc.signupOtpSend <= 0) {
    limitDoc.signupOtpSend = 0;
    limitDoc.signupOtpResetAt = new Date(
      nowMs + OTP_RESET_HOURS * 60 * 60 * 1000
    );
  }

  await limitDoc.save();
}

async function enforceSigninLimit(email) {
  const nowMs = Date.now();
  const doc = await getSigninLimitDoc(email);

  if (doc.signinResetAt && nowMs >= new Date(doc.signinResetAt).getTime()) {
    doc.signinFailedCount = 0;
    doc.signinCooldownUntil = null;
    doc.signinResetAt = null;
    await doc.save();
  }

  if (
    doc.signinCooldownUntil &&
    nowMs < new Date(doc.signinCooldownUntil).getTime()
  ) {
    const waitMs = new Date(doc.signinCooldownUntil).getTime() - nowMs;

    throw new RateLimitError(
      `Too many failed login attempts. Try again in ${msToWaitString(waitMs)}.`,
      { code: ErrorCodes.SIGNIN_RATE_LIMIT }
    );
  }

  if ((doc.signinFailedCount ?? 0) >= SIGNIN_TOTAL) {
    if (!doc.signinResetAt) {
      doc.signinResetAt = new Date(
        nowMs + SIGNIN_LOCK_24_HOURS * 60 * 60 * 1000
      );
      await doc.save();
    }

    throw new RateLimitError(
      "Too many failed login attempts. Try again after 24 hours.",
      { code: ErrorCodes.SIGNIN_DAILY_LIMIT }
    );
  }
}

async function recordFailedSignin(email) {
  const nowMs = Date.now();
  const doc = await getSigninLimitDoc(email);

  if (doc.signinResetAt && nowMs >= new Date(doc.signinResetAt).getTime()) {
    doc.signinFailedCount = 0;
    doc.signinCooldownUntil = null;
    doc.signinResetAt = null;
  }

  doc.signinFailedCount = (doc.signinFailedCount ?? 0) + 1;

  if (doc.signinFailedCount % SIGNIN_BATCH === 0) {
    const batchNo = doc.signinFailedCount / SIGNIN_BATCH;

    if (batchNo === 1) {
      doc.signinCooldownUntil = new Date(nowMs + SIGNIN_LOCK_1_MIN * 60 * 1000);
    } else if (batchNo === 2) {
      doc.signinCooldownUntil = new Date(
        nowMs + SIGNIN_LOCK_15_MIN * 60 * 1000
      );
    } else {
      doc.signinCooldownUntil = new Date(
        nowMs + SIGNIN_LOCK_24_HOURS * 60 * 60 * 1000
      );
      doc.signinResetAt = doc.signinCooldownUntil;
      doc.signinFailedCount = SIGNIN_TOTAL;
    }
  }

  await doc.save();

  if (
    doc.signinCooldownUntil &&
    nowMs < new Date(doc.signinCooldownUntil).getTime()
  ) {
    const waitMs = new Date(doc.signinCooldownUntil).getTime() - nowMs;

    throw new RateLimitError(
      (doc.signinFailedCount ?? 0) >= SIGNIN_TOTAL
        ? "Too many failed login attempts. Try again after 24 hours."
        : `Too many failed login attempts. Try again in ${msToWaitString(waitMs)}.`,
      {
        code:
          (doc.signinFailedCount ?? 0) >= SIGNIN_TOTAL
            ? ErrorCodes.SIGNIN_DAILY_LIMIT
            : ErrorCodes.SIGNIN_RATE_LIMIT,
      }
    );
  }
}

async function resetSigninLimit(email) {
  await VerifyOtpModel.updateOne(
    {
      email: normalizeEmail(email),
      role: "brand",
      docType: "limit",
      key: "signin_limit",
    },
    {
      $set: {
        signinFailedCount: 0,
        signinCooldownUntil: null,
        signinResetAt: null,
      },
    }
  ).exec();
}

async function sendSignupOtp(req, res, next) {
  const requestId = req.requestId || "";
  let otpDoc = null;

  try {
    validateSignupRequest(req.body || {});

    const email = normalizeEmail(req.body.email);
    const existingBrand = await findBrandByEmail(email);

    if (existingBrand) {
      throw new ConflictError("Email already registered. Please login.");
    }

    await enforceOtpLimitByKey(email, "signup_limit");
    await clearPendingOtpDocs(email, "signup");

    const otpPlain = genOtp();
    const signupPayload = buildSafeSignupPayload(req.body);

    otpDoc = await createOtpDoc({
      email,
      purpose: "signup",
      otpPlain,
      signupPayload,
    });

    const { subject, text, html } = buildOtpEmailTemplate({
      otp: otpPlain,
      role: "Brand",
      expiryMinutes: OTP_TTL_MIN,
      purpose: "signup",
    });

    await sendEmail({ to: email, subject, text, html });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "OTP sent successfully",
        email,
      },
      requestId
    );
  } catch (err) {
    if (otpDoc?._id) {
      try {
        await VerifyOtpModel.deleteOne({ _id: otpDoc._id }).exec();
      } catch (cleanupErr) {
        console.error("[sendSignupOtp.cleanup]", {
          name: cleanupErr?.name,
          message: cleanupErr?.message,
        });
      }
    }

    return handleControllerError(next, err, "sendSignupOtp");
  }
}

async function verifyOtpSignUp(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || "").trim();

    if (!email || !isValidEmail(email)) {
      throw new ValidationError("Valid email is required");
    }

    if (!/^\d{6}$/.test(otp)) {
      throw new ValidationError("Valid 6-digit OTP is required");
    }

    const otpDoc = await getLatestPendingOtp(email, "signup");

    if (!otpDoc) {
      const existingBrand = await findBrandByEmail(email);
      if (existingBrand) {
        throw new ConflictError("Email already registered. Please login.");
      }
      throw new ValidationError(
        "OTP not requested or expired. Please request a new OTP."
      );
    }

    assertValidOtpDoc(otpDoc, email, otp);

    const payload = otpDoc.signupPayload || {};
    if (!payload.brandName || !payload.industry || !payload.passwordHash) {
      throw new ValidationError(
        "Signup details missing. Please request OTP again."
      );
    }

    const existingBrand = await findBrandByEmail(email);
    if (existingBrand) {
      await clearAllOtpDocs(email, "signup");
      throw new ConflictError("Email already registered. Please login.");
    }

    const freePlan = await SubscriptionPlan.findOne({
      role: "Brand",
      name: "free",
      status: "active",
    });

    if (!freePlan) {
      throw new InternalError("Free brand plan not found");
    }

    const brand = await BrandModel.create({
      email,
      brandName: safeTrim(payload.brandName),
      name: safeTrim(payload.name) || safeTrim(payload.brandName),
      companySize: safeTrim(payload.companySize),
      industry: safeTrim(payload.industry),
      password: payload.passwordHash,
      subscription: buildSubscriptionFromPlan(freePlan),
    });

    await markOtpUsed(otpDoc, { userId: brand._id });
    await clearAllOtpDocs(email, "signup");

    const token = signJwt({
      brandId: String(brand._id),
      role: "brand",
      email: brand.email,
    });

    return ApiResponse.sendOk(
      res,
      HttpStatus.CREATED,
      {
        message: "Brand signup successful",
        brandId: String(brand._id),
        token,
      },
      requestId
    );
  } catch (err) {
    return handleControllerError(next, err, "verifyOtpSignUp");
  }
}

async function saveBrandOnboarding(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const user = req.user;

    if (!user?.brandId) throw new ValidationError("Invalid token payload");
    if (user.role !== "brand") throw new ValidationError("Invalid role");

    const {
      page1,
      page2,
      page3,
      ispage1Skip,
      ispage2Skip,
      ispage3Skip,
      proxyEmail,
      profilePic,
      isProfilePicSkip,
    } = req.body || {};

    const hasAny =
      page1 !== undefined ||
      page2 !== undefined ||
      page3 !== undefined ||
      ispage1Skip !== undefined ||
      ispage2Skip !== undefined ||
      ispage3Skip !== undefined ||
      proxyEmail !== undefined ||
      profilePic !== undefined ||
      isProfilePicSkip !== undefined;

    if (!hasAny) throw new ValidationError("Nothing to update");

    const update = {};

    if (page1 !== undefined || ispage1Skip !== undefined) {
      if (ispage1Skip !== undefined && typeof ispage1Skip !== "boolean") {
        throw new ValidationError("ispage1Skip must be boolean");
      }

      if (ispage1Skip === true) {
        update.page1 = [];
        update.ispage1Skip = true;
      } else {
        if (page1 === undefined) {
          throw new ValidationError(
            "page1 is required when ispage1Skip is false"
          );
        }
        if (!isQAArray(page1)) {
          throw new ValidationError(
            "page1 must be an array of { question, answers[] }"
          );
        }
        update.page1 = page1;
        update.ispage1Skip = false;
      }
    }

    if (page2 !== undefined || ispage2Skip !== undefined) {
      if (ispage2Skip !== undefined && typeof ispage2Skip !== "boolean") {
        throw new ValidationError("ispage2Skip must be boolean");
      }

      if (ispage2Skip === true) {
        update.page2 = [];
        update.ispage2Skip = true;
      } else {
        if (page2 === undefined) {
          throw new ValidationError(
            "page2 is required when ispage2Skip is false"
          );
        }
        if (!isQAArray(page2)) {
          throw new ValidationError(
            "page2 must be an array of { question, answers[] }"
          );
        }
        update.page2 = page2;
        update.ispage2Skip = false;
      }
    }

    if (page3 !== undefined || ispage3Skip !== undefined) {
      if (ispage3Skip !== undefined && typeof ispage3Skip !== "boolean") {
        throw new ValidationError("ispage3Skip must be boolean");
      }

      if (ispage3Skip === true) {
        update.page3 = [];
        update.ispage3Skip = true;
      } else {
        if (page3 === undefined) {
          throw new ValidationError(
            "page3 is required when ispage3Skip is false"
          );
        }
        if (!isQAArray(page3)) {
          throw new ValidationError(
            "page3 must be an array of { question, answers[] }"
          );
        }
        update.page3 = page3;
        update.ispage3Skip = false;
      }
    }

    if (proxyEmail !== undefined) {
      if (typeof proxyEmail !== "string") {
        throw new ValidationError("proxyEmail must be a string");
      }

      const cleanedProxyEmail = normalizeEmail(proxyEmail);
      if (cleanedProxyEmail && !isValidEmail(cleanedProxyEmail)) {
        throw new ValidationError("proxyEmail must be a valid email");
      }

      update.proxyEmail = cleanedProxyEmail;
    }

    if (profilePic !== undefined) {
      if (typeof profilePic !== "string" || !profilePic.trim()) {
        throw new ValidationError("profilePic must be a non-empty string");
      }

      update.profilePic = profilePic.trim();
      update.isProfilePicSkip = false;
    }

    if (isProfilePicSkip !== undefined) {
      if (typeof isProfilePicSkip !== "boolean") {
        throw new ValidationError("isProfilePicSkip must be boolean");
      }

      if (isProfilePicSkip === true) {
        update.profilePic = "";
        update.isProfilePicSkip = true;
      } else {
        update.isProfilePicSkip = false;
      }
    }

    const brand = await BrandModel.findByIdAndUpdate(user.brandId, update, {
      new: true,
      runValidators: true,
    }).exec();

    if (!brand) throw new NotFoundError("Brand not found");

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand onboarding saved successfully",
        brandId: String(brand._id),
      },
      requestId
    );
  } catch (err) {
    return handleControllerError(next, err, "saveBrandOnboarding");
  }
}

async function signInBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !isValidEmail(email)) {
      throw new ValidationError("Valid email is required");
    }

    if (!password.trim()) {
      throw new ValidationError("Valid password is required");
    }

    await enforceSigninLimit(email);

    const brand = await findBrandByEmail(email, true);

    if (!brand) {
      throw new NotFoundError("Email does not exist. Please sign up.");
    }

    if (!brand.password) {
      throw new ValidationError("Password not set. Please use forgot password.");
    }

    const ok = await brand.comparePassword(password);

    if (!ok) {
      await recordFailedSignin(email);
      throw new ValidationError("Incorrect password");
    }

    await resetSigninLimit(email);

    const token = signJwt({
      brandId: String(brand._id),
      role: "brand",
      email: brand.email,
    });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Brand sign in successful",
        brandId: String(brand._id),
        token,
      },
      requestId
    );
  } catch (err) {
    return handleControllerError(next, err, "signInBrand");
  }
}

async function sendOtpForgotBrand(req, res, next) {
  const requestId = req.requestId || "";
  let otpDoc = null;

  try {
    const email = normalizeEmail(req.body?.email);

    if (!email || !isValidEmail(email)) {
      throw new ValidationError("Valid email is required");
    }

    const brand = await findBrandByEmail(email);

    if (!brand) {
      throw new NotFoundError("Brand account not found");
    }

    await enforceOtpLimitByKey(email, "forgot_limit");
    await clearPendingOtpDocs(email, "reset_password");

    const otpPlain = genOtp();

    otpDoc = await createOtpDoc({
      email,
      purpose: "reset_password",
      otpPlain,
      userId: brand._id,
    });

    const { subject, text, html } = resetOtpEmailTemplate({
      otp: otpPlain,
      role: "Brand",
      expiryMinutes: OTP_TTL_MIN,
      purpose: "reset_password",
    });

    await sendEmail({ to: email, subject, text, html });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "OTP sent for password reset",
        email,
      },
      requestId
    );
  } catch (err) {
    if (otpDoc?._id) {
      try {
        await VerifyOtpModel.deleteOne({ _id: otpDoc._id }).exec();
      } catch (cleanupErr) {
        console.error("[sendOtpForgotBrand.cleanup]", {
          name: cleanupErr?.name,
          message: cleanupErr?.message,
        });
      }
    }

    return handleControllerError(next, err, "sendOtpForgotBrand");
  }
}

async function verifyOtpForgotBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || "").trim();

    if (!email || !isValidEmail(email)) {
      throw new ValidationError("Valid email is required");
    }

    if (!/^\d{6}$/.test(otp)) {
      throw new ValidationError("Valid 6-digit OTP is required");
    }

    const brand = await findBrandByEmail(email);
    if (!brand) {
      throw new NotFoundError("Brand account not found");
    }

    const otpDoc = await getLatestPendingOtp(email, "reset_password");
    assertValidOtpDoc(otpDoc, email, otp);

    await markOtpUsed(otpDoc, {
      userId: brand._id,
      extendExpiryMs: RESET_TTL_MS,
    });

    const resetToken = signResetJwt({
      tokenType: "pwd_reset",
      role: "brand",
      brandId: String(brand._id),
      email: brand.email,
      resetId: String(otpDoc._id),
    });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "OTP verified",
        resetToken,
      },
      requestId
    );
  } catch (err) {
    return handleControllerError(next, err, "verifyOtpForgotBrand");
  }
}

async function updatePasswordBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const token = getBearerToken(req);
    const secret = process.env.JWT_SECRET;

    if (!secret) throw new InternalError("JWT_SECRET is missing in env");

    const decoded = jwt.verify(token, secret);

    if (
      decoded?.tokenType !== "pwd_reset" ||
      decoded?.role !== "brand" ||
      !decoded?.brandId ||
      !decoded?.resetId ||
      !decoded?.email
    ) {
      throw new UnauthorizedError("Invalid reset token");
    }

    const newPassword = String(req.body?.newPassword || "");

    if (!newPassword.trim()) {
      throw new ValidationError("newPassword is required");
    }

    if (!isPasswordLenOk(newPassword)) {
      throw new ValidationError("Password must be 8 to 16 characters.");
    }

    const otpDoc = await VerifyOtpModel.findOne({
      _id: decoded.resetId,
      email: normalizeEmail(decoded.email),
      role: "brand",
      status: 1,
      docType: "otp",
      purpose: "reset_password",
    }).exec();

    if (!otpDoc) {
      throw new ValidationError("Invalid or expired reset request");
    }

    const verifiedAt = new Date(otpDoc.updatedAt || otpDoc.createdAt).getTime();
    if (Date.now() - verifiedAt > RESET_TTL_MS) {
      throw new ValidationError("Reset session expired. Verify OTP again.");
    }

    const brand = await BrandModel.findById(decoded.brandId)
      .select("+password")
      .exec();

    if (!brand) {
      throw new NotFoundError("Brand not found");
    }

    const samePassword = await brand.comparePassword(newPassword);
    if (samePassword) {
      throw new ValidationError(
        "New password cannot be the same as your last password"
      );
    }

    brand.password = newPassword;
    await brand.save();

    await VerifyOtpModel.deleteMany({
      email: normalizeEmail(decoded.email),
      role: "brand",
      docType: "otp",
      purpose: "reset_password",
    }).exec();

    await resetSigninLimit(decoded.email);

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      { message: "Password updated successfully" },
      requestId
    );
  } catch (err) {
    return handleControllerError(next, err, "updatePasswordBrand");
  }
}

async function getBrandById(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const id = req.query.id || req.query.brandId || req.params.id;

    if (!id) {
      throw new ValidationError("Query parameter id or brandId is required.");
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ValidationError("Invalid brand id.");
    }

    const brand = await BrandModel.findById(id).lean().exec();

    if (!brand) {
      throw new NotFoundError("Brand not found.");
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        ...brand,
        brandId: String(brand._id),
      },
      requestId
    );
  } catch (err) {
    return handleControllerError(next, err, "getBrandById");
  }
}

module.exports = {
  sendSignupOtp,
  verifyOtpSignUp,
  saveBrandOnboarding,
  signInBrand,
  sendOtpForgotBrand,
  verifyOtpForgotBrand,
  updatePasswordBrand,
  getBrandById,
};