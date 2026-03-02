// controllers/emailInboundController.js

const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const { EmailThread, EmailMessage } = require("../models/email");
const {
  findAliasByProxy,
  getOrCreateBrandAlias,
  getOrCreateInfluencerAlias,
} = require("../utils/emailAliases");

const RELAY_DOMAIN = (process.env.EMAIL_RELAY_DOMAIN || "mail.collabglam.com").toLowerCase();

function slugifyLocalPart(name) {
  const slug =
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 20) || "";
  return slug || "influencer";
}

function computeInfluencerDisplayAlias(influencer) {
  const domain = RELAY_DOMAIN;
  if (influencer?.otpVerified === true) return `${slugifyLocalPart(influencer?.name)}@${domain}`;
  return `influencer@${domain}`;
}

async function ensureThreadInfluencerDisplayAlias(thread, influencer) {
  if (!thread) return;
  const desired = computeInfluencerDisplayAlias(influencer);
  if (thread.influencerDisplayAlias !== desired) {
    thread.influencerDisplayAlias = desired;
    if (thread.influencerSnapshot && influencer?.name) thread.influencerSnapshot.name = influencer.name;
    await thread.save();
  }
}

function norm(e) {
  return String(e || "").trim().toLowerCase();
}

function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  // allow "a@x.com, b@y.com"
  return String(v)
    .split(/[,\s;]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

// local copy to avoid cycles
async function getOrCreateThread({ brand, influencer, createdBy, subject }) {
  let thread = await EmailThread.findOne({
    brand: brand._id,
    influencer: influencer._id,
  });

  if (thread) {
    if (!thread.subject && subject) {
      thread.subject = subject;
      await thread.save();
    }
    await ensureThreadInfluencerDisplayAlias(thread, influencer);
    return thread;
  }

  const brandAlias = await getOrCreateBrandAlias(brand);
  const influencerAlias = await getOrCreateInfluencerAlias(influencer);
  const influencerDisplayAlias = computeInfluencerDisplayAlias(influencer);

  thread = await EmailThread.create({
    brand: brand._id,
    influencer: influencer._id,

    brandSnapshot: { name: brand.name, email: brand.email },
    influencerSnapshot: { name: influencer.name || "Influencer", email: influencer.email },

    brandAliasEmail: brandAlias,
    influencerAliasEmail: influencerAlias,
    brandDisplayAlias: brandAlias,
    influencerDisplayAlias: influencerDisplayAlias,

    subject: subject || undefined,
    status: "active",
    createdBy: createdBy || "system",
  });

  return thread;
}

async function findThreadByProxyRecipients(proxyRecipients = []) {
  if (!proxyRecipients.length) return null;

  // Prefer indexed fields (brandAliasEmail, influencerAliasEmail)
  const thread = await EmailThread.findOne({
    $or: [
      { brandAliasEmail: { $in: proxyRecipients } },
      { influencerAliasEmail: { $in: proxyRecipients } },
    ],
  });

  if (!thread) return null;

  // find which proxy matched
  const matchedProxy =
    proxyRecipients.find(
      (p) =>
        p === norm(thread.brandAliasEmail) ||
        p === norm(thread.influencerAliasEmail) ||
        p === norm(thread.brandDisplayAlias) ||
        p === norm(thread.influencerDisplayAlias)
    ) || proxyRecipients[0];

  return { thread, matchedProxy };
}

function computeDirectionFromThread(thread, matchedProxy) {
  const p = norm(matchedProxy);
  const brandProxy = norm(thread.brandAliasEmail);
  const influencerProxy = norm(thread.influencerAliasEmail);

  // Email addressed to BRAND proxy => influencer replied
  if (p === brandProxy) return "influencer_to_brand";
  // Email addressed to INFLUENCER proxy => brand replied
  if (p === influencerProxy) return "brand_to_influencer";

  // fallback (rare)
  return null;
}

function buildBodies({ html, text }) {
  const textBody = String(text || "");
  const htmlBody =
    html ||
    (textBody
      ? `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;">${textBody
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre>`
      : "");
  return { htmlBody, textBody };
}

/**
 * POST /emails/inbound
 * Expected payload fields (flexible):
 *  - from (string)
 *  - fromName (string)
 *  - to / cc / bcc (array|string)
 *  - subject (string)
 *  - html (string)
 *  - text (string)
 *  - messageId (string)
 *  - inReplyTo (string)
 *  - references (array|string)
 */
exports.handleInboundEmail = async (req, res) => {
  try {
    const {
      from,
      fromName,
      to,
      cc,
      bcc,
      subject,
      html,
      text,
      messageId,
      inReplyTo,
      references,
    } = req.body || {};

    const fromRealEmail = norm(from);
    if (!fromRealEmail) {
      return res.status(400).json({ error: "Missing from address" });
    }

    const allRecipients = [
      ...asArray(to),
      ...asArray(cc),
      ...asArray(bcc),
    ]
      .map(norm)
      .filter(Boolean);

    const proxyRecipients = allRecipients.filter((addr) =>
      addr.endsWith(`@${RELAY_DOMAIN}`)
    );

    if (!proxyRecipients.length) {
      // Not for our relay domain
      return res.status(204).end();
    }

    // 1) BEST PATH: find the thread directly by proxy recipient
    const found = await findThreadByProxyRecipients(proxyRecipients);

    let thread = null;
    let matchedProxy = null;
    let direction = null;
    let brand = null;
    let influencer = null;

    if (found?.thread) {
      thread = found.thread;
      matchedProxy = found.matchedProxy;
      direction = computeDirectionFromThread(thread, matchedProxy);

      if (!direction) {
        console.warn("[inbound] Could not determine direction for proxy:", matchedProxy);
        return res.status(204).end();
      }

      // Load participants from thread (do NOT guess/create brands from random email)
      brand = await Brand.findById(thread.brand);
      influencer = await Influencer.findById(thread.influencer);

      if (!brand || !influencer) {
        console.warn("[inbound] Thread participants missing:", {
          threadId: String(thread._id),
          hasBrand: !!brand,
          hasInfluencer: !!influencer,
        });
        return res.status(204).end();
      }
    } else {
      // 2) FALLBACK: resolve by EmailAlias owner
      const proxyEmail = proxyRecipients[0];
      const alias = await findAliasByProxy(proxyEmail);

      if (!alias) {
        console.warn("[inbound] No EmailAlias for proxy:", proxyEmail);
        return res.status(204).end();
      }

      matchedProxy = proxyEmail;

      if (alias.ownerModel === "Brand") {
        // Email addressed to brand proxy => influencer wrote in
        brand = await Brand.findById(alias.owner);
        if (!brand) {
          console.warn("[inbound] Brand not found for alias:", proxyEmail);
          return res.status(204).end();
        }

        direction = "influencer_to_brand";

        // Influencer might not exist yet (cold outreach) -> create minimal
        influencer =
          (await Influencer.findOne({ email: fromRealEmail })) ||
          (await Influencer.create({
            email: fromRealEmail,
            name: fromName || fromRealEmail.split("@")[0],
            otpVerified: false,
          }));
      } else if (alias.ownerModel === "Influencer") {
        // Email addressed to influencer proxy => brand wrote in
        influencer = await Influencer.findById(alias.owner);
        if (!influencer) {
          console.warn("[inbound] Influencer not found for alias:", proxyEmail);
          return res.status(204).end();
        }

        direction = "brand_to_influencer";

        // IMPORTANT: do NOT auto-create brands from random inbound emails.
        // A brand reply should come from an existing Brand.email.
        brand = await Brand.findOne({ email: fromRealEmail });
        if (!brand) {
          console.warn("[inbound] Brand not found by from email:", fromRealEmail);
          return res.status(204).end();
        }
      } else {
        console.warn("[inbound] Unknown alias ownerModel:", alias.ownerModel);
        return res.status(204).end();
      }

      // Create / reuse thread
      thread = await getOrCreateThread({
        brand,
        influencer,
        createdBy: direction === "brand_to_influencer" ? "brand" : "influencer",
        subject,
      });
    }

    // Avoid duplicate inserts if provider retries
    if (messageId) {
      const exists = await EmailMessage.exists({
        thread: thread._id,
        messageId: String(messageId),
      });
      if (exists) return res.status(200).json({ ok: true, duplicate: true });
    }

    const { htmlBody, textBody } = buildBodies({ html, text });

    // For UI consistency, store proxy identities as sender/recipient
    const fromProxyEmail =
      direction === "brand_to_influencer"
        ? thread.brandAliasEmail
        : thread.influencerAliasEmail;

    const fromAliasEmail =
      direction === "brand_to_influencer"
        ? (thread.brandDisplayAlias || thread.brandAliasEmail)
        : (thread.influencerDisplayAlias || thread.influencerAliasEmail);
    const toProxyEmail = matchedProxy; // the proxy address that received this inbound email

    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction,

      fromUser: direction === "brand_to_influencer" ? brand._id : influencer._id,
      fromUserModel: direction === "brand_to_influencer" ? "Brand" : "Influencer",

      // what we show in UI as "from"
      fromAliasEmail: fromAliasEmail,
      fromProxyEmail,
      fromRealEmail,

      // routing info (internal)
      toProxyEmail,
      toRealEmail: direction === "brand_to_influencer" ? influencer.email : brand.email,

      subject: subject || "",
      htmlBody,
      textBody,

      messageId: messageId || undefined,
      inReplyTo: inReplyTo || undefined,
      references: asArray(references),

      receivedAt: new Date(),
    });

    thread.lastMessageAt = messageDoc.createdAt;
    thread.lastMessageDirection = direction;
    thread.lastMessageSnippet = (textBody || "").slice(0, 200);

    // Optional optimization flag (won't break if schema doesn't have it)
    if (direction === "influencer_to_brand" && thread.hasInfluencerReplied !== undefined) {
      thread.hasInfluencerReplied = true;
    }

    await thread.save();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("handleInboundEmail error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
