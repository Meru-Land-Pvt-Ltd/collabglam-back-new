// src/core/http/ApiResponse.js
const { humanizeErrorMessage } = require("./humanizeErrorMessage");

class ApiResponse {
  static ok(data, requestId, meta) {
    return { success: true, data, meta, requestId };
  }

  static fail(code, message, requestId, details) {
    return { success: false, error: { code, message, details }, requestId };
  }

  static sendOk(res, status, data, requestId, meta) {
    return res.status(status).json(ApiResponse.ok(data, requestId, meta));
  }

  static sendFail(res, status, code, message, requestId, details) {
    const finalMessage = humanizeErrorMessage(message);
    return res.status(status).json(ApiResponse.fail(code, finalMessage, requestId, details));
  }
}

module.exports = { ApiResponse };