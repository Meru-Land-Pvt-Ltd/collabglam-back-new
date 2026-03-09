// src/core/logger/logger.js
const pino = require("pino");
const { env } = require("../../config");

const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ["req.headers.authorization", "*.password", "*.token"],
    remove: true,
  },
});

module.exports = { logger };