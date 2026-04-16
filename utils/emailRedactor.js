'use strict';

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function deepClone(x) {
  if (!x || typeof x !== 'object') return x;
  return JSON.parse(JSON.stringify(x));
}

function buildEmailHidePatterns() {
  const localParts = [
    '[A-Z0-9._%+-]+',
    '[A-Z0-9]+(?:[._%+-][A-Z0-9]+)*',
  ];

  const atTokens = [
    '@',
    '\\s*@\\s*',
    '\\s+at\\s+',
    '\\s*\\(at\\)\\s*',
    '\\s*\\[at\\]\\s*',
    '\\s*\\{at\\}\\s*',
  ];

  const dotTokens = [
    '\\.',
    '\\s*\\.\\s*',
    '\\s+dot\\s+',
    '\\s*\\(dot\\)\\s*',
    '\\s*\\[dot\\]\\s*',
    '\\s*\\{dot\\}\\s*',
    '\\s+d0t\\s+',
  ];

  const patterns = [];

  for (const local of localParts) {
    for (const at of atTokens) {
      for (const dot of dotTokens) {
        patterns.push(
          new RegExp(
            `\\b${local}${at}[A-Z0-9-]+(?:${dot}[A-Z0-9-]+)+\\b`,
            'gi'
          )
        );
      }
    }
  }

  const extras = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi,
    /\bmailto:\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi,
    /\b[A-Z0-9._%+-]+\s*@\s*[A-Z0-9.-]+\s*\.\s*[A-Z]{2,24}\b/gi,
    /\b[A-Z0-9._%+-]+\s+at\s+[A-Z0-9-]+(?:\s+dot\s+[A-Z0-9-]+)+\b/gi,
    /\b[A-Z0-9._%+-]+\s*\(at\)\s*[A-Z0-9-]+(?:\s*\(dot\)\s*[A-Z0-9-]+)+\b/gi,
    /\b[A-Z0-9._%+-]+\s*\[at\]\s*[A-Z0-9-]+(?:\s*\[dot\]\s*[A-Z0-9-]+)+\b/gi,
    /\b[A-Z0-9._%+-]+\s*\{at\}\s*[A-Z0-9-]+(?:\s*\{dot\}\s*[A-Z0-9-]+)+\b/gi,
    /\b[A-Z0-9._%+-]+\s*(?:&#64;|&commat;)\s*[A-Z0-9-]+(?:\s*(?:&#46;|&period;)\s*[A-Z0-9-]+)+\b/gi,
    /\b[A-Z0-9._%+-]+\s*(?:%40)\s*[A-Z0-9-]+(?:\s*(?:%2E)\s*[A-Z0-9-]+)+\b/gi,
    /\b[A-Z0-9._%+-]+\s*(?:@|\(at\)|\[at\]|\{at\}|at|&#64;|%40)\s*[A-Z0-9-]+(?:\s*(?:\.|\(dot\)|\[dot\]|\{dot\}|dot|&#46;|%2E|d0t)\s*[A-Z0-9-]+)+\b/gi,
  ];

  return [...extras, ...patterns];
}

const EMAIL_HIDE_PATTERNS = buildEmailHidePatterns();

function redactEmails(text = '', replacement = 'XXXXXXX') {
  if (!text) return text;

  let cleaned = String(text);

  for (const pattern of EMAIL_HIDE_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  cleaned = cleaned
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

function canShowSensitiveFromRequest(req, fallback = {}) {
  const adminId = cleanStr(
    fallback.adminId ||
      req.query?.adminId ||
      req.query?.admin_id ||
      req.body?.adminId ||
      req.body?.admin_id
  );

  return !!adminId;
}

function redactStringFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  if (typeof obj.bio === 'string') {
    obj.bio = redactEmails(obj.bio, 'XXXXXXX');
  }

  if (typeof obj.description === 'string') {
    obj.description = redactEmails(obj.description, 'XXXXXXX');
  }

  if (typeof obj.about === 'string') {
    obj.about = redactEmails(obj.about, 'XXXXXXX');
  }

  if (typeof obj.summary === 'string') {
    obj.summary = redactEmails(obj.summary, 'XXXXXXX');
  }

  if (typeof obj.introduction === 'string') {
    obj.introduction = redactEmails(obj.introduction, 'XXXXXXX');
  }

  return obj;
}

function sanitizeContactsEverywhere(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj.contacts)) {
    obj.contacts = [];
  }

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          sanitizeContactsEverywhere(item);
        }
      }
    } else if (value && typeof value === 'object') {
      sanitizeContactsEverywhere(value);
    }
  }

  return obj;
}

function sanitizeTextEverywhere(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  redactStringFields(obj);

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          sanitizeTextEverywhere(item);
        }
      }
    } else if (value && typeof value === 'object') {
      sanitizeTextEverywhere(value);
    }
  }

  return obj;
}

function sanitizeModashReportForViewer(report, canShowSensitive = false) {
  if (!report || typeof report !== 'object') return report;

  const out = deepClone(report);
  if (canShowSensitive) return out;

  sanitizeContactsEverywhere(out);
  sanitizeTextEverywhere(out);

  return out;
}

function sanitizeModashDocForViewer(doc, canShowSensitive = false) {
  if (!doc || typeof doc !== 'object') return doc;

  const out = deepClone(doc);
  if (canShowSensitive) return out;

  if (Array.isArray(out.contacts)) {
    out.contacts = [];
  }

  redactStringFields(out);

  if (out.providerRaw && typeof out.providerRaw === 'object') {
    out.providerRaw = sanitizeModashReportForViewer(out.providerRaw, false);
  }

  return out;
}

module.exports = {
  redactEmails,
  canShowSensitiveFromRequest,
  sanitizeModashReportForViewer,
  sanitizeModashDocForViewer,
};