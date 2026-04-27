const axios = require("axios");
const cheerio = require("cheerio");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function normalizeUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}
///
//
//
function getBaseUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function toAbsoluteUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  try {
    const response = await axios.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      maxRedirects: 5,
    });

    return response.data;
  } catch {
    return null;
  }
}

function cleanText(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

function extractTextFromHtml(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  return cleanText($("body").text());
}

function extractEmails(text) {
  const matches =
    text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map((x) => x.toLowerCase()))];
}

function extractPhones(text) {
  const matches =
    text.match(/(\+?\d[\d\s().-]{7,}\d)/g) || [];
  return [...new Set(matches.map((x) => cleanText(x)))];
}

function discoverImportantLinks(html, websiteUrl) {
  const $ = cheerio.load(html);
  const base = getBaseUrl(websiteUrl);

  let aboutPageUrl = null;
  let contactPageUrl = null;
  const pageSet = new Set([websiteUrl]);

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const abs = toAbsoluteUrl(base, href);
    if (!abs) return;

    const lower = abs.toLowerCase();
    pageSet.add(abs);

    if (
      !aboutPageUrl &&
      (
        lower.includes("/about") ||
        lower.includes("about-us") ||
        lower.includes("/company") ||
        lower.includes("our-story")
      )
    ) {
      aboutPageUrl = abs;
    }

    if (
      !contactPageUrl &&
      (
        lower.includes("/contact") ||
        lower.includes("contact-us") ||
        lower.includes("/support") ||
        lower.includes("/help")
      )
    ) {
      contactPageUrl = abs;
    }
  });

  return {
    about_page_url: aboutPageUrl,
    contact_page_url: contactPageUrl,
    discovered_pages: [...pageSet],
  };
}

function extractSocialLinks(html, websiteUrl) {
  const $ = cheerio.load(html);
  const base = getBaseUrl(websiteUrl);

  const result = {
    instagram_url: null,
    youtube_url: null,
    linkedin_url: null,
    facebook_url: null,
    twitter_url: null,
  };

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const abs = toAbsoluteUrl(base, href);
    if (!abs) return;

    const lower = abs.toLowerCase();

    if (!result.instagram_url && lower.includes("instagram.com")) {
      result.instagram_url = abs;
    }
    if (
      !result.youtube_url &&
      (lower.includes("youtube.com") || lower.includes("youtu.be"))
    ) {
      result.youtube_url = abs;
    }
    if (!result.linkedin_url && lower.includes("linkedin.com")) {
      result.linkedin_url = abs;
    }
    if (!result.facebook_url && lower.includes("facebook.com")) {
      result.facebook_url = abs;
    }
    if (
      !result.twitter_url &&
      (lower.includes("twitter.com") || lower.includes("x.com"))
    ) {
      result.twitter_url = abs;
    }
  });

  return result;
}

function pickEmail(emails, type) {
  if (!emails || !emails.length) return null;

  const priorities = {
    sales: ["sales@", "business@", "partnership", "bd@"],
    support: ["support@", "help@", "care@", "service@"],
    general: ["info@", "hello@", "contact@", "admin@"],
  };

  const rules = priorities[type] || [];
  for (const email of emails) {
    if (rules.some((r) => email.includes(r))) return email;
  }

  return type === "general" ? emails[0] : null;
}

function extractAddressHeuristic(text) {
  const parts = text
    .split(/\. |\n/)
    .map(cleanText)
    .filter(Boolean);

  const candidate = parts.find((line) =>
    /street|road|avenue|building|tower|suite|floor|city|state|country|postal|zip|india|usa|uk|china|singapore|uae/i.test(
      line
    )
  );

  return candidate || null;
}

async function scrapeBrandWebsite(websiteUrl) {
  const normalized = normalizeUrl(websiteUrl);
  if (!normalized) return null;

  const homeHtml = await fetchHtml(normalized);
  if (!homeHtml) return null;

  const important = discoverImportantLinks(homeHtml, normalized);
  const socials = extractSocialLinks(homeHtml, normalized);

  const urlsToFetch = [
    normalized,
    important.about_page_url,
    important.contact_page_url,
  ].filter(Boolean);

  const uniqueUrls = [...new Set(urlsToFetch)].slice(0, 4);

  let combinedText = "";
  for (const pageUrl of uniqueUrls) {
    const html = pageUrl === normalized ? homeHtml : await fetchHtml(pageUrl);
    if (!html) continue;
    combinedText += "\n" + extractTextFromHtml(html);
  }

  combinedText = cleanText(combinedText);

  const emails = extractEmails(combinedText);
  const phones = extractPhones(combinedText);

  return {
    website_url: normalized,
    about_page_url: important.about_page_url,
    contact_page_url: important.contact_page_url,
    general_email: pickEmail(emails, "general"),
    sales_email: pickEmail(emails, "sales"),
    support_email: pickEmail(emails, "support"),
    public_phone: phones[0] || null,
    public_address: extractAddressHeuristic(combinedText),
    website_pages_scraped: uniqueUrls,
    last_scraped_at: new Date(),
    raw_website_text: combinedText.slice(0, 15000),
    ...socials,
  };
}

module.exports = {
  scrapeBrandWebsite,
};