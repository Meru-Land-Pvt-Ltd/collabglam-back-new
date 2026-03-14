require("dotenv").config();
const mongoose = require("mongoose");

const InfluencerModule = require("../models/influencer");
const InfluencerModel =
  InfluencerModule.InfluencerModel ||
  InfluencerModule.default ||
  InfluencerModule;

const DOMAIN = "mail.collabglam.cloud";
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

function cleanString(value = "") {
  return String(value || "").trim();
}

function slugifyName(value = "") {
  return cleanString(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "") // remove spaces/special chars
    .trim();
}

function localPartFromEmail(email = "") {
  return cleanString(email)
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function buildBaseName(influencer) {
  const fromName = slugifyName(influencer.name);
  if (fromName) return fromName;

  const fromEmail = localPartFromEmail(influencer.email);
  if (fromEmail) return fromEmail;

  return `influencer${String(influencer._id).slice(-6).toLowerCase()}`;
}

async function run() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("Missing MONGODB_URI or MONGO_URI in .env");
  }

  try {
    await mongoose.connect(mongoUri);
    console.log("MongoDB connected");

    // collect already used proxy emails
    const existingProxyDocs = await InfluencerModel.find(
      { proxyEmail: { $exists: true, $nin: ["", null] } },
      { proxyEmail: 1 }
    ).lean();

    const usedProxyEmails = new Set(
      existingProxyDocs
        .map((doc) => cleanString(doc.proxyEmail).toLowerCase())
        .filter(Boolean)
    );

    // only influencers where proxyEmail is missing/empty
    const influencers = await InfluencerModel.find(
      {
        $or: [
          { proxyEmail: { $exists: false } },
          { proxyEmail: null },
          { proxyEmail: "" },
        ],
      },
      { _id: 1, influencerId: 1, name: 1, email: 1 }
    ).lean();

    if (!influencers.length) {
      console.log("No influencers found without proxyEmail");
      return;
    }

    const ops = [];

    for (const influencer of influencers) {
      const base = buildBaseName(influencer);

      let candidate = `${base}@${DOMAIN}`;
      let counter = 2;

      while (usedProxyEmails.has(candidate)) {
        candidate = `${base}${counter}@${DOMAIN}`;
        counter += 1;
      }

      usedProxyEmails.add(candidate);

      console.log(
        `[MAP] ${influencer.name || "(no-name)"} | ${influencer.email} -> ${candidate}`
      );

      ops.push({
        updateOne: {
          filter: { _id: influencer._id },
          update: {
            $set: {
              proxyEmail: candidate,
            },
          },
        },
      });
    }

    if (DRY_RUN) {
      console.log(`DRY_RUN=true, no database changes made. Total: ${ops.length}`);
      return;
    }

    const result = await InfluencerModel.bulkWrite(ops);

    console.log("Migration completed");
    console.log("Matched:", result.matchedCount || 0);
    console.log("Modified:", result.modifiedCount || 0);
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await mongoose.connection.close();
    console.log("MongoDB connection closed");
  }
}

run();