// middleware/brandAuth.js
const jwt = require("jsonwebtoken");

const { ApiError } = require("../core/http/ApiError");
const { HttpStatus } = require("../core/http/HttpStatus");
const { ErrorCodes } = require("../core/http/errorCodes");

function brandAuth(req, _res, next) {
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
      throw new ApiError({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ErrorCodes.INTERNAL_ERROR,
        message: "JWT_SECRET is missing in env",
      });
    }

    const decoded = jwt.verify(token, secret);

    if (!decoded?.brandId || decoded.role !== "brand") {
      throw new ApiError({
        status: HttpStatus.FORBIDDEN,
        code: ErrorCodes.AUTH_FORBIDDEN,
        message: "Forbidden",
      });
    }

    // attach user to req
    req.user = decoded;
    next();
  } catch (err) {
    next(
      err instanceof ApiError
        ? err
        : new ApiError({
          status: HttpStatus.UNAUTHORIZED,
          code: ErrorCodes.AUTH_INVALID_TOKEN,
          message: "Invalid token",
          details: err,
        })
    );
  }
}

module.exports = { brandAuth };