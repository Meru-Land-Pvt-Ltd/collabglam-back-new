// src/core/security/cors.js
const cors = require("cors");
const { env } = require("../../config");

const raw = String(env.CORS_ORIGINS || "").trim();
const allowAll = raw === "*" || raw.length === 0;

const allowlist = allowAll
    ? []
    : raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

function corsMiddleware() {
    return cors({
        origin(origin, cb) {
            if (!origin) return cb(null, true);

            // allow all: reflect origin (credentials-safe)
            if (allowAll) return cb(null, origin);

            // allow only allowlist
            if (allowlist.includes(origin)) return cb(null, origin);

            // block without throwing (prevents 500)
            return cb(null, false);
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
        exposedHeaders: ["X-Request-Id"],
    });
}

module.exports = { corsMiddleware };