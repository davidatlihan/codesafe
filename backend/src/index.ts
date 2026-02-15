import cors from 'cors';
import express from 'express';
import JSZip from 'jszip';
import jwt from 'jsonwebtoken';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import {
  ensureDbConnection,
  findOrCreateUserByUsername,
  loadProjectState,
  persistProjectState,
  setProjectPermission
} from './persistence.js';
import type { Role } from './models.js';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates
} from 'y-protocols/awareness';

const MESSAGE_TYPE_SYNC = 0;
const MESSAGE_TYPE_AWARENESS = 1;

const app = express();
const startedAt = Date.now();
const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const portRaw = process.env.PORT ?? '4000';
const port = Number(portRaw);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT: ${portRaw}`);
}

const fallbackJwtSecret = 'dev-jwt-secret';
const jwtSecret = process.env.JWT_SECRET ?? fallbackJwtSecret;
if (env === 'production' && jwtSecret === fallbackJwtSecret) {
  throw new Error('JWT_SECRET must be set in production');
}
const hasMongoUri = typeof process.env.MONGODB_URI === 'string' && process.env.MONGODB_URI.trim().length > 0;
if (env === 'production' && !hasMongoUri) {
  throw new Error('MONGODB_URI must be set in production');
}

const allowedOriginList = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const allowAllOrigins = env !== 'production' && allowedOriginList.length === 0;

const authWindowMs = 60_000;
const authLimit = 30;
const authAttemptsByIp = new Map<string, { count: number; resetAt: number }>();
let isShuttingDown = false;

type AuthTokenPayload = {
  userId: string;
  username: string;
  role: Role;
};

type IncomingChatMessage = {
  type: 'chat';
  text: string;
};

type OutgoingChatMessage = {
  type: 'chat';
  id: string;
  userId: string;
  username: string;
  text: string;
  sentAt: string;
};

function getRequestIp(req: express.Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }

  return req.ip || req.socket.remoteAddress || 'unknown';
}

function consumeAuthRateLimit(ip: string): boolean {
  const now = Date.now();
  const current = authAttemptsByIp.get(ip);
  if (!current || current.resetAt <= now) {
    authAttemptsByIp.set(ip, { count: 1, resetAt: now + authWindowMs });
    return true;
  }

  if (current.count >= authLimit) {
    return false;
  }

  current.count += 1;
  return true;
}

function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (allowAllOrigins || !originHeader) {
    return true;
  }

  return allowedOriginList.includes(originHeader);
}

function isValidRoomId(roomId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(roomId);
}

app.disable('x-powered-by');

app.use(
  cors({
    origin: (origin, callback) => {
      if (allowAllOrigins || !origin || allowedOriginList.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true
  })
);
app.use(express.json({ limit: '256kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    env,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
  });
});

app.get('/api/ready', async (_req, res) => {
  if (isShuttingDown) {
    res.status(503).json({ status: 'shutting_down' });
    return;
  }

  if (!hasMongoUri) {
    res.json({ status: 'ready', db: 'disabled' });
    return;
  }

  const dbReady = await ensureDbConnection();
  if (!dbReady) {
    res.status(503).json({ status: 'db_unavailable' });
    return;
  }

  res.json({ status: 'ready' });
});

app.post('/api/auth/login', async (req, res) => {
  if (isShuttingDown) {
    res.status(503).json({ error: 'server is shutting down' });
    return;
  }

  const ip = getRequestIp(req);
  if (!consumeAuthRateLimit(ip)) {
    res.status(429).json({ error: 'too many login attempts; try again later' });
    return;
  }

  const usernameRaw = req.body?.username;
  const username =
    typeof usernameRaw === 'string' ? usernameRaw.trim() : '';

  if (username.length === 0) {
    res.status(400).json({ error: 'username is required' });
    return;
  }

  const userRecord = await findOrCreateUserByUsername(username);
  const userId = userRecord.userId;
  const role = userRecord.role;
  const token = jwt.sign({ userId, username, role }, jwtSecret, { expiresIn: '8h' });

  res.json({
    token,
    user: {
      userId,
      username,
      role
    }
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map<string, Room>();

app.post('/api/projects/:id/export', async (req, res) => {
  if (isShuttingDown) {
    res.status(503).json({ error: 'server is shutting down' });
    return;
  }

  const token = extractBearerToken(req.header('authorization'));
  const user = token ? verifyToken(token) : null;
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const projectId = req.params.id;
  const room = rooms.get(projectId);
  const exportDoc = room ? room.doc : new Y.Doc();
  if (!room) {
    await loadProjectState(projectId, exportDoc);
  }

  const yFiles = exportDoc.getMap<Y.Text>('editor:files');
  const treeNodes = exportDoc.getMap<Y.Map<unknown>>('file-tree:nodes');
  const zip = new JSZip();
  let fileCount = 0;

  for (const [fileId, yText] of yFiles.entries()) {
    const treePath = buildFilePathFromTree(fileId, treeNodes);
    const fallbackName = `${sanitizePathSegment(fileId)}.txt`;
    const filePath = treePath ?? `files/${fallbackName}`;
    zip.file(filePath, yText.toString());
    fileCount += 1;
  }

  if (fileCount === 0) {
    zip.file('README.txt', 'No project files found in this room.');
  }

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename=\"${sanitizePathSegment(projectId)}.zip\"`
  );
  res.send(zipBuffer);

  if (!room) {
    exportDoc.destroy();
  }
});

app.post('/api/projects/:id/permissions', async (req, res) => {
  if (isShuttingDown) {
    res.status(503).json({ error: 'server is shutting down' });
    return;
  }

  const token = extractBearerToken(req.header('authorization'));
  const user = token ? verifyToken(token) : null;
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const projectId = req.params.id;
  const targetUserId = req.body?.userId;
  const nextRole = req.body?.role;
  if (
    typeof targetUserId !== 'string' ||
    (nextRole !== 'viewer' && nextRole !== 'editor' && nextRole !== 'admin')
  ) {
    res.status(400).json({ error: 'userId and valid role are required' });
    return;
  }

  const room = await getOrCreateRoom(projectId);
  const requesterRole = getEffectiveRole(room, user);
  if (requesterRole !== 'admin') {
    res.status(403).json({ error: 'admin role required' });
    return;
  }

  room.permissions.set(targetUserId, nextRole);
  await setProjectPermission(projectId, targetUserId, nextRole);
  res.json({ ok: true, userId: targetUserId, role: nextRole });
});

app.post('/api/projects/:id/suggestions/:suggestionId/approve', async (req, res) => {
  if (isShuttingDown) {
    res.status(503).json({ error: 'server is shutting down' });
    return;
  }

  const token = extractBearerToken(req.header('authorization'));
  const user = token ? verifyToken(token) : null;
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const projectId = req.params.id;
  const suggestionId = req.params.suggestionId;
  const room = await getOrCreateRoom(projectId);
  const requesterRole = getEffectiveRole(room, user);
  if (requesterRole !== 'admin') {
    res.status(403).json({ error: 'admin role required' });
    return;
  }

  const ySuggestions = room.doc.getMap<Y.Map<unknown>>('editor:suggestions');
  const suggestion = ySuggestions.get(suggestionId);
  if (!suggestion) {
    res.status(404).json({ error: 'suggestion not found' });
    return;
  }

  room.doc.transact(() => {
    suggestion.set('approved', true);
    suggestion.set('approvedBy', user.userId);
    suggestion.set('approvedAt', new Date().toISOString());
  });

  scheduleProjectPersist(projectId, room);
  res.json({ ok: true, suggestionId });
});

type Room = {
  doc: Y.Doc;
  awareness: Awareness;
  sockets: Set<WebSocket>;
  persistTimer: NodeJS.Timeout | null;
  persistInFlight: boolean;
  persistRequested: boolean;
  permissions: Map<string, Role>;
};

type SocketContext = {
  roomId: string;
  awarenessClientIds: Set<number>;
  user: AuthTokenPayload;
};

const socketContexts = new Map<WebSocket, SocketContext>();
const pendingRooms = new Map<string, Promise<Room>>();

function verifyToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (typeof decoded !== 'object' || decoded === null) {
      return null;
    }

    const userId = decoded.userId;
    const username = decoded.username;
    const role = decoded.role;

    if (
      typeof userId !== 'string' ||
      typeof username !== 'string' ||
      (role !== 'viewer' && role !== 'editor' && role !== 'admin')
    ) {
      return null;
    }

    return { userId, username, role };
  } catch {
    return null;
  }
}

function getRoleRank(role: Role): number {
  if (role === 'viewer') {
    return 0;
  }
  if (role === 'editor') {
    return 1;
  }
  return 2;
}

function getEffectiveRole(room: Room, user: AuthTokenPayload): Role {
  return room.permissions.get(user.userId) ?? user.role;
}

function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token;
}

function sanitizePathSegment(segment: string): string {
  const cleaned = segment.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'untitled';
}

function buildFilePathFromTree(
  fileId: string,
  treeNodes: Y.Map<Y.Map<unknown>>
): string | null {
  const visited = new Set<string>();
  const pathSegments: string[] = [];
  let currentId: string | null = fileId;

  while (currentId) {
    if (visited.has(currentId)) {
      return null;
    }
    visited.add(currentId);

    const node: Y.Map<unknown> | undefined = treeNodes.get(currentId);
    if (!node) {
      if (pathSegments.length === 0) {
        return null;
      }
      break;
    }

    const nodeName = node.get('name');
    const parentId: unknown = node.get('parentId');
    if (typeof nodeName !== 'string') {
      return null;
    }

    pathSegments.push(sanitizePathSegment(nodeName));
    if (typeof parentId === 'string') {
      currentId = parentId;
    } else if (parentId === null) {
      break;
    } else {
      return null;
    }
  }

  if (pathSegments.length === 0) {
    return null;
  }

  return pathSegments.reverse().join('/');
}

function toUint8Array(rawData: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(rawData)) {
    return new Uint8Array(Buffer.concat(rawData));
  }

  if (rawData instanceof ArrayBuffer) {
    return new Uint8Array(rawData);
  }

  return new Uint8Array(rawData);
}

function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  const message = new Uint8Array(payload.length + 1);
  message[0] = type;
  message.set(payload, 1);
  return message;
}

function parseMessage(data: Uint8Array): { type: number; payload: Uint8Array } | null {
  if (data.length < 1) {
    return null;
  }

  return {
    type: data[0],
    payload: data.subarray(1)
  };
}

function readAwarenessClientIds(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const clientCount = decoding.readVarUint(decoder);
  const clientIds: number[] = [];

  for (let i = 0; i < clientCount; i += 1) {
    clientIds.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }

  return clientIds;
}

function broadcast(
  room: Room,
  type: number,
  payload: Uint8Array,
  exclude?: WebSocket
): void {
  const message = encodeMessage(type, payload);
  for (const client of room.sockets) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(message, { binary: true });
    }
  }
}

function broadcastText(
  room: Room,
  payload: string,
  exclude?: WebSocket
): void {
  for (const client of room.sockets) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function parseIncomingChatMessage(data: string): IncomingChatMessage | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; text?: unknown };
    if (parsed.type !== 'chat' || typeof parsed.text !== 'string') {
      return null;
    }

    const text = parsed.text.trim();
    if (text.length === 0) {
      return null;
    }

    return {
      type: 'chat',
      text
    };
  } catch {
    return null;
  }
}

function scheduleProjectPersist(projectId: string, room: Room): void {
  room.persistRequested = true;
  if (room.persistTimer) {
    return;
  }

  room.persistTimer = setTimeout(() => {
    room.persistTimer = null;
    void flushProjectPersist(projectId, room);
  }, 1200);
}

async function flushProjectPersist(projectId: string, room: Room): Promise<void> {
  if (room.persistInFlight) {
    room.persistRequested = true;
    return;
  }

  if (!room.persistRequested) {
    return;
  }

  room.persistInFlight = true;
  room.persistRequested = false;

  try {
    await persistProjectState(projectId, room.doc);
  } catch (error: unknown) {
    console.error(`Persist failed for room ${projectId}:`, error);
    room.persistRequested = true;
  } finally {
    room.persistInFlight = false;
  }

  if (room.persistRequested && !room.persistTimer) {
    room.persistTimer = setTimeout(() => {
      room.persistTimer = null;
      void flushProjectPersist(projectId, room);
    }, 600);
  }
}

function createRoom(projectId: string): Room {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const sockets = new Set<WebSocket>();
  const room = {
    doc,
    awareness,
    sockets,
    persistTimer: null,
    persistInFlight: false,
    persistRequested: false,
    permissions: new Map<string, Role>()
  };

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const excludedSocket = origin instanceof WebSocket ? origin : undefined;
    broadcast(room, MESSAGE_TYPE_SYNC, update, excludedSocket);
    scheduleProjectPersist(projectId, room);
  });

  awareness.on(
    'update',
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changedClients = [...added, ...updated, ...removed];
      if (changedClients.length === 0) {
        return;
      }

      const awarenessUpdate = encodeAwarenessUpdate(awareness, changedClients);
      const excludedSocket = origin instanceof WebSocket ? origin : undefined;
      broadcast(room, MESSAGE_TYPE_AWARENESS, awarenessUpdate, excludedSocket);
    }
  );

  return room;
}

async function getOrCreateRoom(roomId: string): Promise<Room> {
  const existingRoom = rooms.get(roomId);
  if (existingRoom) {
    return existingRoom;
  }

  const pendingRoom = pendingRooms.get(roomId);
  if (pendingRoom) {
    return pendingRoom;
  }

  const creatingRoom = (async (): Promise<Room> => {
    try {
      const newRoom = createRoom(roomId);
      const persistedPermissions = await loadProjectState(roomId, newRoom.doc);
      newRoom.permissions = persistedPermissions;
      rooms.set(roomId, newRoom);
      return newRoom;
    } finally {
      pendingRooms.delete(roomId);
    }
  })();

  pendingRooms.set(roomId, creatingRoom);
  return creatingRoom;
}

function removeSocketFromRoom(socket: WebSocket): void {
  const context = socketContexts.get(socket);
  if (!context) {
    return;
  }

  const room = rooms.get(context.roomId);
  if (!room) {
    socketContexts.delete(socket);
    return;
  }

  room.sockets.delete(socket);
  if (context.awarenessClientIds.size > 0) {
    removeAwarenessStates(room.awareness, Array.from(context.awarenessClientIds), socket);
  }
  socketContexts.delete(socket);

  if (room.sockets.size === 0) {
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
    room.persistRequested = true;
    void (async () => {
      await flushProjectPersist(context.roomId, room);
      room.awareness.destroy();
      room.doc.destroy();
      rooms.delete(context.roomId);
    })();
  }
}

wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
  if (isShuttingDown) {
    socket.close(1012, 'server shutting down');
    return;
  }

  const originHeader = req.headers.origin;
  if (!isAllowedOrigin(originHeader)) {
    socket.close(1008, 'origin not allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const token = url.searchParams.get('token');
  if (!token) {
    socket.close(1008, 'missing token');
    return;
  }

  const user = verifyToken(token);
  if (!user) {
    socket.close(1008, 'invalid token');
    return;
  }

  const roomId = url.searchParams.get('room') ?? 'default';
  if (!isValidRoomId(roomId)) {
    socket.close(1008, 'invalid room id');
    return;
  }
  void (async () => {
    const room = await getOrCreateRoom(roomId);
    room.sockets.add(socket);

    socketContexts.set(socket, {
      roomId,
      awarenessClientIds: new Set<number>(),
      user
    });

    socket.send(
      JSON.stringify({
        type: 'welcome',
        message: 'connected',
        roomId,
        user
      })
    );
    socket.send(
      encodeMessage(MESSAGE_TYPE_SYNC, Y.encodeStateAsUpdate(room.doc)),
      { binary: true }
    );

    const existingAwarenessClients = Array.from(room.awareness.getStates().keys());
    if (existingAwarenessClients.length > 0) {
      socket.send(
        encodeMessage(
          MESSAGE_TYPE_AWARENESS,
          encodeAwarenessUpdate(room.awareness, existingAwarenessClients)
        ),
        { binary: true }
      );
    }

    socket.on('message', (rawData: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) {
        const data = rawData.toString();

        if (data === 'ping') {
          socket.send('pong');
          return;
        }

        const context = socketContexts.get(socket);
        if (!context) {
          return;
        }

        const incomingChatMessage = parseIncomingChatMessage(data);
        if (incomingChatMessage) {
          const outgoingChatMessage: OutgoingChatMessage = {
            type: 'chat',
            id: randomUUID(),
            userId: context.user.userId,
            username: context.user.username,
            text: incomingChatMessage.text,
            sentAt: new Date().toISOString()
          };

          broadcastText(room, JSON.stringify(outgoingChatMessage));
        }

        return;
      }

      const parsed = parseMessage(toUint8Array(rawData));
      if (!parsed) {
        return;
      }

      if (parsed.type === MESSAGE_TYPE_SYNC) {
        const context = socketContexts.get(socket);
        if (!context) {
          return;
        }

        const currentRole = getEffectiveRole(room, context.user);
        if (getRoleRank(currentRole) < getRoleRank('editor')) {
          socket.send(
            JSON.stringify({
              type: 'error',
              message: 'insufficient permissions for editing'
            })
          );
          return;
        }

        Y.applyUpdate(room.doc, parsed.payload, socket);
        return;
      }

      if (parsed.type === MESSAGE_TYPE_AWARENESS) {
        const context = socketContexts.get(socket);
        if (context) {
          for (const awarenessClientId of readAwarenessClientIds(parsed.payload)) {
            context.awarenessClientIds.add(awarenessClientId);
          }
        }

        applyAwarenessUpdate(room.awareness, parsed.payload, socket);
      }
    });

    socket.on('close', () => {
      removeSocketFromRoom(socket);
    });

    socket.on('error', () => {
      removeSocketFromRoom(socket);
    });
  })().catch((error: unknown) => {
    console.error('WebSocket room initialization failed:', error);
    socket.close(1011, 'room init failed');
  });
});

let shutdownInProgress = false;

async function shutdown(signal: string): Promise<void> {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  isShuttingDown = true;
  console.log(`Received ${signal}, starting graceful shutdown...`);

  const persistTasks: Array<Promise<void>> = [];
  for (const [roomId, room] of rooms.entries()) {
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
    room.persistRequested = true;
    persistTasks.push(flushProjectPersist(roomId, room));
  }
  await Promise.allSettled(persistTasks);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close(1012, 'server shutdown');
    }
  });
  wss.close();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  console.log('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Backend listening on http://localhost:${port}`);
  console.log(`WebSocket listening on ws://localhost:${port}`);
});
