// src/core/http/humanizeErrorMessage.js
const ACRONYMS = new Set([
  "id",
  "ids",
  "url",
  "api",
  "ip",
  "ai",
  "utc",
  "upi",
  "vpa",
  "imps",
  "pdf",
  "csv",
]);

function toTitleWord(w) {
  const lower = String(w || "").toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  return lower ? lower[0].toUpperCase() + lower.slice(1) : lower;
}

function splitIdentifier(s) {
  // support dot paths: createdLocation.country -> Created Location Country
  const parts = String(s).split(".");
  const words = [];

  for (const partRaw of parts) {
    const part = String(partRaw || "")
      .replace(/[_-]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // fooBar -> foo Bar
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // ABCDef -> ABC Def
      .trim();

    if (!part) continue;

    for (const w of part.split(/\s+/)) {
      words.push(toTitleWord(w));
    }
  }

  return words.join(" ").trim();
}

function shouldHumanizeToken(token) {
  // only touch identifier-looking tokens that start lowercase
  // (prevents changing OPENAI_API_KEY, Mongo, etc.)
  if (!/^[a-z][a-zA-Z0-9_.]*$/.test(token)) return false;

  // common web terms we do NOT want to title-case
  if (token === "http" || token === "https") return false;

  // humanize if it looks like a field name
  return token.includes(".") || /[A-Z]/.test(token);
}

function humanizeErrorMessage(message) {
  const msg = String(message ?? "");

  // 1) mongoose style: Path `campaignTitle` is required.
  const unbackticked = msg.replace(/`([^`]+)`/g, (_m, t) => splitIdentifier(t));

  // 2) general tokens: campaignTitle, brandId, maxFollowers, etc.
  return unbackticked.replace(/\b[a-z][a-zA-Z0-9_.]*\b/g, (token) => {
    if (!shouldHumanizeToken(token)) return token;
    return splitIdentifier(token);
  });
}

module.exports = { humanizeErrorMessage };