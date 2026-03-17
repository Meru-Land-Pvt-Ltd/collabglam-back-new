const { Types } = require("mongoose");
const { DateTime } = require("luxon");
const ct = require("countries-and-timezones");

const { ApiResponse } = require("../core/http/ApiResponse");
const { HttpStatus } = require("../core/http/HttpStatus");
const CountryModel = require("../models/country");
const { detectGeoFromRequest } = require("../utils/ipGeo");

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const getRequestId = (req) => req.requestId || req.id || req.headers?.["x-request-id"] || "NA";
const EC = (code) => code;

const normalizeStringArray = (v) => {
  if (Array.isArray(v)) return v.map((x) => clean(String(x))).filter(Boolean);
  const s = clean(v);
  return s ? [s] : [];
};

const normalizeObjectIdArray = (v) => {
  const arr = normalizeStringArray(v);
  return arr.filter((id) => Types.ObjectId.isValid(id));
};

const DEFAULT_TZ_OVERRIDES = {
  US: "America/New_York",
  CA: "America/Toronto",
  RU: "Europe/Moscow",
  AU: "Australia/Sydney",
  BR: "America/Sao_Paulo",
  MX: "America/Mexico_City",
  ID: "Asia/Jakarta",
  ES: "Europe/Madrid",
  PT: "Europe/Lisbon",
  FR: "Europe/Paris",
  GB: "Europe/London",
  CN: "Asia/Shanghai",
  NZ: "Pacific/Auckland",
};

const pickSingleTimezoneForCountry = (countryCode) => {
  const code = (countryCode || "").toUpperCase();
  if (!code) return { tz: null, reason: "fallback" };

  const tzObjs = ct.getTimezonesForCountry(code) || [];
  if (!tzObjs.length) return { tz: null, reason: "fallback" };

  const override = DEFAULT_TZ_OVERRIDES[code];
  if (override && tzObjs.some((t) => t.name === override)) {
    return { tz: override, reason: "override" };
  }

  const primary = tzObjs.filter((t) => {
    const country = ct.getCountryForTimezone(t.name);
    return country && country.id === code;
  });

  const pool = primary.length ? primary : tzObjs;

  return {
    tz: pool[0]?.name || null,
    reason: primary.length ? "primary" : "fallback",
  };
};

const getTimezonesByCountries = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const targetIds = normalizeObjectIdArray(req.body.targetCountryIds);
    const targetCodesRaw = normalizeStringArray(req.body.targetCountryCodes)
      .map((x) => x.toUpperCase())
      .filter(Boolean);

    if (!targetIds.length && !targetCodesRaw.length) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "targetCountryIds or targetCountryCodes is required (multi-select supported)",
        requestId
      );
    }

    if (targetIds.length + targetCodesRaw.length > 50) {
      return ApiResponse.sendFail(
        res,
        HttpStatus.BAD_REQUEST,
        EC("VALIDATION_ERROR"),
        "Too many countries selected (max 50)",
        requestId
      );
    }

    const bodyCurrent = req.body.current || {};
    let currentTimezone = clean(bodyCurrent.timezone);
    let currentCountryCode = clean(bodyCurrent.countryCode).toUpperCase();
    let currentIp = clean(bodyCurrent.ip);

    if (!currentTimezone) {
      const geo = await detectGeoFromRequest(req);
      currentTimezone = clean(geo?.timezone) || "UTC";
      if (!currentIp) currentIp = clean(geo?.ip);
    }

    if (!currentTimezone) currentTimezone = "UTC";

    const nowUtc = DateTime.now().toUTC();
    const nowCurrentTry = DateTime.now().setZone(currentTimezone);
    const nowCurrent = nowCurrentTry.isValid ? nowCurrentTry : DateTime.now().toUTC();
    const currentOffsetMinutes = nowCurrent.isValid ? nowCurrent.offset : 0;

    const or = [];
    if (targetIds.length) {
      or.push({ _id: { $in: targetIds.map((id) => new Types.ObjectId(id)) } });
    }
    if (targetCodesRaw.length) {
      or.push({ countryCode: { $in: targetCodesRaw } });
    }

    const countries = await CountryModel.find(or.length ? { $or: or } : {})
      .select("_id countryName countryCode callingCode flag")
      .lean();

    const resolvedIds = new Set(countries.map((c) => String(c._id)));
    const resolvedCodes = new Set(
      countries.map((c) => String(c.countryCode || "").toUpperCase())
    );

    const invalidCountryIds = targetIds.filter((id) => !resolvedIds.has(id));
    const invalidCountryCodes = targetCodesRaw.filter((cc) => !resolvedCodes.has(cc));

    const targets = countries.map((c) => {
      const code = String(c.countryCode || "").toUpperCase();

      const ctCountry = code ? ct.getCountry(code) : null;
      const picked = ctCountry
        ? pickSingleTimezoneForCountry(code)
        : { tz: null, reason: "fallback" };

      const tz = picked.tz || "UTC";
      const dt = DateTime.now().setZone(tz);
      const isValid = dt.isValid;
      const offsetMinutes = isValid ? dt.offset : null;

      return {
        id: String(c._id),
        countryCode: code || undefined,
        countryName: c.countryName,
        callingCode: c.callingCode,
        flag: c.flag,
        timezones: [
          {
            timezone: tz,
            isValid,
            nowLocal: isValid ? dt.toISO({ suppressMilliseconds: true }) : null,
            offsetMinutes,
            offsetMinutesFromCurrent:
              typeof offsetMinutes === "number"
                ? offsetMinutes - currentOffsetMinutes
                : null,
          },
        ],
        timezoneMeta: {
          selected: tz,
          selectedBy: picked.reason,
          availableCount: Array.isArray(ctCountry?.timezones)
            ? ctCountry.timezones.length
            : 0,
        },
      };
    });

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        current: {
          ip: currentIp || undefined,
          countryCode: currentCountryCode || undefined,
          timezone: nowCurrent.zoneName,
          nowLocal: nowCurrent.isValid
            ? nowCurrent.toISO({ suppressMilliseconds: true })
            : null,
          nowUtc: nowUtc.toISO({ suppressMilliseconds: true }),
        },
        targets,
        meta: {
          requested: { ids: targetIds.length, codes: targetCodesRaw.length },
          resolved: { countries: targets.length },
          invalid: { countryIds: invalidCountryIds, countryCodes: invalidCountryCodes },
        },
      },
      requestId
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return ApiResponse.sendFail(
      res,
      HttpStatus.INTERNAL_SERVER_ERROR,
      EC("INTERNAL_ERROR"),
      message,
      requestId
    );
  }
};

module.exports = {
  getTimezonesByCountries,
};