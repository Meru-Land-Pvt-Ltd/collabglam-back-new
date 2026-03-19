const { Server } = require("socket.io");
const { WebSocketServer, WebSocket } = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const ChatRoom = require(path.join(__dirname, "..", "models", "chat"));
const GroupChat = require(path.join(__dirname, "..", "models", "groupChat"));

// Keep socket.io for app-wide notifications and room events
let io;

// Native WS for legacy/raw frontend
let wss;

// roomKey -> Set<WebSocket>
const wsRooms = new Map();

/* =========================================================
   ROOM KEY HELPERS
========================================================= */
function chatRoomKey(roomId) {
  return `chat:${roomId}`;
}

function groupChatRoomKey(groupId) {
  return `groupchat:${groupId}`;
}

function brandRoomKey(brandId) {
  return `brand:${brandId}`;
}

function influencerRoomKey(influencerId) {
  return `influencer:${influencerId}`;
}

function adminRoomKey(adminId) {
  return `admin:${adminId}`;
}

/* =========================================================
   WS HELPERS
========================================================= */
function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (_) {}
}

function wsJoin(ws, roomKey) {
  if (!roomKey) return;

  let set = wsRooms.get(roomKey);
  if (!set) {
    set = new Set();
    wsRooms.set(roomKey, set);
  }

  set.add(ws);

  if (!ws._rooms) {
    ws._rooms = new Set();
  }
  ws._rooms.add(roomKey);
}

function wsLeave(ws, roomKey) {
  if (!roomKey || !ws?._rooms?.has(roomKey)) return;

  const set = wsRooms.get(roomKey);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      wsRooms.delete(roomKey);
    }
  }

  ws._rooms.delete(roomKey);
}

function wsLeaveAll(ws) {
  if (!ws?._rooms) return;

  for (const roomKey of ws._rooms) {
    const set = wsRooms.get(roomKey);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        wsRooms.delete(roomKey);
      }
    }
  }

  ws._rooms.clear();
}

function broadcastToWsRoom(roomKey, payload, excludeWs = null) {
  const set = wsRooms.get(roomKey);
  if (!set || set.size === 0) return;

  for (const client of set) {
    if (excludeWs && client === excludeWs) continue;
    safeSend(client, payload);
  }
}

/* =========================================================
   GENERIC HELPERS
========================================================= */
function isChatParticipant(room, senderId) {
  return (room?.participants || []).some(
    (p) => String(p.userId) === String(senderId)
  );
}

function isGroupParticipant(group, senderId) {
  return (group?.participants || []).some(
    (p) => String(p.adminId) === String(senderId)
  );
}

function makeChatReplySnapshot(room, replyTo) {
  if (!replyTo) return null;

  const target = (room.messages || []).find((m) => m.messageId === replyTo);
  if (!target) return null;

  const firstAttachment = target.attachments?.[0];

  return {
    messageId: target.messageId,
    senderId: target.senderId,
    text: (target.text || "").slice(0, 200),
    hasAttachment: !!firstAttachment,
    attachment: firstAttachment
      ? {
          originalName: firstAttachment.originalName,
          mimeType: firstAttachment.mimeType,
        }
      : undefined,
  };
}

function makeGroupReplySnapshot(group, replyTo) {
  if (!replyTo) return null;

  const target = (group.messages || []).find((m) => m.messageId === replyTo);
  if (!target) return null;

  const firstAttachment = target.attachments?.[0];

  return {
    messageId: target.messageId,
    senderId: target.senderId,
    text: (target.text || "").slice(0, 200),
    hasAttachment: !!firstAttachment,
    attachment: firstAttachment
      ? {
          originalName: firstAttachment.originalName,
          mimeType: firstAttachment.mimeType,
        }
      : undefined,
  };
}

/* =========================================================
   PUBLIC BROADCASTERS
========================================================= */
function broadcastToChatRoom(roomId, event, payload) {
  const roomKey = chatRoomKey(roomId);

  if (io) {
    io.to(roomKey).emit(event, payload);
  }

  broadcastToWsRoom(roomKey, {
    ...(typeof payload === "object" && payload !== null ? payload : { payload }),
    type: event,
    roomId,
  });
}

function broadcastToGroupChatRoom(groupId, event, payload) {
  const roomKey = groupChatRoomKey(groupId);

  if (io) {
    io.to(roomKey).emit(event, payload);
  }

  broadcastToWsRoom(roomKey, {
    ...(typeof payload === "object" && payload !== null ? payload : { payload }),
    type: event,
    groupId,
  });
}

/**
 * Back-compat helper:
 * app.get("broadcastToRoom")(roomId, jsonStringOrObject)
 */
function legacyBroadcastToRoom(roomId, payloadMaybeString) {
  let payload = payloadMaybeString;

  try {
    payload =
      typeof payloadMaybeString === "string"
        ? JSON.parse(payloadMaybeString)
        : payloadMaybeString;
  } catch (_) {}

  if (payload && payload.type) {
    broadcastToChatRoom(roomId, payload.type, payload);
  } else {
    broadcastToChatRoom(roomId, "message", payload);
  }
}

function emitToBrand(brandId, event, payload) {
  if (!brandId || !io) return;
  io.to(brandRoomKey(brandId)).emit(event, payload);
}

function emitToInfluencer(influencerId, event, payload) {
  if (!influencerId || !io) return;
  io.to(influencerRoomKey(influencerId)).emit(event, payload);
}

function emitToAdmin(adminId, event, payload) {
  if (!adminId || !io) return;
  io.to(adminRoomKey(adminId)).emit(event, payload);
}

/* =========================================================
   SOCKET.IO SETUP
========================================================= */
function registerSocketIoHandlers(socket) {
  // identity / notification rooms
  socket.on("join", ({ brandId, influencerId, adminId } = {}) => {
    try {
      if (brandId) socket.join(brandRoomKey(brandId));
      if (influencerId) socket.join(influencerRoomKey(influencerId));
      if (adminId) socket.join(adminRoomKey(adminId));
    } catch (_) {}
  });

  // one-to-one chat room
  socket.on("joinChat", ({ roomId } = {}) => {
    if (!roomId) return;

    socket.join(chatRoomKey(roomId));
    socket.emit("joined", { roomId });
  });

  socket.on("typing", ({ roomId, senderId, isTyping } = {}) => {
    if (!roomId || !senderId) return;

    io.to(chatRoomKey(roomId)).emit("typing", {
      roomId,
      senderId,
      isTyping: !!isTyping,
    });
  });

  // group chat room
  socket.on("joinGroupChat", ({ groupId } = {}) => {
    if (!groupId) return;

    socket.join(groupChatRoomKey(groupId));
    socket.emit("groupJoined", { groupId });
  });

  socket.on("groupTyping", ({ groupId, senderId, isTyping } = {}) => {
    if (!groupId || !senderId) return;

    io.to(groupChatRoomKey(groupId)).emit("groupTyping", {
      groupId,
      senderId,
      isTyping: !!isTyping,
    });
  });

  socket.on("disconnect", () => {});
}

/* =========================================================
   RAW WS SETUP
========================================================= */
async function handleWsJoinChat(ws, data) {
  if (!data?.roomId) return false;

  wsJoin(ws, chatRoomKey(data.roomId));
  safeSend(ws, { type: "joined", roomId: data.roomId });
  return true;
}

async function handleWsTyping(ws, data) {
  if (!data?.roomId || !data?.senderId) return false;

  const payload = {
    type: "typing",
    roomId: data.roomId,
    senderId: data.senderId,
    isTyping: !!data.isTyping,
  };

  if (io) {
    io.to(chatRoomKey(data.roomId)).emit("typing", {
      roomId: data.roomId,
      senderId: data.senderId,
      isTyping: !!data.isTyping,
    });
  }

  broadcastToWsRoom(chatRoomKey(data.roomId), payload, ws);
  return true;
}

async function handleWsSendChatMessage(data) {
  if (data?.type !== "sendChatMessage") return false;

  try {
    const {
      roomId,
      senderId,
      text = "",
      replyTo = null,
      attachments = [],
    } = data;

    if (!roomId || !senderId || (!text && attachments.length === 0)) {
      return true;
    }

    const room = await ChatRoom.findOne({ roomId });
    if (!room) return true;

    if (!isChatParticipant(room, senderId)) return true;

    const reply = makeChatReplySnapshot(room, replyTo);

    const msg = {
      messageId: uuidv4(),
      senderId,
      text,
      timestamp: new Date(),
      replyTo: replyTo || null,
      reply,
      attachments: attachments || [],
      seenBy: [String(senderId)],
    };

    room.messages.push(msg);
    await room.save();

    broadcastToChatRoom(roomId, "chatMessage", { roomId, message: msg });
  } catch (_) {}

  return true;
}

async function handleWsJoinGroupChat(ws, data) {
  if (data?.type !== "joinGroupChat" || !data?.groupId) return false;

  wsJoin(ws, groupChatRoomKey(data.groupId));
  safeSend(ws, { type: "groupJoined", groupId: data.groupId });
  return true;
}

async function handleWsGroupTyping(ws, data) {
  if (data?.type !== "groupTyping" || !data?.groupId || !data?.senderId) {
    return false;
  }

  const payload = {
    type: "groupTyping",
    groupId: data.groupId,
    senderId: data.senderId,
    isTyping: !!data.isTyping,
  };

  if (io) {
    io.to(groupChatRoomKey(data.groupId)).emit("groupTyping", {
      groupId: data.groupId,
      senderId: data.senderId,
      isTyping: !!data.isTyping,
    });
  }

  broadcastToWsRoom(groupChatRoomKey(data.groupId), payload, ws);
  return true;
}

async function handleWsSendGroupChatMessage(data) {
  if (data?.type !== "sendGroupChatMessage") return false;

  try {
    const {
      groupId,
      senderId,
      text = "",
      replyTo = null,
      attachments = [],
    } = data;

    if (!groupId || !senderId || (!text && attachments.length === 0)) {
      return true;
    }

    const group = await GroupChat.findOne({ groupId, isActive: true });
    if (!group) return true;

    if (!isGroupParticipant(group, senderId)) return true;

    const reply = makeGroupReplySnapshot(group, replyTo);

    const msg = {
      messageId: uuidv4(),
      senderId,
      text,
      timestamp: new Date(),
      replyTo: replyTo || null,
      reply,
      attachments: attachments || [],
      seenBy: [String(senderId)],
    };

    group.messages.push(msg);
    group.lastMessageAt = msg.timestamp;
    await group.save();

    broadcastToGroupChatRoom(groupId, "groupChatMessage", {
      groupId,
      message: msg,
    });
  } catch (_) {}

  return true;
}

async function registerNativeWsHandlers(ws) {
  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch (_) {
      return;
    }

    if (await handleWsJoinChat(ws, data)) return;
    if (await handleWsTyping(ws, data)) return;
    if (await handleWsSendChatMessage(data)) return;

    if (await handleWsJoinGroupChat(ws, data)) return;
    if (await handleWsGroupTyping(ws, data)) return;
    if (await handleWsSendGroupChatMessage(data)) return;
  });

  ws.on("close", () => {
    wsLeaveAll(ws);
  });
}

/* =========================================================
   INIT
========================================================= */
function init(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_ORIGIN || "*",
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    registerSocketIoHandlers(socket);
  });

  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    registerNativeWsHandlers(ws);
  });

  return io;
}

module.exports = {
  init,
  emitToAdmin,
  emitToBrand,
  emitToInfluencer,
  broadcastToChatRoom,
  broadcastToGroupChatRoom,
  legacyBroadcastToRoom,
  getIO() {
    if (!io) throw new Error("Socket.io not initialized yet.");
    return io;
  },
};