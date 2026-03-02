// utils/searchTokens.js

// Escape a string for use in new RegExp(...)
function escapeRegExp(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split into coarse tokens (words). Adjust the regex if your data needs different splitting.
 */
function tokenize(str = '') {
  return String(str)
    .toLowerCase()
    .trim()
    .split(/[\s._\-\/|]+/)
    .filter(Boolean);
}

/**
 * Word edge n-grams: "devansh" -> ["d","de","dev","deva","devan","devans","devansh"]
 * Applied per-token.
 */
function edgeNgrams(str = '', min = 1, max = 64) {
  const out = [];
  for (const tok of tokenize(str)) {
    const limit = Math.min(max, tok.length);
    for (let i = min; i <= limit; i++) out.push(tok.slice(0, i));
  }
  return out;
}

/**
 * Character sliding n-grams over the WHOLE (normalized) string:
 * "devansh" -> ["de","ev","va","an","ns","sh", ...] + 3/4-grams, etc.
 * This is what makes "sh" queries fast with a simple prefix ^sh on _ac.
 */
function charNgrams(str = '', min = 2, max = 4) {
  const s = String(str).toLowerCase().trim().replace(/\s+/g, ' ');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    for (let len = min; len <= max && i + len <= s.length; len++) {
      out.push(s.slice(i, i + len));
    }
  }
  return out;
}

module.exports = {
  escapeRegExp,
  edgeNgrams,
  charNgrams,
};
