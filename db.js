// db.js
require('dotenv').config();
const { MongoClient } = require('mongodb');

const { MONGO_URI, DB_NAME = 'Influencer' } = process.env;

if (!MONGO_URI) {
  throw new Error('Missing MONGO_URI environment variable');
}

let cachedClient = null;
let cachedDb     = null;

/**
 * Connects to MongoDB Atlas and re-uses the same client on
 * subsequent calls.  Always returns the database named in
 * DB_NAME (defaults to “fluentcrm”).
 */
async function connectToDatabase() {
  if (cachedClient && cachedDb) return { client: cachedClient, db: cachedDb };

  const client = new MongoClient(MONGO_URI);   // ←  fixed var name
  await client.connect();

  const db = client.db(DB_NAME);               // ←  explicit DB
  cachedClient = client;
  cachedDb     = db;

  console.log(`✔️  Connected to MongoDB → ${DB_NAME}`);
  return { client, db };
}

/**
 * Gracefully closes the cached connection (call on shutdown if you like).
 */
async function closeConnection() {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
    cachedDb     = null;
    console.log('🔒  MongoDB connection closed');
  }
}

// You can import either connectToDatabase (...) or the shorter alias connectDB (...)
module.exports = {
  connectToDatabase,
  connectDB: connectToDatabase,   // convenient alias
  closeConnection,
};
