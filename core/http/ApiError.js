const { HttpStatus } = require("./HttpStatus");
const { ErrorCodes } = require("./errorCodes");

class ApiError extends Error {
  /**
   * @param {{
   *  status: number,
   *  code: string,
   *  message: string,
   *  details?: any,
   *  isOperational?: boolean,
   *  cause?: any
   * }} opts
   */
  constructor(opts) {
    super(opts.message);
    this.name = this.constructor.name;

    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details ?? null;
    this.isOperational = opts.isOperational ?? true;
    this.cause = opts.cause;

    Error.captureStackTrace?.(this, this.constructor);
  }
}

class ValidationError extends ApiError {
  constructor(message = "Validation failed", details = null) {
    super({
      status: HttpStatus.BAD_REQUEST,
      code: ErrorCodes.VALIDATION_FAILED,
      message,
      details,
    });
  }
}

class UnauthorizedError extends ApiError {
  constructor(message = "Unauthorized", details = null) {
    super({
      status: HttpStatus.UNAUTHORIZED,
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      message,
      details,
    });
  }
}

class ForbiddenError extends ApiError {
  constructor(message = "Forbidden", details = null) {
    super({
      status: HttpStatus.FORBIDDEN,
      code: ErrorCodes.AUTH_FORBIDDEN,
      message,
      details,
    });
  }
}

class NotFoundError extends ApiError {
  constructor(message = "Not found", details = null) {
    super({
      status: HttpStatus.NOT_FOUND,
      code: ErrorCodes.RESOURCE_NOT_FOUND,
      message,
      details,
    });
  }
}

class ConflictError extends ApiError {
  constructor(message = "Conflict", details = null) {
    super({
      status: HttpStatus.CONFLICT,
      code: ErrorCodes.CONFLICT,
      message,
      details,
    });
  }
}

class RateLimitError extends ApiError {
  constructor(message = "Too many requests", details = null) {
    super({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: ErrorCodes.RATE_LIMITED,
      message,
      details,
    });
  }
}

class InternalError extends ApiError {
  constructor(message = "Internal server error", details = null, cause = null) {
    super({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCodes.INTERNAL_ERROR,
      message,
      details,
      cause,
      isOperational: false,
    });
  }
}

module.exports = {
  ApiError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalError,
};