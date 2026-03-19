// controllers/groupChatController.js
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const multer = require("multer");
const mongoose = require("mongoose");
const mime = require("mime-types");

const { uploadToGridFS, deleteGridFsFiles } = require("../utils/gridfs");
const GroupChat = require("../models/groupChat");
const { AdminModel, ROLES } = require("../models/master");

const GRIDFS_BUCKET = process.env.GRIDFS_BUCKET || "uploads";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

/* =========================================================
   BASIC HELPERS
========================================================= */
function sameId(a, b) {
  return String(a) === String(b);
}

function guessType(name, fallback = "application/octet-stream") {
  return mime.lookup(name) || fallback;
}

function buildPublicFileUrl(filename) {
  return `/file/${encodeURIComponent(filename)}`;
}

function isInlineType(ct) {
  if (!ct) return false;
  const t = String(ct).toLowerCase();
  return t.startsWith("image/") || t === "application/pdf";
}

function contentDispositionInline(filename, asAttachment) {
  const safe = encodeURIComponent(filename || "file");
  return `${asAttachment ? "attachment" : "inline"}; filename*=UTF-8''${safe}`;
}

function sortParticipants(a, b) {
  return String(a.name || "").localeCompare(String(b.name || ""));
}

function isAdminInGroup(group, adminId) {
  return (group.participants || []).some((p) => sameId(p.adminId, adminId));
}

function getParticipant(group, adminId) {
  return (group.participants || []).find((p) => sameId(p.adminId, adminId)) || null;
}

function toParticipant(adminDoc, addedBy = null, existing = null) {
  return {
    adminId: String(adminDoc._id),
    name: adminDoc.name || adminDoc.email,
    email: adminDoc.email,
    role: adminDoc.role,
    addedBy: addedBy ? String(addedBy) : existing?.addedBy || null,
    joinedAt: existing?.joinedAt || new Date(),
  };
}

function dedupeParticipants(participants = []) {
  const map = new Map();
  for (const p of participants) {
    map.set(String(p.adminId), p);
  }
  return Array.from(map.values()).sort(sortParticipants);
}

function buildGroupSummary(group, adminId) {
  const messages = group.messages || [];
  const last = messages[messages.length - 1] || null;

  const unseenCount = messages.filter(
    (msg) =>
      !sameId(msg.senderId, adminId) &&
      !(msg.seenBy || []).includes(String(adminId))
  ).length;

  return {
    groupId: group.groupId,
    groupName: group.groupName,
    description: group.description || "",
    createdBy: group.createdBy,
    revenueHeadId: group.revenueHeadId || null,
    participants: group.participants || [],
    lastMessage: last,
    lastMessageAt: group.lastMessageAt || null,
    unseenCount,
    isActive: group.isActive,
    updatedAt: group.updatedAt,
    createdAt: group.createdAt,
  };
}

function broadcastGroup(app, groupId, payloadObj) {
  const fn = app.get("broadcastToGroupChatRoom");

  if (typeof fn === "function") {
    if (payloadObj && payloadObj.type) {
      fn(groupId, payloadObj.type, payloadObj);
    } else {
      fn(groupId, "message", payloadObj);
    }
  }
}

function emitToAdmins(app, participants, event, payload) {
  const emitToAdmin = app.get("emitToAdmin");
  if (typeof emitToAdmin !== "function") return;

  for (const p of participants || []) {
    emitToAdmin(String(p.adminId), event, payload);
  }
}

/* =========================================================
   GRIDFS HELPERS
========================================================= */
function getBucket() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB connection not ready");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: GRIDFS_BUCKET });
}

async function findGridFileByFilename(filename) {
  const db = mongoose.connection.db;
  return db.collection(`${GRIDFS_BUCKET}.files`).findOne({ filename });
}

async function saveFilesToGridFS(files = [], req) {
  if (!Array.isArray(files) || files.length === 0) return [];
  return uploadToGridFS(files, {
    prefix: "groupchat",
    metadata: { kind: "group_chat_attachment" },
    req,
  });
}

async function streamGridFsByFilename(req, res, filename, opts = {}) {
  const bucket = getBucket();
  const fileDoc = await findGridFileByFilename(filename);

  if (!fileDoc) {
    return res.status(404).json({ message: "File not found" });
  }

  const total = fileDoc.length;
  const type =
    opts.preferType ||
    fileDoc.contentType ||
    fileDoc.metadata?.mimeType ||
    guessType(fileDoc.filename);

  const forceAttachment = opts.asAttachment === true;
  const sendAsAttachment = forceAttachment ? true : !isInlineType(type);

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader(
    "Content-Disposition",
    contentDispositionInline(opts.downloadName || fileDoc.filename, sendAsAttachment)
  );

  const range = req.headers.range;
  if (range) {
    const m = String(range).match(/bytes=(\d*)-(\d*)/);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;

      if (isNaN(start) || isNaN(end) || start > end || start >= total) {
        return res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
      }

      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", String(end - start + 1));

      const stream = bucket.openDownloadStreamByName(fileDoc.filename, {
        start,
        end: end + 1,
      });

      stream.on("error", () => res.end());
      return stream.pipe(res);
    }
  }

  res.setHeader("Content-Length", String(total));
  const stream = bucket.openDownloadStreamByName(fileDoc.filename);
  stream.on("error", () => res.end());
  return stream.pipe(res);
}

/* =========================================================
   GROUP / ROLE HELPERS
========================================================= */
async function findActiveAdminById(adminId, select = "_id name email role rootAdmin parentAdmin") {
  return AdminModel.findOne({
    _id: adminId,
    status: "active",
  }).select(select);
}

async function resolveCreatorAndRevenueHead({ creatorId, revenueHeadId }) {
  const creator = await AdminModel.findOne({
    _id: creatorId,
    role: { $in: [ROLES.SUPER_ADMIN, ROLES.REVENUE_HEAD] },
    status: "active",
  }).select("_id name email role rootAdmin");

  if (!creator) {
    return {
      error: {
        status: 403,
        message: "Only active super_admin or revenue_head can create group chat",
      },
    };
  }

  if (creator.role === ROLES.REVENUE_HEAD) {
    if (revenueHeadId && !sameId(revenueHeadId, creator._id)) {
      return {
        error: {
          status: 403,
          message: "Revenue head can create group only under themselves",
        },
      };
    }

    return { creator, revenueHead: creator };
  }

  if (!revenueHeadId) {
    return {
      error: {
        status: 400,
        message: "revenueHeadId is required when super_admin creates a group",
      },
    };
  }

  const revenueHead = await AdminModel.findOne({
    _id: revenueHeadId,
    role: ROLES.REVENUE_HEAD,
    status: "active",
    rootAdmin: creator._id,
  }).select("_id name email role rootAdmin");

  if (!revenueHead) {
    return {
      error: {
        status: 404,
        message: "Selected revenue head not found under this super admin",
      },
    };
  }

  return { creator, revenueHead };
}

async function resolveAutoSuperAdmins(revenueHeadDoc) {
  if (revenueHeadDoc.rootAdmin) {
    const rootSuperAdmin = await AdminModel.findOne({
      _id: revenueHeadDoc.rootAdmin,
      role: ROLES.SUPER_ADMIN,
      status: "active",
    }).select("_id name email role");

    if (rootSuperAdmin) return [rootSuperAdmin];
  }

  return AdminModel.find({
    role: ROLES.SUPER_ADMIN,
    status: "active",
  }).select("_id name email role");
}

async function ensureRevenueHeadId(group) {
  if (group.revenueHeadId) return String(group.revenueHeadId);

  const participantRevenueHead = (group.participants || []).find(
    (p) => p.role === ROLES.REVENUE_HEAD
  );

  if (participantRevenueHead?.adminId) {
    group.revenueHeadId = String(participantRevenueHead.adminId);
    return String(group.revenueHeadId);
  }

  const creator = await AdminModel.findById(group.createdBy).select(
    "_id role parentAdmin"
  );

  if (creator) {
    if (creator.role === ROLES.REVENUE_HEAD) {
      group.revenueHeadId = String(creator._id);
      return String(group.revenueHeadId);
    }

    if (
      (creator.role === ROLES.BME || creator.role === ROLES.IME) &&
      creator.parentAdmin
    ) {
      group.revenueHeadId = String(creator.parentAdmin);
      return String(group.revenueHeadId);
    }
  }

  const firstExecutionMember = (group.participants || []).find(
    (p) => p.role === ROLES.BME || p.role === ROLES.IME
  );

  if (firstExecutionMember?.adminId) {
    const memberDoc = await AdminModel.findById(firstExecutionMember.adminId).select(
      "_id parentAdmin"
    );

    if (memberDoc?.parentAdmin) {
      group.revenueHeadId = String(memberDoc.parentAdmin);
      return String(group.revenueHeadId);
    }
  }

  throw new Error("Unable to derive revenueHeadId for this group");
}

async function getEffectiveRevenueHeadDoc(group) {
  const revenueHeadId = await ensureRevenueHeadId(group);

  const revenueHead = await AdminModel.findOne({
    _id: revenueHeadId,
    role: ROLES.REVENUE_HEAD,
    status: "active",
  }).select("_id name email role rootAdmin");

  if (!revenueHead) {
    throw new Error("Selected revenue head not found or inactive");
  }

  return revenueHead;
}

async function getCreatorDoc(group) {
  const creator = await AdminModel.findOne({
    _id: group.createdBy,
    status: "active",
  }).select("_id name email role rootAdmin");

  if (!creator) {
    throw new Error("Group creator not found or inactive");
  }

  return creator;
}

async function validateAndLoadSelectedMembers(memberIds, revenueHeadId) {
  const uniqueSelectedIds = [...new Set((memberIds || []).map(String))]
    .filter(Boolean)
    .filter((id) => !sameId(id, revenueHeadId));

  const selectedMembers = await AdminModel.find({
    _id: { $in: uniqueSelectedIds },
    parentAdmin: revenueHeadId,
    role: { $in: [ROLES.BME, ROLES.IME] },
    status: "active",
  }).select("_id name email role");

  if (selectedMembers.length !== uniqueSelectedIds.length) {
    throw new Error(
      "All selected members must be active IME/BME admins under selected revenue head"
    );
  }

  return selectedMembers;
}

async function rebuildParticipants({
  group,
  creatorDoc,
  revenueHeadDoc,
  selectedMemberIds,
  addedBy,
}) {
  const selectedMembers = await validateAndLoadSelectedMembers(
    selectedMemberIds,
    String(revenueHeadDoc._id)
  );

  const autoSuperAdmins = await resolveAutoSuperAdmins(revenueHeadDoc);
  const existingMap = new Map(
    (group.participants || []).map((p) => [String(p.adminId), p])
  );

  return dedupeParticipants([
    toParticipant(creatorDoc, addedBy, existingMap.get(String(creatorDoc._id))),
    toParticipant(revenueHeadDoc, addedBy, existingMap.get(String(revenueHeadDoc._id))),
    ...selectedMembers.map((m) =>
      toParticipant(m, addedBy, existingMap.get(String(m._id)))
    ),
    ...autoSuperAdmins.map((m) =>
      toParticipant(m, addedBy, existingMap.get(String(m._id)))
    ),
  ]);
}

function getCurrentManagedMemberIds(group) {
  const revenueHeadId = String(group.revenueHeadId || "");
  const creatorId = String(group.createdBy || "");

  return (group.participants || [])
    .filter(
      (p) =>
        !sameId(p.adminId, creatorId) &&
        !sameId(p.adminId, revenueHeadId) &&
        p.role !== ROLES.SUPER_ADMIN &&
        [ROLES.IME, ROLES.BME].includes(p.role)
    )
    .map((p) => String(p.adminId));
}

async function assertCanManageGroup(group, adminId) {
  const actingAdmin = await findActiveAdminById(adminId);

  if (!actingAdmin) {
    return {
      error: { status: 403, message: "Admin not found or inactive" },
    };
  }

  await ensureRevenueHeadId(group);

  if (actingAdmin.role === ROLES.SUPER_ADMIN) {
    const revenueHead = await getEffectiveRevenueHeadDoc(group);

    if (
      revenueHead.rootAdmin &&
      !sameId(revenueHead.rootAdmin, actingAdmin._id) &&
      !(group.participants || []).some(
        (p) => p.role === ROLES.SUPER_ADMIN && sameId(p.adminId, actingAdmin._id)
      )
    ) {
      return {
        error: {
          status: 403,
          message: "Super admin cannot manage groups outside their revenue head tree",
        },
      };
    }

    return { actingAdmin, revenueHead };
  }

  if (
    actingAdmin.role === ROLES.REVENUE_HEAD &&
    sameId(group.revenueHeadId, actingAdmin._id)
  ) {
    return { actingAdmin, revenueHead: actingAdmin };
  }

  return {
    error: {
      status: 403,
      message:
        "Only the group's revenue_head or a super_admin can manage participants",
    },
  };
}

/* =========================================================
   REPLY HELPER
========================================================= */
function makeReplySnapshot(group, replyTo) {
  if (!replyTo) return null;
  const target = (group.messages || []).find((m) => m.messageId === replyTo);
  if (!target) return null;

  const firstAtt = target.attachments?.[0];
  return {
    messageId: target.messageId,
    senderId: String(target.senderId),
    text: (target.text || "").slice(0, 200),
    hasAttachment: !!firstAtt,
    attachment: firstAtt
      ? {
          originalName: firstAtt.originalName,
          mimeType: firstAtt.mimeType,
        }
      : undefined,
  };
}

/* =========================================================
   1) CREATE GROUP
========================================================= */
exports.createGroup = async (req, res) => {
  try {
    const {
      creatorId,
      revenueHeadId,
      groupName,
      description = "",
      memberIds = [],
    } = req.body;

    if (!creatorId || !groupName) {
      return res.status(400).json({
        message: "creatorId and groupName are required",
      });
    }

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({
        message: "memberIds is required and must contain selected IME/BME admins",
      });
    }

    const resolved = await resolveCreatorAndRevenueHead({
      creatorId,
      revenueHeadId,
    });

    if (resolved.error) {
      return res.status(resolved.error.status).json({
        message: resolved.error.message,
      });
    }

    const { creator, revenueHead } = resolved;

    const selectedMembers = await validateAndLoadSelectedMembers(
      memberIds,
      String(revenueHead._id)
    );

    const autoSuperAdmins = await resolveAutoSuperAdmins(revenueHead);

    const participants = dedupeParticipants([
      toParticipant(creator, creator._id),
      toParticipant(revenueHead, creator._id),
      ...selectedMembers.map((m) => toParticipant(m, creator._id)),
      ...autoSuperAdmins.map((m) => toParticipant(m, creator._id)),
    ]);

    const group = await GroupChat.create({
      groupName: groupName.trim(),
      description,
      createdBy: String(creator._id),
      revenueHeadId: String(revenueHead._id),
      participants,
      messages: [],
      lastMessageAt: null,
      isActive: true,
    });

    emitToAdmins(req.app, participants, "groupChatCreated", {
      group: buildGroupSummary(group.toObject(), String(creator._id)),
    });

    return res.status(201).json({
      message: "Group chat created successfully",
      group,
    });
  } catch (err) {
    console.error("createGroup error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   2) UPDATE GROUP
   Revenue head or super admin can add/remove BME/IME only
========================================================= */
exports.updateGroup = async (req, res) => {
  try {
    const {
      groupId,
      adminId,
      groupName,
      description,
      memberIds,
      revenueHeadId,
    } = req.body;

    if (!groupId || !adminId) {
      return res.status(400).json({
        message: "groupId and adminId are required",
      });
    }

    const group = await GroupChat.findOne({ groupId, isActive: true });
    if (!group) {
      return res.status(404).json({ message: "Group chat not found" });
    }

    const access = await assertCanManageGroup(group, adminId);
    if (access.error) {
      return res.status(access.error.status).json({
        message: access.error.message,
      });
    }

    const { actingAdmin } = access;

    await ensureRevenueHeadId(group);

    let effectiveRevenueHeadDoc = await getEffectiveRevenueHeadDoc(group);
    const creatorDoc = await getCreatorDoc(group);

    // Only super admin may shift the group to another revenue head
    if (
      actingAdmin.role === ROLES.SUPER_ADMIN &&
      revenueHeadId &&
      !sameId(revenueHeadId, effectiveRevenueHeadDoc._id)
    ) {
      const newRevenueHead = await AdminModel.findOne({
        _id: revenueHeadId,
        role: ROLES.REVENUE_HEAD,
        status: "active",
        rootAdmin: actingAdmin._id,
      }).select("_id name email role rootAdmin");

      if (!newRevenueHead) {
        return res.status(404).json({
          message: "Selected revenue head not found under this super admin",
        });
      }

      effectiveRevenueHeadDoc = newRevenueHead;
      group.revenueHeadId = String(newRevenueHead._id);
    }

    // Revenue head may only manage their own group tree
    if (
      actingAdmin.role === ROLES.REVENUE_HEAD &&
      !sameId(effectiveRevenueHeadDoc._id, actingAdmin._id)
    ) {
      return res.status(403).json({
        message: "Revenue head can manage participants only for their own group",
      });
    }

    if (typeof groupName === "string" && groupName.trim()) {
      group.groupName = groupName.trim();
    }

    if (typeof description === "string") {
      group.description = description;
    }

    if (Array.isArray(memberIds)) {
      group.participants = await rebuildParticipants({
        group,
        creatorDoc,
        revenueHeadDoc: effectiveRevenueHeadDoc,
        selectedMemberIds: memberIds,
        addedBy: adminId,
      });
    }

    await ensureRevenueHeadId(group);
    await group.save();

    const groupPayload = {
      groupId: group.groupId,
      groupName: group.groupName,
      description: group.description,
      revenueHeadId: group.revenueHeadId,
      participants: group.participants,
    };

    broadcastGroup(req.app, group.groupId, {
      type: "groupChatUpdated",
      groupId: group.groupId,
      group: groupPayload,
    });

    emitToAdmins(req.app, group.participants, "groupChatUpdated", {
      group: groupPayload,
    });

    return res.json({
      message: "Group chat updated successfully",
      group,
    });
  } catch (err) {
    console.error("updateGroup error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   3) GET MY GROUPS
========================================================= */
exports.getMyGroups = async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!adminId) {
      return res.status(400).json({ message: "adminId is required" });
    }

    const groups = await GroupChat.find({
      isActive: true,
      "participants.adminId": String(adminId),
    })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .lean();

    return res.json({
      message: "Group chats fetched successfully",
      groups: groups.map((group) => buildGroupSummary(group, String(adminId))),
    });
  } catch (err) {
    console.error("getMyGroups error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   4) GET GROUP MESSAGES
========================================================= */
exports.getMessages = async (req, res) => {
  try {
    const { groupId, adminId, limit = 50, before } = req.body;

    if (!groupId || !adminId) {
      return res.status(400).json({
        message: "groupId and adminId are required",
      });
    }

    const group = await GroupChat.findOne({ groupId, isActive: true });
    if (!group) {
      return res.status(404).json({ message: "Group chat not found" });
    }

    if (!isAdminInGroup(group, adminId)) {
      return res.status(403).json({ message: "You are not part of this group" });
    }

    let messages = group.messages || [];
    if (before) {
      const cut = new Date(before);
      messages = messages.filter((m) => m.timestamp < cut);
    }

    messages = messages.slice(-Math.max(1, parseInt(limit, 10)));

    return res.json({
      message: "Messages fetched successfully",
      group: {
        groupId: group.groupId,
        groupName: group.groupName,
        description: group.description,
        revenueHeadId: group.revenueHeadId || null,
        participants: group.participants,
      },
      messages,
    });
  } catch (err) {
    console.error("getMessages error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   5) SEND TEXT MESSAGE
========================================================= */
exports.postMessage = async (req, res) => {
  try {
    const { groupId, senderId, text = "", replyTo, attachments = [] } = req.body;

    if (!groupId || !senderId || (!text && (!attachments || attachments.length === 0))) {
      return res.status(400).json({
        message: "groupId, senderId and (text or attachments) are required",
      });
    }

    const group = await GroupChat.findOne({ groupId, isActive: true });
    if (!group) {
      return res.status(404).json({ message: "Group chat not found" });
    }

    if (!isAdminInGroup(group, senderId)) {
      return res.status(403).json({ message: "Sender is not part of this group" });
    }

    const reply = makeReplySnapshot(group, replyTo);

    const normalized = Array.isArray(attachments)
      ? attachments.map((a) => ({
          attachmentId: uuidv4(),
          url: a.url,
          path: a.path || null,
          originalName: a.originalName || "file",
          mimeType: a.mimeType || "application/octet-stream",
          size: Number(a.size || 0),
          width: a.width || null,
          height: a.height || null,
          duration: a.duration || null,
          thumbnailUrl: a.thumbnailUrl || null,
          storage: a.storage || "remote",
          gridfsFilename: a.gridfsFilename || null,
          gridfsId: a.gridfsId || null,
        }))
      : [];

    const msg = {
      messageId: uuidv4(),
      senderId: String(senderId),
      text,
      timestamp: new Date(),
      replyTo: replyTo || null,
      reply,
      attachments: normalized,
      seenBy: [String(senderId)],
    };

    group.messages.push(msg);
    group.lastMessageAt = msg.timestamp;

    await ensureRevenueHeadId(group);
    await group.save();

    broadcastGroup(req.app, group.groupId, {
      type: "groupChatMessage",
      groupId: group.groupId,
      message: msg,
    });

    emitToAdmins(req.app, group.participants, "groupChatSidebarRefresh", {
      groupId: group.groupId,
      lastMessage: msg,
      lastMessageAt: group.lastMessageAt,
    });

    return res.status(201).json({
      message: "Message sent successfully",
      messageData: msg,
    });
  } catch (err) {
    console.error("postMessage error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   6) SEND FILE MESSAGE
========================================================= */
exports.postFileMessage = [
  upload.array("files", 10),
  async (req, res) => {
    try {
      const { groupId, senderId, text = "", replyTo } = req.body;

      if (!groupId || !senderId) {
        return res.status(400).json({
          message: "groupId and senderId are required",
        });
      }

      const group = await GroupChat.findOne({ groupId, isActive: true });
      if (!group) {
        return res.status(404).json({ message: "Group chat not found" });
      }

      if (!isAdminInGroup(group, senderId)) {
        return res.status(403).json({ message: "Sender is not part of this group" });
      }

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0 && !text) {
        return res.status(400).json({ message: "Provide at least one file or text" });
      }

      const saved = await saveFilesToGridFS(files, req);

      const attachments = saved.map((s) => ({
        attachmentId: uuidv4(),
        url: buildPublicFileUrl(s.filename),
        originalName: s.originalName || "file",
        mimeType: s.mimeType || guessType(s.filename),
        size: s.size || 0,
        width: null,
        height: null,
        duration: null,
        thumbnailUrl: null,
        storage: "gridfs",
        gridfsFilename: s.filename,
        gridfsId: s.id,
      }));

      const reply = makeReplySnapshot(group, replyTo);

      const msg = {
        messageId: uuidv4(),
        senderId: String(senderId),
        text,
        timestamp: new Date(),
        replyTo: replyTo || null,
        reply,
        attachments,
        seenBy: [String(senderId)],
      };

      group.messages.push(msg);
      group.lastMessageAt = msg.timestamp;

      await ensureRevenueHeadId(group);
      await group.save();

      broadcastGroup(req.app, group.groupId, {
        type: "groupChatMessage",
        groupId: group.groupId,
        message: msg,
      });

      emitToAdmins(req.app, group.participants, "groupChatSidebarRefresh", {
        groupId: group.groupId,
        lastMessage: msg,
        lastMessageAt: group.lastMessageAt,
      });

      return res.status(201).json({
        message: "File message sent successfully",
        messageData: msg,
      });
    } catch (err) {
      console.error("postFileMessage error:", err);
      return res.status(500).json({
        message: err.message || "Internal server error",
      });
    }
  },
];

/* =========================================================
   7) EDIT MESSAGE
========================================================= */
exports.editMessage = async (req, res) => {
  try {
    const { groupId, messageId, senderId, newText } = req.body;

    if (!groupId || !messageId || !senderId || typeof newText !== "string") {
      return res.status(400).json({
        message: "groupId, messageId, senderId, newText are required",
      });
    }

    const group = await GroupChat.findOne({ groupId, isActive: true });
    if (!group) {
      return res.status(404).json({ message: "Group chat not found" });
    }

    const msg = (group.messages || []).find((m) => m.messageId === messageId);
    if (!msg) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (!sameId(msg.senderId, senderId)) {
      return res.status(403).json({ message: "You can edit only your own messages" });
    }

    msg.text = newText;
    msg.editedAt = new Date();

    await ensureRevenueHeadId(group);
    await group.save();

    broadcastGroup(req.app, group.groupId, {
      type: "groupChatMessageEdited",
      groupId: group.groupId,
      message: msg,
    });

    emitToAdmins(req.app, group.participants, "groupChatSidebarRefresh", {
      groupId: group.groupId,
      lastMessage: msg,
      lastMessageAt: group.lastMessageAt,
    });

    return res.json({
      message: "Message edited successfully",
      messageData: msg,
    });
  } catch (err) {
    console.error("editMessage error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   8) DELETE MESSAGE
========================================================= */
exports.deleteMessage = async (req, res) => {
  try {
    const { groupId, messageId, senderId } = req.body;

    if (!groupId || !messageId || !senderId) {
      return res.status(400).json({
        message: "groupId, messageId, senderId are required",
      });
    }

    const group = await GroupChat.findOne({ groupId, isActive: true });
    if (!group) {
      return res.status(404).json({ message: "Group chat not found" });
    }

    const idx = (group.messages || []).findIndex((m) => m.messageId === messageId);
    if (idx === -1) {
      return res.status(404).json({ message: "Message not found" });
    }

    const msg = group.messages[idx];
    if (!sameId(msg.senderId, senderId)) {
      return res.status(403).json({ message: "You can delete only your own messages" });
    }

    try {
      for (const att of msg.attachments || []) {
        if (att.storage === "local" && att.path) {
          fs.promises.unlink(att.path).catch(() => {});
        }
      }

      const gridIds = (msg.attachments || [])
        .filter((a) => a.storage === "gridfs" && a.gridfsId)
        .map((a) => a.gridfsId);

      if (gridIds.length) {
        await deleteGridFsFiles(gridIds);
      }
    } catch (_) {}

    group.messages.splice(idx, 1);

    await ensureRevenueHeadId(group);
    await group.save();

    broadcastGroup(req.app, group.groupId, {
      type: "groupChatMessageDeleted",
      groupId: group.groupId,
      messageId,
    });

    emitToAdmins(req.app, group.participants, "groupChatSidebarRefresh", {
      groupId: group.groupId,
      lastMessage: group.messages[group.messages.length - 1] || null,
      lastMessageAt: group.lastMessageAt,
    });

    return res.json({
      message: "Message deleted successfully",
      messageId,
    });
  } catch (err) {
    console.error("deleteMessage error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   9) MARK SEEN
========================================================= */
exports.markAsSeen = async (req, res) => {
  try {
    const { groupId, adminId, messageIds } = req.body;

    if (!groupId || !adminId) {
      return res.status(400).json({
        message: "groupId and adminId are required",
      });
    }

    const before = await GroupChat.findOne(
      { groupId, isActive: true },
      "groupId participants messages.messageId messages.senderId messages.seenBy"
    ).lean();

    if (!before) {
      return res.status(404).json({ message: "Group chat not found" });
    }

    const isParticipant = (before.participants || []).some((p) =>
      sameId(p.adminId, adminId)
    );

    if (!isParticipant) {
      return res.status(403).json({ message: "You are not part of this group" });
    }

    const alreadySeen = new Set(
      (before.messages || [])
        .filter(
          (m) =>
            !sameId(m.senderId, adminId) &&
            Array.isArray(m.seenBy) &&
            m.seenBy.includes(String(adminId))
        )
        .map((m) => m.messageId)
    );

    const elemFilter = {
      "elem.senderId": { $ne: String(adminId) },
      "elem.seenBy": { $ne: String(adminId) },
    };

    if (Array.isArray(messageIds) && messageIds.length > 0) {
      elemFilter["elem.messageId"] = { $in: messageIds };
    }

    await GroupChat.updateOne(
      { groupId, isActive: true },
      {
        $addToSet: {
          "messages.$[elem].seenBy": String(adminId),
        },
      },
      {
        arrayFilters: [elemFilter],
      }
    );

    const after = await GroupChat.findOne(
      { groupId, isActive: true },
      "groupId participants messages.messageId messages.senderId messages.seenBy"
    ).lean();

    if (!after) {
      return res.status(404).json({ message: "Group chat not found after update" });
    }

    const newlySeen = (after.messages || []).filter((m) => {
      if (sameId(m.senderId, adminId)) return false;

      const nowSeen =
        Array.isArray(m.seenBy) && m.seenBy.includes(String(adminId));
      const wasSeen = alreadySeen.has(m.messageId);
      const inFilter =
        Array.isArray(messageIds) && messageIds.length > 0
          ? messageIds.includes(m.messageId)
          : true;

      return nowSeen && !wasSeen && inFilter;
    });

    if (newlySeen.length === 0) {
      return res.json({
        message: "Messages marked as seen",
        markedCount: 0,
        updatedMessages: [],
      });
    }

    const updatedMessages = newlySeen.map((m) => ({
      messageId: m.messageId,
      seenBy: m.seenBy || [],
    }));

    const groupBroadcaster = req.app.get("broadcastToGroupChatRoom");
    if (typeof groupBroadcaster === "function") {
      groupBroadcaster(groupId, "groupChatMessagesSeen", {
        type: "groupChatMessagesSeen",
        groupId,
        adminId: String(adminId),
        messages: updatedMessages,
      });
    }

    return res.json({
      message: "Messages marked as seen",
      markedCount: updatedMessages.length,
      updatedMessages,
    });
  } catch (err) {
    console.error("markAsSeen error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   10) UNSEEN COUNT
========================================================= */
exports.getUnseenCount = async (req, res) => {
  try {
    const { groupId, adminId } = req.body;

    if (!groupId || !adminId) {
      return res.status(400).json({
        message: "groupId and adminId are required",
      });
    }

    const group = await GroupChat.findOne({ groupId, isActive: true });
    if (!group) {
      return res.status(404).json({ message: "Group chat not found" });
    }

    if (!isAdminInGroup(group, adminId)) {
      return res.status(403).json({ message: "You are not part of this group" });
    }

    const unseenCount = (group.messages || []).filter(
      (msg) =>
        !sameId(msg.senderId, adminId) &&
        !(msg.seenBy || []).includes(String(adminId))
    ).length;

    return res.json({
      message: "Unseen count fetched successfully",
      groupId,
      adminId,
      unseenCount,
    });
  } catch (err) {
    console.error("getUnseenCount error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   11) SECURE ATTACHMENT STREAM
========================================================= */
exports.streamAttachment = async (req, res) => {
  try {
    const { groupId, attachmentId } = req.params;
    const asAttachment = req.query.download === "1";
    const adminId = String(req.query.adminId || req.headers["x-admin-id"] || "");

    if (!groupId || !attachmentId) {
      return res.status(400).json({
        message: "groupId and attachmentId are required",
      });
    }

    if (!adminId) {
      return res.status(400).json({ message: "adminId is required" });
    }

    const group = await GroupChat.findOne({ groupId, isActive: true }).lean();
    if (!group) {
      return res.status(404).json({ message: "Group chat not found" });
    }

    if (!isAdminInGroup(group, adminId)) {
      return res.status(403).json({ message: "You are not part of this group" });
    }

    let targetAttachment = null;
    for (const m of group.messages || []) {
      const found = (m.attachments || []).find((a) => a.attachmentId === attachmentId);
      if (found) {
        targetAttachment = found;
        break;
      }
    }

    if (!targetAttachment) {
      return res.status(404).json({ message: "Attachment not found" });
    }

    if (targetAttachment.storage === "gridfs" && targetAttachment.gridfsFilename) {
      return streamGridFsByFilename(req, res, targetAttachment.gridfsFilename, {
        asAttachment,
        preferType:
          targetAttachment.mimeType || guessType(targetAttachment.gridfsFilename),
        downloadName:
          targetAttachment.originalName || targetAttachment.gridfsFilename,
      });
    }

    if (targetAttachment.storage === "local" && targetAttachment.path) {
      if (!fs.existsSync(targetAttachment.path)) {
        return res.status(404).json({ message: "File not found on disk" });
      }

      const type =
        targetAttachment.mimeType ||
        guessType(targetAttachment.originalName || targetAttachment.path);

      res.setHeader("Content-Type", type);
      res.setHeader(
        "Content-Disposition",
        contentDispositionInline(targetAttachment.originalName || "file", asAttachment)
      );

      return fs.createReadStream(targetAttachment.path).pipe(res);
    }

    if (targetAttachment.url) {
      return res.redirect(302, targetAttachment.url);
    }

    return res.status(500).json({ message: "Attachment is not streamable" });
  } catch (err) {
    console.error("streamAttachment error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   12) PUBLIC GRIDFS STREAM
========================================================= */
exports.streamGridFsFile = async (req, res) => {
  try {
    const filename = req.params.filename;
    const asAttachment = req.query.download === "1";

    if (!filename) {
      return res.status(400).json({ message: "filename is required" });
    }

    return streamGridFsByFilename(req, res, filename, { asAttachment });
  } catch (err) {
    console.error("streamGridFsFile error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   13) ELIGIBLE MEMBERS
   Revenue head or super admin can fetch only that revenue head's BME/IME
========================================================= */
exports.getEligibleMembers = async (req, res) => {
  try {
    const { adminId, revenueHeadId } = req.body;

    if (!adminId) {
      return res.status(400).json({ message: "adminId is required" });
    }

    const admin = await AdminModel.findOne({
      _id: adminId,
      status: "active",
    }).select("_id role");

    if (!admin) {
      return res.status(403).json({ message: "Admin not found or inactive" });
    }

    let effectiveRevenueHeadId = null;

    if (admin.role === ROLES.REVENUE_HEAD) {
      if (revenueHeadId && !sameId(revenueHeadId, admin._id)) {
        return res.status(403).json({
          message: "Revenue head can fetch members only under themselves",
        });
      }
      effectiveRevenueHeadId = String(admin._id);
    } else if (admin.role === ROLES.SUPER_ADMIN) {
      if (!revenueHeadId) {
        return res.status(400).json({
          message: "revenueHeadId is required for super_admin",
        });
      }

      const revenueHead = await AdminModel.findOne({
        _id: revenueHeadId,
        role: ROLES.REVENUE_HEAD,
        status: "active",
        rootAdmin: admin._id,
      }).select("_id");

      if (!revenueHead) {
        return res.status(404).json({
          message: "Selected revenue head not found under this super admin",
        });
      }

      effectiveRevenueHeadId = String(revenueHead._id);
    } else {
      return res.status(403).json({
        message: "Only super_admin or revenue_head can fetch eligible members",
      });
    }

    const members = await AdminModel.find({
      parentAdmin: effectiveRevenueHeadId,
      role: { $in: [ROLES.IME, ROLES.BME] },
      status: "active",
    })
      .select("_id name email role")
      .sort({ name: 1 });

    return res.json({
      message: "Eligible members fetched successfully",
      members: members.map((m) => ({
        adminId: String(m._id),
        name: m.name || m.email,
        email: m.email,
        role: m.role,
      })),
    });
  } catch (err) {
    console.error("getEligibleMembers error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   14) ELIGIBLE REVENUE HEADS
========================================================= */
exports.getEligibleRevenueHeads = async (req, res) => {
  try {
    const { adminId } = req.body;

    if (!adminId) {
      return res.status(400).json({ message: "adminId is required" });
    }

    const admin = await AdminModel.findOne({
      _id: adminId,
      status: "active",
    }).select("_id role");

    if (!admin) {
      return res.status(403).json({ message: "Admin not found or inactive" });
    }

    if (admin.role === ROLES.REVENUE_HEAD) {
      const me = await AdminModel.findOne({
        _id: adminId,
        role: ROLES.REVENUE_HEAD,
        status: "active",
      }).select("_id name email role");

      return res.json({
        message: "Eligible revenue heads fetched successfully",
        revenueHeads: me
          ? [
              {
                adminId: String(me._id),
                name: me.name || me.email,
                email: me.email,
                role: me.role,
              },
            ]
          : [],
      });
    }

    if (admin.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({
        message: "Only super_admin or revenue_head can fetch revenue heads",
      });
    }

    const revenueHeads = await AdminModel.find({
      rootAdmin: admin._id,
      role: ROLES.REVENUE_HEAD,
      status: "active",
    })
      .select("_id name email role")
      .sort({ name: 1 });

    return res.json({
      message: "Eligible revenue heads fetched successfully",
      revenueHeads: revenueHeads.map((m) => ({
        adminId: String(m._id),
        name: m.name || m.email,
        email: m.email,
        role: m.role,
      })),
    });
  } catch (err) {
    console.error("getEligibleRevenueHeads error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

/* =========================================================
   15) OPTIONAL: GET CURRENT MANAGEABLE MEMBERS FOR A GROUP
   Useful for edit modal
========================================================= */
exports.getGroupManageMeta = async (req, res) => {
  try {
    const { groupId, adminId } = req.body;

    if (!groupId || !adminId) {
      return res.status(400).json({
        message: "groupId and adminId are required",
      });
    }

    const group = await GroupChat.findOne({ groupId, isActive: true }).lean();
    if (!group) {
      return res.status(404).json({ message: "Group chat not found" });
    }

    const actingAdmin = await AdminModel.findOne({
      _id: adminId,
      status: "active",
    }).select("_id role");

    if (!actingAdmin) {
      return res.status(403).json({ message: "Admin not found or inactive" });
    }

    let revenueHead = null;

    if (actingAdmin.role === ROLES.REVENUE_HEAD) {
      if (!sameId(group.revenueHeadId, actingAdmin._id)) {
        return res.status(403).json({
          message: "Revenue head can manage only their own group",
        });
      }
      revenueHead = await AdminModel.findById(actingAdmin._id).select(
        "_id name email role"
      );
    } else if (actingAdmin.role === ROLES.SUPER_ADMIN) {
      revenueHead = await AdminModel.findOne({
        _id: group.revenueHeadId,
        role: ROLES.REVENUE_HEAD,
        status: "active",
      }).select("_id name email role");
    } else {
      return res.status(403).json({
        message: "Only super_admin or revenue_head can manage group members",
      });
    }

    if (!revenueHead) {
      return res.status(404).json({
        message: "Revenue head not found for this group",
      });
    }

    const eligibleMembers = await AdminModel.find({
      parentAdmin: revenueHead._id,
      role: { $in: [ROLES.IME, ROLES.BME] },
      status: "active",
    })
      .select("_id name email role")
      .sort({ name: 1 });

    const selectedMemberIds = getCurrentManagedMemberIds(group);

    return res.json({
      message: "Group manage meta fetched successfully",
      group: {
        groupId: group.groupId,
        groupName: group.groupName,
        description: group.description || "",
        revenueHeadId: String(revenueHead._id),
      },
      revenueHead: {
        adminId: String(revenueHead._id),
        name: revenueHead.name || revenueHead.email,
        email: revenueHead.email,
        role: revenueHead.role,
      },
      selectedMemberIds,
      eligibleMembers: eligibleMembers.map((m) => ({
        adminId: String(m._id),
        name: m.name || m.email,
        email: m.email,
        role: m.role,
      })),
    });
  } catch (err) {
    console.error("getGroupManageMeta error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};