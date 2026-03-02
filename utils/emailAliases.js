// utils/emailAliases.js

const crypto = require("crypto");
const EmailAlias = require("../models/emailAlias");

const RELAY_DOMAIN = String(process.env.EMAIL_RELAY_DOMAIN || "mail.collabglam.com")
  .trim()
  .toLowerCase();

// ---------- helpers ----------
function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}

function slugifyStrict(str) {
  // For brand aliases: only a-z0-9, no "+", no "."
  return String(str || "")
    .toLowerCase()
    .trim()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^-+|-+$/g, "");
}

function cleanLocalAllowPlus(str) {
  // For influencer aliases: allow "+"
  // (so we can do influencer+<token>@domain)
  return String(str || "")
    .toLowerCase()
    .trim()
    .replace(/^@/, "")
    .replace(/[^a-z0-9+]+/g, "")
    .slice(0, 50);
}

function makeToken(bytes = 4) {
  // 8 bytes => 16 hex chars
  return crypto.randomBytes(bytes).toString("hex");
}

async function reserveProxyEmail({ localPart }) {
  const local = cleanLocalAllowPlus(localPart) || "user";
  let alias = `${local}@${RELAY_DOMAIN}`;
  let n = 1;

  // ensure uniqueness across EmailAlias
  while (await EmailAlias.exists({ proxyEmail: alias })) {
    alias = `${local}${n}@${RELAY_DOMAIN}`;
    n += 1;
  }
  return alias;
}

/**
 * Brand aliases: brandname@mail.collabglam.com
 */
async function getOrCreateBrandAlias(brand) {
  if (brand.brandAliasEmail) return normEmail(brand.brandAliasEmail);

  const base = brand.slug || brand.name || brand.brandId || brand._id.toString();
  const local = slugifyStrict(base) || "brand";
  const alias = await reserveProxyEmail({ localPart: local });

  brand.brandAliasEmail = alias;
  await brand.save();

  await EmailAlias.findOneAndUpdate(
    { proxyEmail: alias },
    {
      $setOnInsert: {
        ownerModel: "Brand",
        owner: brand._id,
        proxyEmail: alias,
      },
      $set: {
        externalEmail: normEmail(brand.email),
        status: "active",
      },
    },
    { upsert: true, new: true }
  );

  return alias;
}

async function getOrCreateInfluencerAlias(influencer) {
  if (influencer.influencerAliasEmail) return normEmail(influencer.influencerAliasEmail);

  // Opaque, non-identifying routing alias
  const local = `influencer${makeToken(4)}`; // influencer+16hexchars
  const alias = await reserveProxyEmail({ localPart: local });

  influencer.influencerAliasEmail = alias;
  await influencer.save();

  await EmailAlias.findOneAndUpdate(
    { proxyEmail: alias },
    {
      $setOnInsert: {
        ownerModel: "Influencer",
        owner: influencer._id,
        proxyEmail: alias,
      },
      $set: {
        externalEmail: normEmail(influencer.email),
        status: "active",
      },
    },
    { upsert: true, new: true }
  );

  return alias;
}

/** Lookup alias record by proxy email (used by inbound handler). */
async function findAliasByProxy(proxyEmail) {
  const p = normEmail(proxyEmail);
  if (!p) return null;

  return EmailAlias.findOne({
    proxyEmail: p,
    status: "active",
  });
}

/** For “claim external email” flow – attach external emails to an influencer. */
async function attachExternalEmailToInfluencer(influencer, externalEmail) {
  const normalized = normEmail(externalEmail);
  if (!normalized) return;

  // Update all existing alias docs that already reference this external email
  await EmailAlias.updateMany(
    { externalEmail: normalized, ownerModel: "Influencer" },
    {
      $set: {
        owner: influencer._id,
        status: "active",
        verifiedAt: new Date(),
      },
    }
  );

  // If there is no alias yet for this external email, create a “secondary” mapping
  const existing = await EmailAlias.findOne({
    ownerModel: "Influencer",
    owner: influencer._id,
    externalEmail: normalized,
  });

  if (!existing) {
    // We do NOT create a new proxy address here; we just store the mapping
    await EmailAlias.create({
      ownerModel: "Influencer",
      owner: influencer._id,
      proxyEmail: influencer.influencerAliasEmail, // re-use their main routing alias
      externalEmail: normalized,
      status: "active",
      verifiedAt: new Date(),
    });
  }
}

module.exports = {
  getOrCreateBrandAlias,
  getOrCreateInfluencerAlias,
  findAliasByProxy,
  attachExternalEmailToInfluencer,
};
