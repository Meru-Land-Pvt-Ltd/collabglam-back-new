// src/core/middleware/helmetMiddleware.js
const helmet = require("helmet");

function helmetMiddleware() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
  });
}

module.exports = { helmetMiddleware };