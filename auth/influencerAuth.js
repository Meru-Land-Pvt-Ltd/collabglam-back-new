const jwt = require("jsonwebtoken");

const {
  ApiError,
  InternalError,
  ForbiddenError,
} = require("../core/http/ApiError");
const { HttpStatus } = require("../core/http/HttpStatus");
const { ErrorCodes } = require("../core/http/errorCodes");

function influencerAuth(req, _res, next) {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      throw new ApiError({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCodes.AUTH_INVALID_TOKEN,
        message: "Authorization token missing",
      });
    }

    const token = header.split(" ")[1];

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new InternalError("JWT_SECRET is missing in env");
    }

    const decoded = jwt.verify(token, secret);

    if (!decoded || !decoded.influencerId || decoded.role !== "influencer") {
      throw new ForbiddenError("Forbidden");
    }

    // attach user info to request
    req.user = decoded;

    next();
  } catch (err) {
    if (err instanceof ApiError) return next(err);

    console.error("Error in influencerAuth middleware:", err);

    return next(
      new ApiError({
        status: HttpStatus.UNAUTHORIZED,
        code: ErrorCodes.AUTH_INVALID_TOKEN,
        message: "Invalid token",
        details: err,
      })
    );
  }
}

module.exports = { influencerAuth };