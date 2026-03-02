// scripts/fixModashesDuplicatesAndIndex.js

const { MongoClient, ObjectId } = require('mongodb');

// You can keep using your hardcoded URI or swap to process.env.MONGODB_URI
const uri = "mongodb+srv://backendemcit1:influencer@influencer.m6wvc4x.mongodb.net/influencer?retryWrites=true&w=majority&appName=Influencer";

const dbName = 'influencer';
const collectionName = 'modashes';

// 🔐 First run with DRY_RUN = true to see what would happen.
// When you're happy, set this to false to actually delete and then create the index.
const DRY_RUN = false;

async function main() {
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    console.log(`Scanning for duplicate { userId, provider } in ${dbName}.${collectionName} ...`);

    // Group by userId + provider, find those with count > 1
    const cursor = collection.aggregate([
      {
        $group: {
          _id: { userId: '$userId', provider: '$provider' },
          ids: { $addToSet: '$_id' },
          count: { $sum: 1 }
        }
      },
      {
        $match: { count: { $gt: 1 } }
      }
    ]);

    let totalGroups = 0;
    let totalToDelete = 0;

    for await (const group of cursor) {
      totalGroups += 1;
      const { _id, ids, count } = group;
      const [keepId, ...removeIds] = ids;

      console.log('\nDuplicate group:');
      console.log(`  userId: ${_id.userId}, provider: ${_id.provider}`);
      console.log(`  count: ${count}`);
      console.log(`  keep _id: ${keepId}`);
      console.log(`  remove _ids: ${removeIds.join(', ') || '(none)'}`);

      totalToDelete += removeIds.length;

      if (!DRY_RUN && removeIds.length > 0) {
        const res = await collection.deleteMany({ _id: { $in: removeIds } });
        console.log(`  -> deleted ${res.deletedCount} docs`);
      }
    }

    if (totalGroups === 0) {
      console.log('\n✅ No duplicate { userId, provider } pairs found.');
    } else {
      console.log(`\nFound ${totalGroups} duplicate key groups, ${totalToDelete} docs to delete.`);

      if (DRY_RUN) {
        console.log('\n🟡 DRY RUN ONLY — nothing was deleted.');
        console.log('   If this looks correct, set DRY_RUN = false in the script and run again.');
        console.log('   (Unique index will NOT be created in dry run.)');
        return;
      }
    }

    // At this point, either there were no duplicates or we've removed them.
    console.log('\nCreating UNIQUE index on { userId: 1, provider: 1 } ...');
    const indexName = await collection.createIndex(
      { userId: 1, provider: 1 },
      { unique: true, name: 'userId_provider_unique' }
    );
    console.log('✅ Created index:', indexName);
  } catch (err) {
    console.error('❌ Error while fixing duplicates / creating index:', err);
  } finally {
    await client.close();
  }
}

main();
