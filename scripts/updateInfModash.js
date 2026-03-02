// scripts/updateInfModash.js
require('dotenv').config();
const mongoose = require('mongoose');

// Ensure models are registered (even if we don't use Influencer directly)
require('../models/influencer');
const Modash = require('../models/modash');

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  'mongodb://127.0.0.1:27017/influencer';

async function run() {
  console.log('Connecting to MongoDB:', MONGODB_URI);
  await mongoose.connect(MONGODB_URI);
  console.log('Connected. Running diagnostics…');

  const col = mongoose.connection.db.collection('influencers');

  const total = await col.countDocuments();
  const withField = await col.countDocuments({ socialProfiles: { $exists: true } });
  const withNonEmpty = await col.countDocuments({ 'socialProfiles.0': { $exists: true } });

  console.log('Total influencers:', total);
  console.log('With socialProfiles field:', withField);
  console.log('With non-empty socialProfiles:', withNonEmpty);

  // Grab all influencers that actually have at least one profile
  const influencers = await col
    .find({ 'socialProfiles.0': { $exists: true } })
    .toArray();

  console.log('\nInfluencers to migrate:', influencers.length);

  let migratedInfluencers = 0;
  let upsertedProfiles = 0;

  for (const inf of influencers) {
    const profiles = Array.isArray(inf.socialProfiles) ? inf.socialProfiles : [];
    console.log(
      `\n[INF] ${inf.influencerId || inf._id} → socialProfiles length = ${profiles.length}`
    );

    if (!profiles.length) {
      console.log('  ↳ No profiles, skipping.');
      continue;
    }

    let didUpsertForThisInfluencer = 0;

    for (const sp of profiles) {
      if (!sp || !sp.provider) {
        console.log('  - Skipping profile with no provider');
        continue;
      }

      console.log(
        `  - Migrating profile provider=${sp.provider} userId=${sp.userId || 'N/A'}`
      );

      // This matches your Modash schema: unique per (influencer, provider)
      const filter = {
        influencer: inf._id,
        provider: sp.provider
      };

      const update = {
        influencer: inf._id,
        influencerId: inf.influencerId, // use the real influencerId, not the default uuid

        provider: sp.provider,

        // Identity
        userId: sp.userId,
        username: sp.username,
        fullname: sp.fullname,
        handle: sp.handle,
        url: sp.url,
        picture: sp.picture,

        // Metrics
        followers: sp.followers,
        engagements: sp.engagements,
        engagementRate: sp.engagementRate,
        averageViews: sp.averageViews,

        // State/meta
        isPrivate: sp.isPrivate,
        isVerified: sp.isVerified,
        accountType: sp.accountType,
        secUid: sp.secUid,

        // Localization
        city: sp.city,
        state: sp.state,
        country: sp.country,
        ageGroup: sp.ageGroup,
        gender: sp.gender,
        language: sp.language,

        // Content stats & posts
        statsByContentType: sp.statsByContentType,
        stats: sp.stats,
        recentPosts: sp.recentPosts || [],
        popularPosts: sp.popularPosts || [],

        // Counts
        postsCount: sp.postsCount,
        avgLikes: sp.avgLikes,
        avgComments: sp.avgComments,
        avgViews: sp.avgViews,
        avgReelsPlays: sp.avgReelsPlays,
        totalLikes: sp.totalLikes,
        totalViews: sp.totalViews,

        // Bio / tags / brand
        bio: sp.bio,
        categories: sp.categories || [],
        hashtags: sp.hashtags || [],
        mentions: sp.mentions || [],
        brandAffinity: sp.brandAffinity || [],

        // Audience
        audience: sp.audience,
        audienceCommenters: sp.audienceCommenters,
        lookalikes: sp.lookalikes || [],

        // Paid/sponsored
        sponsoredPosts: sp.sponsoredPosts || [],
        paidPostPerformance: sp.paidPostPerformance,
        paidPostPerformanceViews: sp.paidPostPerformanceViews,
        sponsoredPostsMedianViews: sp.sponsoredPostsMedianViews,
        sponsoredPostsMedianLikes: sp.sponsoredPostsMedianLikes,
        nonSponsoredPostsMedianViews: sp.nonSponsoredPostsMedianViews,
        nonSponsoredPostsMedianLikes: sp.nonSponsoredPostsMedianLikes,

        // extras
        audienceExtra: sp.audienceExtra,
        providerRaw: sp.providerRaw
      };

      await Modash.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      });

      didUpsertForThisInfluencer++;
      upsertedProfiles++;
      console.log('    ↳ Upserted Modash profile.');
    }

    if (didUpsertForThisInfluencer > 0) {
      // Remove socialProfiles from Influencer document at raw Mongo level
      await col.updateOne(
        { _id: inf._id },
        { $unset: { socialProfiles: '' } }
      );
      migratedInfluencers++;
      console.log(
        `  ✅ Cleared socialProfiles for ${inf.influencerId || inf._id}. Migrated profiles: ${didUpsertForThisInfluencer}`
      );
    } else {
      console.log(
        '  ⚠ No profiles upserted for this influencer. socialProfiles left unchanged.'
      );
    }
  }

  console.log('\nMigration complete ✅');
  console.log('Influencers migrated:', migratedInfluencers);
  console.log('Modash profiles upserted:', upsertedProfiles);

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
}

run().catch((err) => {
  console.error('Migration failed ❌', err);
  process.exit(1);
});
