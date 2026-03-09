// controllers/brandController.js  (NEW MODEL ONLY)
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// ---- tolerant imports (works if module.exports = Model OR exports.BrandModel = ...) ----
const BrandModelImport = require("../models/brand");
const BrandModel = BrandModelImport.BrandModel || BrandModelImport;

const VerifyOtpModelImport = require("../models/verifyOtp");
const VerifyOtpModel = VerifyOtpModelImport.VerifyOtpModel || VerifyOtpModelImport;

const OtpTemplateImport = require("../template/otpTemplate");
const buildOtpEmailTemplate = OtpTemplateImport.buildOtpEmailTemplate || OtpTemplateImport;

const ResetOtpTemplateImport = require("../template/resetOtp");
const resetOtpEmailTemplate = ResetOtpTemplateImport.resetOtpEmailTemplate || ResetOtpTemplateImport;

const EmailServiceImport = require("../services/emailService");
const sendEmail = EmailServiceImport.sendEmail || EmailServiceImport;

const ApiResponseImport = require("../core/http/ApiResponse");
const ApiResponse = ApiResponseImport.ApiResponse || ApiResponseImport;

const HttpStatusImport = require("../core/http/HttpStatus");
const HttpStatus = HttpStatusImport.HttpStatus || HttpStatusImport;

const ApiErrorImport = require("../core/http/ApiError");
const ApiError = ApiErrorImport.ApiError || ApiErrorImport;
const ValidationError = ApiErrorImport.ValidationError;
const ConflictError = ApiErrorImport.ConflictError;
const InternalError = ApiErrorImport.InternalError;
const NotFoundError = ApiErrorImport.NotFoundError;

// Prefer your real ErrorCodes if available; else fallback
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
  };
}

// -------------------- config --------------------
const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
const OTP_TTL_MIN = Number(process.env.OTP_TTL_MINUTES || 3);
const RESET_TTL_MIN = Number(process.env.RESET_PASSWORD_TTL_MINUTES || 15);

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));

const hashOtp = (email, otp) => {
  const secret = process.env.OTP_SECRET || "dev-secret";
  return crypto.createHash("sha256").update(`${email}:${otp}:${secret}`).digest("hex");
};

const isPasswordLenOk = (p) => {
  const len = String(p ?? "").trim().length;
  return len >= 8 && len <= 16;
};

async function hashPassword(password) {
  return bcrypt.hash(String(password), SALT_ROUNDS);
}

function signJwt(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new InternalError("JWT_SECRET is missing in env");
  return jwt.sign(payload, secret, { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" });
}

function signResetJwt(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new InternalError("JWT_SECRET is missing in env");
  return jwt.sign(payload, secret, { expiresIn: `${RESET_TTL_MIN}m` });
}

function getBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new ApiError({
      status: HttpStatus.UNAUTHORIZED,
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      message: "Missing or invalid Authorization header",
    });
  }
  return auth.slice("Bearer ".length).trim();
}

// ✅ expected onboarding page format: [{ question: string, answers: string[] }]
function isQAArray(v) {
  if (!Array.isArray(v)) return false;
  return v.every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const q = item.question;
    const a = item.answers;
    if (typeof q !== "string" || q.trim().length === 0) return false;
    if (!Array.isArray(a) || a.length === 0) return false;
    if (!a.every((x) => typeof x === "string" && x.trim().length > 0)) return false;
    return true;
  });
}

// -------------------- mongoose error -> ApiError --------------------
function rethrowAsApiError(err) {
  // Duplicate key
  if (err && err.code === 11000) {
    throw new ConflictError("Email already registered. Please Login.", { keyValue: err.keyValue });
  }

  // Mongoose validation error
  if (err && err.name === "ValidationError") {
    const fields = err.errors ? Object.keys(err.errors) : [];
    throw new ValidationError(err.message, { fields });
  }

  // Cast error etc.
  if (err && err.name === "CastError") {
    throw new ValidationError("Invalid input", { field: err.path });
  }

  throw err;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
// OTP LIMITER (Signup + Forgot) stored in VerifyOtp collection
//////////////////////////////////////////////////////////////////////////////////////////////////////
const OTP_TOTAL = 6;
const OTP_BATCH_LIMIT = 3;
const OTP_COOLDOWN_MIN = 15;
const OTP_RESET_HOURS = 24;

async function enforceOtpLimitByKey(email, key) {
  const nowMs = Date.now();

  const limitDoc = await VerifyOtpModel.findOneAndUpdate(
    { email, role: "brand", key },
    {
      $setOnInsert: {
        email,
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

  if (limitDoc.signupOtpResetAt && nowMs >= new Date(limitDoc.signupOtpResetAt).getTime()) {
    limitDoc.signupOtpSend = OTP_TOTAL;
    limitDoc.signupOtpBatchCount = 0;
    limitDoc.signupOtpCooldownUntil = null;
    limitDoc.signupOtpResetAt = null;
    await limitDoc.save();
  }

  if ((limitDoc.signupOtpSend ?? OTP_TOTAL) <= 0) {
    if (!limitDoc.signupOtpResetAt) {
      limitDoc.signupOtpResetAt = new Date(nowMs + OTP_RESET_HOURS * 60 * 60 * 1000);
      await limitDoc.save();
    }
    throw new ApiError({
      status: HttpStatus.TOO_MANY_REQUESTS || 429,
      code: ErrorCodes.OTP_DAILY_LIMIT,
      message: "try after 24 hour",
    });
  }

  if (limitDoc.signupOtpCooldownUntil && nowMs < new Date(limitDoc.signupOtpCooldownUntil).getTime()) {
    throw new ApiError({
      status: HttpStatus.TOO_MANY_REQUESTS || 429,
      code: ErrorCodes.OTP_RATE_LIMIT,
      message: "Try after some time",
    });
  }

  limitDoc.signupOtpSend = (limitDoc.signupOtpSend ?? OTP_TOTAL) - 1;
  limitDoc.signupOtpBatchCount = (limitDoc.signupOtpBatchCount ?? 0) + 1;

  if (limitDoc.signupOtpBatchCount >= OTP_BATCH_LIMIT) {
    limitDoc.signupOtpCooldownUntil = new Date(nowMs + OTP_COOLDOWN_MIN * 60 * 1000);
    limitDoc.signupOtpBatchCount = 0;
  }

  if (limitDoc.signupOtpSend <= 0) {
    limitDoc.signupOtpSend = 0;
    limitDoc.signupOtpResetAt = new Date(nowMs + OTP_RESET_HOURS * 60 * 60 * 1000);
  }

  await limitDoc.save();
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
// SIGNIN LIMITER stored in VerifyOtp collection
//////////////////////////////////////////////////////////////////////////////////////////////////////
const SIGNIN_TOTAL = 9;
const SIGNIN_BATCH = 3;
const SIGNIN_LOCK_1_MIN = 1;
const SIGNIN_LOCK_15_MIN = 15;
const SIGNIN_LOCK_24_HOURS = 24;

async function getSigninLimitDoc(email) {
  return VerifyOtpModel.findOneAndUpdate(
    { email, role: "brand", docType: "limit", key: "signin_limit" },
    {
      $setOnInsert: {
        email,
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

function msToWaitString(ms) {
  const sec = Math.ceil(ms / 1000);
  if (sec <= 60) return `${sec} seconds`;
  const min = Math.ceil(sec / 60);
  if (min <= 60) return `${min} minutes`;
  const hr = Math.ceil(min / 60);
  return `${hr} hours`;
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

  if (doc.signinCooldownUntil && nowMs < new Date(doc.signinCooldownUntil).getTime()) {
    const waitMs = new Date(doc.signinCooldownUntil).getTime() - nowMs;
    throw new ApiError({
      status: HttpStatus.TOO_MANY_REQUESTS || 429,
      code: ErrorCodes.SIGNIN_RATE_LIMIT,
      message: `Too many failed login attempts. Try again in ${msToWaitString(waitMs)}.`,
    });
  }

  if ((doc.signinFailedCount ?? 0) >= SIGNIN_TOTAL) {
    if (!doc.signinResetAt) {
      doc.signinResetAt = new Date(nowMs + SIGNIN_LOCK_24_HOURS * 60 * 60 * 1000);
      await doc.save();
    }
    throw new ApiError({
      status: HttpStatus.TOO_MANY_REQUESTS || 429,
      code: ErrorCodes.SIGNIN_DAILY_LIMIT,
      message: "Too many failed login attempts. Try again after 24 hours.",
    });
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
      doc.signinCooldownUntil = new Date(nowMs + SIGNIN_LOCK_15_MIN * 60 * 1000);
    } else {
      doc.signinCooldownUntil = new Date(nowMs + SIGNIN_LOCK_24_HOURS * 60 * 60 * 1000);
      doc.signinResetAt = doc.signinCooldownUntil;
      doc.signinFailedCount = SIGNIN_TOTAL;
    }
  }

  await doc.save();

  if (doc.signinCooldownUntil && nowMs < new Date(doc.signinCooldownUntil).getTime()) {
    const waitMs = new Date(doc.signinCooldownUntil).getTime() - nowMs;
    throw new ApiError({
      status: HttpStatus.TOO_MANY_REQUESTS || 429,
      code: (doc.signinFailedCount ?? 0) >= SIGNIN_TOTAL ? ErrorCodes.SIGNIN_DAILY_LIMIT : ErrorCodes.SIGNIN_RATE_LIMIT,
      message:
        (doc.signinFailedCount ?? 0) >= SIGNIN_TOTAL
          ? "Too many failed login attempts. Try again after 24 hours."
          : `Too many failed login attempts. Try again in ${msToWaitString(waitMs)}.`,
    });
  }
}

async function resetSigninLimit(email) {
  await VerifyOtpModel.updateOne(
    { email, role: "brand", docType: "limit", key: "signin_limit" },
    { $set: { signinFailedCount: 0, signinCooldownUntil: null, signinResetAt: null } }
  ).exec();
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
// CONTROLLERS (NEW MODEL ONLY)
//////////////////////////////////////////////////////////////////////////////////////////////////////

// 1) SEND OTP SIGNUP
async function sendSignupOtp(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const { brandName, name, email, companySize, industry, password } = req.body || {};

    if (!brandName || !String(brandName).trim()) throw new ValidationError("Brand Name is required");
    if (!email || !isValidEmail(email)) throw new ValidationError("Valid email is required");
    if (!industry || !String(industry).trim()) throw new ValidationError("Industry is required");
    if (!password || !String(password).trim()) throw new ValidationError("Password is required");
    if (!isPasswordLenOk(password)) throw new ValidationError("Password must be 8–16 characters.");

    const normalizedEmail = normalizeEmail(email);

    const brandExists = await BrandModel.exists({ email: normalizedEmail });
    if (brandExists) throw new ConflictError("Email already registered. Please Login.");

    await enforceOtpLimitByKey(normalizedEmail, "signup_limit");

    const otpPlain = genOtp();
    const otpHashed = hashOtp(normalizedEmail, otpPlain);

    const cleanCompanySize =
      typeof companySize === "string" && companySize.trim().length > 0 ? companySize.trim() : "";

    await VerifyOtpModel.create({
      email: normalizedEmail,
      role: "brand",
      otp: otpHashed,
      status: 0,
      userId: null,
      docType: "otp",
      purpose: "signup",
      signupPayload: {
        brandName: String(brandName).trim(),
        name: String(name).trim(),
        companySize: cleanCompanySize,
        industry: String(industry).trim(),
        password: await hashPassword(String(password)),
      },
    });

    const { subject, text, html } = buildOtpEmailTemplate({
      otp: otpPlain,
      role: "Brand",
      expiryMinutes: OTP_TTL_MIN,
      purpose: "signup",
    });

    await sendEmail({ to: normalizedEmail, subject, text, html });

    return ApiResponse.sendOk(res, HttpStatus.OK, { message: "OTP sent successfully", email: normalizedEmail }, requestId);
  } catch (err) {
    try { rethrowAsApiError(err); } catch (e) { err = e; }
    if (err instanceof ApiError) return next(err);
    return next(new InternalError("Internal server error", undefined, err));
  }
}

// 2) VERIFY OTP + CREATE BRAND
async function verifyOtpSignUp(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const { email, otp } = req.body || {};

    if (!email || !isValidEmail(email)) throw new ValidationError("Valid email is required");
    if (!otp || !/^\d{6}$/.test(String(otp))) throw new ValidationError("Valid 6-digit OTP is required");

    const normalizedEmail = normalizeEmail(email);

    const existing = await BrandModel.exists({ email: normalizedEmail });
    if (existing) throw new ConflictError("Email already registered. Please Login.");

    const otpDoc = await VerifyOtpModel.findOne({
      email: normalizedEmail,
      role: "brand",
      status: 0,
      docType: "otp",
      purpose: "signup",
    })
      .sort({ createdAt: -1 })
      .exec();

    if (!otpDoc) throw new ValidationError("OTP not requested");

    const ageMs = Date.now() - new Date(otpDoc.createdAt).getTime();
    if (ageMs > OTP_TTL_MIN * 60 * 1000) throw new ValidationError("OTP expired. Please resend otp.");

    const incomingHash = hashOtp(normalizedEmail, String(otp));
    if (incomingHash !== otpDoc.otp) throw new ValidationError("Invalid OTP");

    const payload = otpDoc.signupPayload;
    if (!payload?.brandName || !payload?.industry || !payload?.password) {
      throw new ValidationError("Signup details missing. Please request OTP again.");
    }

    const safeName = String(payload.name || "").trim() || String(payload.brandName).trim();

    const brand = await BrandModel.create({
      email: normalizedEmail,
      brandName: payload.brandName,
      name: safeName,
      companySize: payload.companySize || undefined,
      industry: payload.industry,
      password: payload.password, // already hashed
    });

    otpDoc.status = 1;
    otpDoc.userId = brand._id;
    await otpDoc.save();

    const token = signJwt({ brandId: brand._id.toString(), role: "brand", email: brand.email });

    return ApiResponse.sendOk(
      res,
      HttpStatus.CREATED,
      { message: "Brand signup successful", brandId: brand._id.toString(), token },
      requestId
    );
  } catch (err) {
    try { rethrowAsApiError(err); } catch (e) { err = e; }
    if (err instanceof ApiError) return next(err);
    return next(new InternalError("Internal server error", undefined, err));
  }
}

// 3) SAVE ONBOARDING
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
      if (ispage1Skip !== undefined && typeof ispage1Skip !== "boolean") throw new ValidationError("ispage1Skip must be boolean");
      if (ispage1Skip === true) {
        update.page1 = [];
        update.ispage1Skip = true;
      } else {
        if (!page1) throw new ValidationError("page1 is required when ispage1Skip is false");
        if (!isQAArray(page1)) throw new ValidationError("page1 must be array of { question, answers[] }");
        update.page1 = page1;
        update.ispage1Skip = false;
      }
    }

    if (page2 !== undefined || ispage2Skip !== undefined) {
      if (ispage2Skip !== undefined && typeof ispage2Skip !== "boolean") throw new ValidationError("ispage2Skip must be boolean");
      if (ispage2Skip === true) {
        update.page2 = [];
        update.ispage2Skip = true;
      } else {
        if (!page2) throw new ValidationError("page2 is required when ispage2Skip is false");
        if (!isQAArray(page2)) throw new ValidationError("page2 must be array of { question, answers[] }");
        update.page2 = page2;
        update.ispage2Skip = false;
      }
    }

    if (page3 !== undefined || ispage3Skip !== undefined) {
      if (ispage3Skip !== undefined && typeof ispage3Skip !== "boolean") throw new ValidationError("ispage3Skip must be boolean");
      if (ispage3Skip === true) {
        update.page3 = [];
        update.ispage3Skip = true;
      } else {
        if (!page3) throw new ValidationError("page3 is required when ispage3Skip is false");
        if (!isQAArray(page3)) throw new ValidationError("page3 must be array of { question, answers[] }");
        update.page3 = page3;
        update.ispage3Skip = false;
      }
    }

    if (proxyEmail !== undefined) {
      if (typeof proxyEmail !== "string" || proxyEmail.trim().length === 0) throw new ValidationError("proxyEmail must be a string");
      update.proxyEmail = proxyEmail.trim();
    }

    if (profilePic !== undefined) {
      if (typeof profilePic !== "string" || profilePic.trim().length === 0) throw new ValidationError("profilePic must be a string");
      update.profilePic = profilePic.trim();
      update.isProfilePicSkip = false;
    }

    if (isProfilePicSkip !== undefined) {
      if (typeof isProfilePicSkip !== "boolean") throw new ValidationError("isProfilePicSkip must be boolean");
      if (isProfilePicSkip === true) {
        update.profilePic = "";
        update.isProfilePicSkip = true;
      } else {
        update.isProfilePicSkip = false;
      }
    }

    const brand = await BrandModel.findByIdAndUpdate(user.brandId, update, { new: true }).exec();
    if (!brand) throw new NotFoundError("Brand not found");

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      { message: "Brand onboarding saved successfully", brandId: brand._id.toString() },
      requestId
    );
  } catch (err) {
    try { rethrowAsApiError(err); } catch (e) { err = e; }
    if (err instanceof ApiError) return next(err);
    return next(new InternalError("Internal server error", undefined, err));
  }
}

// 4) SIGN IN
async function signInBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const { email, password } = req.body || {};

    if (!email || !isValidEmail(email)) throw new ValidationError("Valid email is required");
    if (!password) throw new ValidationError("Valid password is required");

    const normalizedEmail = normalizeEmail(email);

    const brand = await BrandModel.findOne({ email: normalizedEmail }).exec();
    if (!brand) throw new NotFoundError("Email does not exist. Please Sign Up");
    if (!brand.password) throw new ValidationError("Password not set. Please use Forgot Password");

    await enforceSigninLimit(normalizedEmail);

    const ok = await bcrypt.compare(String(password), String(brand.password));
    if (!ok) {
      await recordFailedSignin(normalizedEmail);
      throw new ValidationError("Incorrect Password");
    }

    await resetSigninLimit(normalizedEmail);

    const token = signJwt({ brandId: brand._id.toString(), role: "brand", email: brand.email });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      { message: "Brand sign in successful", brandId: brand._id.toString(), token },
      requestId
    );
  } catch (err) {
    try { rethrowAsApiError(err); } catch (e) { err = e; }
    if (err instanceof ApiError) return next(err);
    return next(new InternalError("Internal server error", undefined, err));
  }
}

// 5) FORGOT 1: SEND OTP
async function sendOtpForgotBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const { email } = req.body || {};
    if (!email || !isValidEmail(email)) throw new ValidationError("Valid email is required");

    const normalizedEmail = normalizeEmail(email);

    const brand = await BrandModel.findOne({ email: normalizedEmail }).exec();
    if (!brand) throw new NotFoundError("Brand account not found");

    await enforceOtpLimitByKey(normalizedEmail, "forgot_limit");

    const otpPlain = genOtp();
    const otpHashed = hashOtp(normalizedEmail, otpPlain);

    await VerifyOtpModel.create({
      email: normalizedEmail,
      role: "brand",
      otp: otpHashed,
      status: 0,
      userId: brand._id,
      docType: "otp",
      purpose: "reset_password",
    });

    const { subject, text, html } = resetOtpEmailTemplate({
      otp: otpPlain,
      role: "Brand",
      expiryMinutes: OTP_TTL_MIN,
      purpose: "reset_password",
    });

    await sendEmail({ to: normalizedEmail, subject, text, html });

    return ApiResponse.sendOk(res, HttpStatus.OK, { message: "OTP sent for password reset", email: normalizedEmail }, requestId);
  } catch (err) {
    try { rethrowAsApiError(err); } catch (e) { err = e; }
    if (err instanceof ApiError) return next(err);
    return next(new InternalError("Internal server error", undefined, err));
  }
}

// 6) FORGOT 2: VERIFY OTP -> reset token
async function verifyOtpForgotBrand(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const { email, otp } = req.body || {};

    if (!email || !isValidEmail(email)) throw new ValidationError("Valid email is required");
    if (!otp || !/^\d{6}$/.test(String(otp))) throw new ValidationError("Valid 6-digit OTP is required");

    const normalizedEmail = normalizeEmail(email);

    const brand = await BrandModel.findOne({ email: normalizedEmail }).exec();
    if (!brand) throw new NotFoundError("Brand account not found");

    const otpDoc = await VerifyOtpModel.findOne({
      email: normalizedEmail,
      role: "brand",
      status: 0,
      docType: "otp",
      purpose: "reset_password",
    })
      .sort({ createdAt: -1 })
      .exec();

    if (!otpDoc) throw new ValidationError("OTP not requested");

    const ageMs = Date.now() - new Date(otpDoc.createdAt).getTime();
    if (ageMs > OTP_TTL_MIN * 60 * 1000) throw new ValidationError("OTP expired. Please request again.");

    const incomingHash = hashOtp(normalizedEmail, String(otp));
    if (incomingHash !== otpDoc.otp) throw new ValidationError("Invalid OTP");

    otpDoc.status = 1;
    otpDoc.userId = brand._id;
    await otpDoc.save();

    const resetToken = signResetJwt({
      tokenType: "pwd_reset",
      role: "brand",
      brandId: brand._id.toString(),
      email: brand.email,
      resetId: otpDoc._id.toString(),
    });

    return ApiResponse.sendOk(res, HttpStatus.OK, { message: "OTP verified", resetToken }, requestId);
  } catch (err) {
    try { rethrowAsApiError(err); } catch (e) { err = e; }
    if (err instanceof ApiError) return next(err);
    return next(new InternalError("Internal server error", undefined, err));
  }
}

// 7) FORGOT 3: UPDATE PASSWORD (Bearer reset token)
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
      throw new ApiError({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCodes.AUTH_INVALID_TOKEN,
        message: "Invalid reset token",
      });
    }

    const { newPassword } = req.body || {};
    if (!newPassword) throw new ValidationError("newPassword is required");
    if (!isPasswordLenOk(newPassword)) throw new ValidationError("Password must be 8–16 characters.");

    const otpDoc = await VerifyOtpModel.findOne({
      _id: decoded.resetId,
      email: normalizeEmail(decoded.email),
      role: "brand",
      status: 1,
      docType: "otp",
      purpose: "reset_password",
    }).exec();

    if (!otpDoc) throw new ValidationError("Invalid or expired reset request");

    const verifiedAt = new Date(otpDoc.updatedAt ?? otpDoc.createdAt).getTime();
    if (Date.now() - verifiedAt > RESET_TTL_MIN * 60 * 1000) {
      throw new ValidationError("Reset session expired. Verify OTP again.");
    }

    const brandExisting = await BrandModel.findById(decoded.brandId).exec();
    if (!brandExisting) throw new NotFoundError("Brand not found");

    if (brandExisting.password) {
      const same = await bcrypt.compare(String(newPassword), String(brandExisting.password));
      if (same) throw new ValidationError("New password cannot be the same as your last password");
    }

    brandExisting.password = await hashPassword(String(newPassword));
    await brandExisting.save();

    await VerifyOtpModel.deleteOne({ _id: otpDoc._id }).exec();
    await resetSigninLimit(normalizeEmail(decoded.email));

    return ApiResponse.sendOk(res, HttpStatus.OK, { message: "Password updated successfully" }, requestId);
  } catch (err) {
    try { rethrowAsApiError(err); } catch (e) { err = e; }
    if (err instanceof ApiError) return next(err);
    return next(new InternalError("Internal server error", undefined, err));
  }
}

async function getBrandById(req, res, next) {
  const requestId = req.requestId || "";

  try {
    const id = req.query.id || req.query.brandId || req.params.id;

    if (!id) {
      return res.status(400).json({
        message: "Query parameter id (or brandId) is required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid brand id." });
    }

    const brandDoc = await BrandModel.findById(id)
      .select("-password -__v")
      .lean()
      .exec();

    if (!brandDoc) {
      return res.status(404).json({ message: "Brand not found." });
    }

    return res.status(200).json({
      ...brandDoc,
      brandId: String(brandDoc._id),
    });
  } catch (error) {
    console.error("Error in getBrandById:", error);
    return res.status(500).json({
      message: "Internal server error while fetching brand.",
    });
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