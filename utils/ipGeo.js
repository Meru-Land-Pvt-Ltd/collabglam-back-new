// geo.js
const maxmind = require("maxmind");
const net = require("node:net");

let reader = null;

const clean = (v) => (v ?? "").trim();

const normalizeIp = (ip) => {
  const s = clean(ip);
  if (!s) return "";
  // "::ffff:1.2.3.4" -> "1.2.3.4"
  if (s.startsWith("::ffff:")) return s.replace("::ffff:", "");
  return s;
};

const isValidIp = (ip) => net.isIP(ip) !== 0;

const isPrivateIp = (ipRaw) => {
  const ip = normalizeIp(ipRaw);
  if (!ip) return true;

  // localhost
  if (ip === "127.0.0.1" || ip === "::1") return true;

  // IPv6 local ranges
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) return true;

  // IPv4 private ranges
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;

  // 172.16.0.0 – 172.31.255.255
  const m = ip.match(/^172\.(\d{1,2})\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }

  // CGNAT 100.64.0.0 – 100.127.255.255
  const cgn = ip.match(/^100\.(\d{1,3})\./);
  if (cgn) {
    const second = Number(cgn[1]);
    if (second >= 64 && second <= 127) return true;
  }

  return false;
};

const getClientIp = (req) => {
  // ✅ Local dev override IP (must be a REAL IP)
  // Postman: x-test-ip: 8.8.8.8
  const testIp = req.headers["x-test-ip"];
  if (typeof testIp === "string") {
    const v = normalizeIp(testIp);
    if (v && isValidIp(v)) return v;
  }

  // ✅ Standard proxy header
  const xf = req.headers["x-forwarded-for"];
  const ipFromXf =
    typeof xf === "string"
      ? xf.split(",")[0].trim()
      : Array.isArray(xf)
        ? (xf[0] || "").trim()
        : "";

  const candidate = normalizeIp(ipFromXf || String(req.ip || ""));

  // ✅ avoid saving garbage as "ip"
  return candidate && isValidIp(candidate) ? candidate : "";
};

const loadMaxmind = async () => {
  if (reader) return reader;

  const dbPath = clean(process.env.MAXMIND_DB_PATH);
  if (!dbPath) return null;

  try {
    reader = await maxmind.open(dbPath);
    return reader;
  } catch {
    return null;
  }
};

const detectGeoFromRequest = async (req) => {
  const ip = getClientIp(req);
  const fallbackTz = clean(process.env.DEFAULT_TZ) || "UTC";

  // ✅ DEV OVERRIDE: Force timezone (best for local testing)
  // Postman: x-test-tz: America/Los_Angeles
  const testTz = req.headers["x-test-tz"];
  if (typeof testTz === "string" && testTz.trim()) {
    return {
      ip: ip || "0.0.0.0",
      timezone: testTz.trim(),
      country: "United States",
      state: "California",
      city: "Los Angeles",
      latitude: 34.0522,
      longitude: -118.2437,
      source: "fallback_no_geo",
    };
  }

  // ✅ normal logic continues
  if (!ip || isPrivateIp(ip)) {
    return {
      ip: ip || "0.0.0.0",
      timezone: fallbackTz,
      country: "",
      state: "",
      city: "",
      source: "fallback_private_ip",
    };
  }

  const mm = await loadMaxmind();
  if (!mm) {
    return {
      ip,
      timezone: fallbackTz,
      country: "",
      state: "",
      city: "",
      source: "fallback_no_mmdb",
    };
  }

  const geo = mm.get(ip);
  if (!geo) {
    return {
      ip,
      timezone: fallbackTz,
      country: "",
      state: "",
      city: "",
      source: "fallback_no_geo",
    };
  }

  const timezone = (geo.location && geo.location.time_zone) || fallbackTz;

  const country =
    (geo.country && geo.country.names && geo.country.names.en) ||
    (geo.registered_country && geo.registered_country.names && geo.registered_country.names.en) ||
    "";

  const state =
    (geo.subdivisions &&
      geo.subdivisions[0] &&
      geo.subdivisions[0].names &&
      geo.subdivisions[0].names.en) ||
    (geo.subdivisions && geo.subdivisions[0] && geo.subdivisions[0].iso_code) ||
    "";

  const city = (geo.city && geo.city.names && geo.city.names.en) || "";

  const latitude =
    geo.location && typeof geo.location.latitude === "number" ? geo.location.latitude : undefined;

  const longitude =
    geo.location && typeof geo.location.longitude === "number" ? geo.location.longitude : undefined;

  return {
    ip,
    timezone,
    country,
    state,
    city,
    latitude,
    longitude,
    source: "maxmind",
  };
};

module.exports = {
  getClientIp,
  detectGeoFromRequest,
};