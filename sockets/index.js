const { Server } = require('socket.io');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const ChatRoom = require(path.join(__dirname, '..', 'models', 'chat'));

// Keep socket.io for other parts of the app
let io;
// Native WS (legacy/raw) for your current frontend
let wss;

// room -> Set<WebSocket>
const wsRooms = new Map();

/** ---------- helpers (native WS) ---------- */
function wsJoin(ws, roomId) {
  if (!roomId) return;
  let set = wsRooms.get(roomId);
  if (!set) {
    set = new Set();
    wsRooms.set(roomId, set);
  }
  set.add(ws);
  ws._rooms = ws._rooms || new Set();
  ws._rooms.add(roomId);
}

function wsLeaveAll(ws) {
  if (!ws._rooms) return;
  for (const roomId of ws._rooms) {
    const set = wsRooms.get(roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) wsRooms.delete(roomId);
    }
  }
  ws._rooms.clear();
}

/** ---------- public broadcasters ---------- */
function broadcastToChatRoom(roomId, event, payload) {
  // Socket.IO
  if (io) {
    io.to(`chat:${roomId}`).emit(event, payload);
  }
  // Native WS
  const set = wsRooms.get(roomId);
  if (set && set.size) {
    const msg = JSON.stringify({
      ...(typeof payload === 'object' ? payload : { payload }),
      type: event,
      roomId
    });
    for (const client of set) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(msg); } catch (_) {}
      }
    }
  }
}

/**
 * Back-compat helper for any legacy code that used:
 *   app.get('broadcastToRoom')(roomId, jsonStringOrObject)
 * Controllers call this with payloads like { type:'chatMessage', roomId, message }
 */
function legacyBroadcastToRoom(roomId, payloadMaybeString) {
  let payload = payloadMaybeString;
  try {
    payload = typeof payloadMaybeString === 'string'
      ? JSON.parse(payloadMaybeString)
      : payloadMaybeString;
  } catch {
    // ignore parse errors; send as opaque payload
  }
  if (payload && payload.type) {
    broadcastToChatRoom(roomId, payload.type, payload);
  } else {
    broadcastToChatRoom(roomId, 'message', payload);
  }
}

function emitToBrand(brandId, event, payload) {
  if (!brandId || !io) return;
  io.to(`brand:${brandId}`).emit(event, payload);
}

function emitToInfluencer(influencerId, event, payload) {
  if (!influencerId || !io) return;
  io.to(`influencer:${influencerId}`).emit(event, payload);
}

function emitToAdmin(adminId, event, payload) {
  if (!adminId || !io) return;
  io.to(`admin:${adminId}`).emit(event, payload);
}

/** ---------- initialize both transports ---------- */
function init(server) {
  // Socket.IO (keep default path /socket.io — do NOT set to /ws)
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_ORIGIN || '*',
      credentials: true,
    },
    // path: '/socket.io' // default
  });

  io.on('connection', (socket) => {
    // identity/notification rooms
    socket.on('join', ({ brandId, influencerId } = {}) => {
      try {
        if (brandId) socket.join(`brand:${brandId}`);
        if (influencerId) socket.join(`influencer:${influencerId}`);
        if (adminId) socket.join(`admin:${adminId}`);
      } catch (_) {}
    });

    // chat rooms
    socket.on('joinChat', ({ roomId } = {}) => {
      if (!roomId) return;
      socket.join(`chat:${roomId}`);
      socket.emit('joined', { roomId });
    });

    socket.on('typing', ({ roomId, senderId, isTyping } = {}) => {
      if (!roomId || !senderId) return;
      io.to(`chat:${roomId}`).emit('typing', {
        roomId,
        senderId,
        isTyping: !!isTyping,
      });
    });

    socket.on('disconnect', () => {});
  });

  // Native WebSocket endpoint for your raw WS frontend
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(String(raw)); } catch { return; }

      // Legacy client sends: { type:'joinChat', roomId }
      if (data?.type === 'joinChat' && data.roomId) {
        wsJoin(ws, data.roomId);
        try {
          ws.send(JSON.stringify({ type: 'joined', roomId: data.roomId }));
        } catch (_) {}
        return;
      }

      // Optional typing echo for WS clients
      if (data?.type === 'typing' && data.roomId && data.senderId) {
        // echo to Socket.IO clients, too
        if (io) {
          io.to(`chat:${data.roomId}`).emit('typing', {
            roomId: data.roomId,
            senderId: data.senderId,
            isTyping: !!data.isTyping,
          });
        }
        const set = wsRooms.get(data.roomId);
        if (set) {
          const msg = JSON.stringify({
            type: 'typing',
            roomId: data.roomId,
            senderId: data.senderId,
            isTyping: !!data.isTyping,
          });
          for (const client of set) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              try { client.send(msg); } catch (_) {}
            }
          }
        }
        return;
      }

      // Optional: Allow sending messages via WS (your UI uses REST already)
      if (data?.type === 'sendChatMessage') {
        try {
          const { roomId, senderId, text = '', replyTo, attachments = [] } = data;
          if (!roomId || !senderId || (!text && (!attachments || attachments.length === 0))) return;

          const room = await ChatRoom.findOne({ roomId });
          if (!room) return;

          const isMember = room.participants.some((p) => String(p.userId) === String(senderId));
          if (!isMember) return;

          const msg = {
            messageId: uuidv4(),
            senderId,
            text,
            timestamp: new Date(),
            replyTo: replyTo || null,
            reply: null, // could build snapshot here if needed
            attachments: attachments || [],
          };

          room.messages.push(msg);
          await room.save();

          // Broadcast to BOTH transports
          broadcastToChatRoom(roomId, 'chatMessage', { roomId, message: msg });
        } catch (_) {}
      }
    });

    ws.on('close', () => wsLeaveAll(ws));
  });

  return io;
}

module.exports = {
  init,
  emitToAdmin,
  emitToBrand,
  emitToInfluencer,
  broadcastToChatRoom,
  legacyBroadcastToRoom,
  getIO() {
    if (!io) throw new Error('Socket.io not initialized yet.');
    return io;
  },
};
