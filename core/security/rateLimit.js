// src/core/middleware/rateLimitMiddleware.js
const rateLimit = require("express-rate-limit");
const { env } = require("../../config");
const { RateLimitError } = require("../http/ApiError");

function rateLimitMiddleware() {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new RateLimitError("Too many requests")),
  });
}

module.exports = { rateLimitMiddleware };