// controllers/notificationsController.js
const mongoose = require('mongoose');
const Notification = require('../models/notification');
const Admin = require('../models/admin');

// -------------------------
// BRAND
// -------------------------
async function listForBrand(req, res) {
  try {
    const { brandId, page = 1, limit = 20 } = req.query;
    if (!brandId) return res.status(400).json({ message: 'brandId is required' });

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));

    const q = { brandId: String(brandId) };

    const [data, total, unread] = await Promise.all([
      Notification.find(q).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Notification.countDocuments(q),
      Notification.countDocuments({ ...q, isRead: false })
    ]);

    res.json({ data, total, unread, page: p, limit: l });
  } catch (err) {
    console.error('listForBrand error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

async function markReadForBrand(req, res) {
  try {
    const { id, brandId } = req.body;
    if (!id || !brandId) return res.status(400).json({ message: 'id and brandId are required' });

    const doc = await Notification.findOneAndUpdate(
      { _id: id, brandId: String(brandId) },
      { $set: { isRead: true } },
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true, item: doc });
  } catch (err) {
    console.error('markReadForBrand error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

async function markAllReadForBrand(req, res) {
  try {
    const { brandId } = req.body;
    if (!brandId) return res.status(400).json({ message: 'brandId is required' });

    await Notification.updateMany(
      { brandId: String(brandId), isRead: false },
      { $set: { isRead: true } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('markAllReadForBrand error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteForBrand(req, res) {
  try {
    const { notificationId } = req.body;
    if (!notificationId) {
      return res.status(400).json({ message: 'notificationId is required' });
    }

    // Keeping your current logic as-is
    const doc = await Notification.findOneAndDelete({
      notificationId: String(notificationId),
    }).lean();

    if (!doc) {
      return res.status(404).json({ message: 'Not found' });
    }

    return res.json({ ok: true, deletedId: notificationId, previous: doc });
  } catch (err) {
    console.error('deleteForBrand error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

// -------------------------
// INFLUENCER
// -------------------------
async function listForInfluencer(req, res) {
  try {
    const { influencerId, page = 1, limit = 20 } = req.query;
    if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));

    const q = { influencerId: String(influencerId) };

    const [data, total, unread] = await Promise.all([
      Notification.find(q).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Notification.countDocuments(q),
      Notification.countDocuments({ ...q, isRead: false })
    ]);

    res.json({ data, total, unread, page: p, limit: l });
  } catch (err) {
    console.error('listForInfluencer error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

async function markReadForInfluencer(req, res) {
  try {
    const { id, influencerId } = req.body;
    if (!id || !influencerId) return res.status(400).json({ message: 'id and influencerId are required' });

    const doc = await Notification.findOneAndUpdate(
      { _id: id, influencerId: String(influencerId) },
      { $set: { isRead: true } },
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true, item: doc });
  } catch (err) {
    console.error('markReadForInfluencer error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

async function markAllReadForInfluencer(req, res) {
  try {
    const { influencerId } = req.body;
    if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

    await Notification.updateMany(
      { influencerId: String(influencerId), isRead: false },
      { $set: { isRead: true } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('markAllReadForInfluencer error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteForInfluencer(req, res) {
  try {
    const { id, influencerId } = req.body;
    if (!id || !influencerId) return res.status(400).json({ message: 'id and influencerId are required' });
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid id' });

    const doc = await Notification.findOneAndDelete({ _id: id, influencerId: String(influencerId) }).lean();
    if (!doc) return res.status(404).json({ message: 'Not found' });

    res.json({ ok: true, deletedId: id, previous: doc });
  } catch (err) {
    console.error('deleteForInfluencer error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

// -------------------------
// ADMIN (NEW)
// -------------------------
async function listForAdmin(req, res) {
  try {
    const { adminId, page = 1, limit = 20 } = req.query;
    if (!adminId) return res.status(400).json({ message: "adminId is required" });

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));

    const ids = new Set([String(adminId)]);

    if (mongoose.Types.ObjectId.isValid(adminId)) {
      const adminDoc = await Admin.findById(adminId, "adminId").lean();
      if (adminDoc?.adminId) ids.add(String(adminDoc.adminId));
    }

    const q = { adminId: { $in: Array.from(ids) } };

    const [data, total, unread] = await Promise.all([
      Notification.find(q).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Notification.countDocuments(q),
      Notification.countDocuments({ ...q, isRead: false }),
    ]);

    res.json({ data, total, unread, page: p, limit: l });
  } catch (err) {
    console.error("listForAdmin error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
}

async function markReadForAdmin(req, res) {
  try {
    const { id, adminId } = req.body;
    if (!id || !adminId) return res.status(400).json({ message: 'id and adminId are required' });

    const doc = await Notification.findOneAndUpdate(
      { _id: id, adminId: String(adminId) },
      { $set: { isRead: true } },
      { new: true }
    ).lean();

    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true, item: doc });
  } catch (err) {
    console.error('markReadForAdmin error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

async function markAllReadForAdmin(req, res) {
  try {
    const { adminId } = req.body;
    if (!adminId) return res.status(400).json({ message: 'adminId is required' });

    await Notification.updateMany(
      { adminId: String(adminId), isRead: false },
      { $set: { isRead: true } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('markAllReadForAdmin error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteForAdmin(req, res) {
  try {
    const { id, adminId } = req.body;
    if (!id || !adminId) return res.status(400).json({ message: 'id and adminId are required' });
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid id' });

    const doc = await Notification.findOneAndDelete({ _id: id, adminId: String(adminId) }).lean();
    if (!doc) return res.status(404).json({ message: 'Not found' });

    res.json({ ok: true, deletedId: id, previous: doc });
  } catch (err) {
    console.error('deleteForAdmin error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  // brand
  listForBrand,
  markReadForBrand,
  markAllReadForBrand,
  deleteForBrand,

  // influencer
  listForInfluencer,
  markReadForInfluencer,
  markAllReadForInfluencer,
  deleteForInfluencer,

  // admin (new)
  listForAdmin,
  markReadForAdmin,
  markAllReadForAdmin,
  deleteForAdmin,
};