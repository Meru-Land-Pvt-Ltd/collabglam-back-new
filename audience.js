const mongoose = require('mongoose');
const AudienceRange = require('./models/audience');

/**
 * Formats numbers to human-readable labels (e.g., 1000 -> "1k", 1000000 -> "1M").
 */
function formatLabel(num) {
  if (num >= 1000000) return `${num / 1000000}M`;
  if (num >= 1000)    return `${num / 1000}k`;
  return `${num}`;
}

/**
 * Generates audience size ranges as strings: "1 - 1k", "1k - 10k", ..., "10M+".
 * @returns {string[]}
 */
function generateAudienceRangeLabels() {
  const labels = [];
  let min = 1;
  let max = 1000;

  while (min < 10000000) {
    labels.push(`${formatLabel(min)} - ${formatLabel(max)}`);
    min = max;
    max *= 10;
  }

  // Final open-ended range
  labels.push('10M+');

  return labels;
}

const audienceRangeLabels = generateAudienceRangeLabels();

/**
 * Seeds the generated audience range labels into MongoDB using AudienceRange model.
 * @param {string} mongoUri - MongoDB connection string.
 */
async function seedAudienceRanges(mongoUri) {
  if (!mongoUri) {
    console.error('Please provide a MongoDB URI.');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);

    for (const label of audienceRangeLabels) {
      await AudienceRange.updateOne(
        { range: label },
        { range: label },
        { upsert: true }
      );
      console.log(`Upserted range: ${label}`);
    }

    console.log('✅ All audience ranges have been stored in the database.');
  } catch (err) {
    console.error('❌ Error seeding audience ranges:', err);
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = {
  audienceRangeLabels,
  seedAudienceRanges
};

// If run directly: `node audience.js <mongoUri>`
if (require.main === module) {
  const [, , mongoUri] = process.argv;
  seedAudienceRanges(mongoUri);
}
