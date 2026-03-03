// src/core/middleware/sanitizeMiddleware.js
const DANGEROUS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(v) {
  return typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

function sanitize(input) {
  if (Array.isArray(input)) return input.map(sanitize);
  if (!isPlainObject(input)) return input;

  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (DANGEROUS.has(k)) continue;
    if (k.includes("$") || k.includes(".")) continue;
    out[k] = sanitize(v);
  }
  return out;
}

function sanitizeMiddleware() {
  return (req, _res, next) => {
    req.body = sanitize(req.body);
    req.query = sanitize(req.query);
    req.params = sanitize(req.params);
    next();
  };
}

module.exports = { sanitizeMiddleware };