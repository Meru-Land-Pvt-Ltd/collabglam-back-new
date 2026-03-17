const mongoose = require("mongoose");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  throw new Error("Missing MONGO_URI or MONGODB_URI in .env");
}

const adminSchema = new mongoose.Schema(
  {
    email: { type: String, lowercase: true, trim: true },
    name: { type: String, trim: true },
    role: { type: String, trim: true },
    status: { type: String, trim: true },
    access: [
      {
        key: String,
        name: String,
        isEdit: Boolean,
        isDelete: Boolean,
        isManager: Boolean,
      },
    ],
    permissions: [
      {
        key: String,
        name: String,
        isEdit: Boolean,
        isDelete: Boolean,
        isManager: Boolean,
      },
    ],
    parentAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "Master", default: null },
    rootAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "Master", default: null },
  },
  {
    strict: false,
    collection: "masters", // change this if your collection name is different
  }
);

const AdminModel = mongoose.model("MasterMigration", adminSchema);

function normalizeAccess(items = []) {
  if (!Array.isArray(items)) return [];

  const seen = new Set();

  return items
    .map((item) => {
      if (!item || !item.key) return null;

      const key = String(item.key).trim().toLowerCase();
      if (!key) return null;

      if (seen.has(key)) return null;
      seen.add(key);

      return {
        key,
        name: item.name ? String(item.name).trim() : key,
        isEdit: Boolean(item.isEdit),
        isDelete: Boolean(item.isDelete),
        isManager: key === "role" ? true : Boolean(item.isManager),
      };
    })
    .filter(Boolean);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log("MongoDB connected");

  const adminId = "69b007bb8e53408b168a8371";

  const admin = await AdminModel.findById(adminId);
  if (!admin) {
    throw new Error(`Admin not found for id ${adminId}`);
  }

  const sourcePermissions =
    Array.isArray(admin.access) && admin.access.length > 0
      ? admin.access
      : Array.isArray(admin.permissions)
      ? admin.permissions
      : [];

  const normalizedAccess = normalizeAccess(sourcePermissions);

  admin.role = "super_admin";
  admin.parentAdmin = null;
  admin.rootAdmin = null;
  admin.access = normalizedAccess;

  // remove old field if present
  admin.set("permissions", undefined);

  await admin.save();

  // hard unset old field to clean document
  await AdminModel.updateOne(
    { _id: admin._id },
    {
      $unset: { permissions: "" },
    }
  );

  console.log("Migration completed");
  console.log({
    _id: String(admin._id),
    email: admin.email,
    role: admin.role,
    parentAdmin: admin.parentAdmin,
    rootAdmin: admin.rootAdmin,
    accessCount: normalizedAccess.length,
  });

  await mongoose.disconnect();
  console.log("MongoDB disconnected");
}

run().catch(async (err) => {
  console.error("Migration failed:", err.message);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});