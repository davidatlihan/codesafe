import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import * as Y from 'yjs';

const MESSAGE_TYPE_SYNC = 0;
const JWT_SECRET = 'test-jwt-secret';

let backendProcess;
let baseUrl;
let wsBaseUrl;
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function encodeMessage(type, payload) {
  const message = new Uint8Array(payload.length + 1);
  message[0] = type;
  message.set(payload, 1);
  return message;
}

function parseBinaryMessage(raw) {
  const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (data.length < 1) {
    return null;
  }

  return {
    type: data[0],
    payload: data.subarray(1)
  };
}

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 4000;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return port;
}

async function waitForBackend(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until backend is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Backend did not become ready in time');
}

function createToken({ userId, username, role }) {
  return jwt.sign({ userId, username, role }, JWT_SECRET, { expiresIn: '1h' });
}

async function connectSocket({ roomId, token }) {
  const socket = new WebSocket(
    `${wsBaseUrl}?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`
  );

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return socket;
}

function waitForTextMessage(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for text message'));
    }, timeoutMs);

    const onMessage = (data, isBinary) => {
      if (isBinary || typeof data !== 'string') {
        return;
      }

      if (predicate(data)) {
        cleanup();
        resolve(data);
      }
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };

    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

function waitForBinaryMessage(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for binary message'));
    }, timeoutMs);

    const onMessage = (data, isBinary) => {
      if (!isBinary) {
        return;
      }

      const parsed = parseBinaryMessage(data);
      if (parsed && predicate(parsed)) {
        cleanup();
        resolve(parsed);
      }
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };

    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    socket.once('close', () => resolve());
    socket.close();
  });
}

beforeAll(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;

  backendProcess = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: JWT_SECRET,
      MONGODB_URI: ''
    },
    stdio: 'pipe'
  });

  backendProcess.stdout.on('data', () => {});
  backendProcess.stderr.on('data', () => {});

  await waitForBackend(baseUrl);
}, 30000);

afterAll(async () => {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await once(backendProcess, 'close');
  }
}, 15000);

describe('Backend API and WebSocket behavior', () => {
  test('health and login endpoints work', async () => {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({ status: 'ok' });

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ username: 'alice' })
    });

    expect(loginResponse.status).toBe(200);
    const body = await loginResponse.json();
    expect(typeof body.token).toBe('string');
    expect(body.user.username).toBe('alice');
    expect(['viewer', 'editor', 'admin']).toContain(body.user.role);
  });

  test('chat messages are broadcast to room participants', async () => {
    const tokenAlice = createToken({ userId: 'u-alice', username: 'alice', role: 'editor' });
    const tokenBob = createToken({ userId: 'u-bob', username: 'bob', role: 'editor' });

    const socketAlice = await connectSocket({ roomId: 'chat-room', token: tokenAlice });
    const socketBob = await connectSocket({ roomId: 'chat-room', token: tokenBob });

    socketAlice.send(
      JSON.stringify({
        type: 'chat',
        text: 'hello from alice'
      })
    );

    const messageRaw = await waitForTextMessage(socketBob, (raw) => {
      try {
        const parsed = JSON.parse(raw);
        return parsed.type === 'chat' && parsed.text === 'hello from alice';
      } catch {
        return false;
      }
    });

    const message = JSON.parse(messageRaw);
    expect(message.username).toBe('alice');

    await closeSocket(socketAlice);
    await closeSocket(socketBob);
  });

  test('viewer cannot apply collaborative edits, editor can', async () => {
    const viewerToken = createToken({ userId: 'u-viewer', username: 'viewer', role: 'viewer' });
    const editorToken = createToken({ userId: 'u-editor', username: 'editor', role: 'editor' });

    const socketViewer = await connectSocket({ roomId: 'collab-room', token: viewerToken });
    const socketEditor = await connectSocket({ roomId: 'collab-room', token: editorToken });

    const viewerDoc = new Y.Doc();
    viewerDoc.getText('main').insert(0, 'blocked edit');
    const viewerUpdate = Y.encodeStateAsUpdate(viewerDoc);
    socketViewer.send(encodeMessage(MESSAGE_TYPE_SYNC, viewerUpdate));

    const permissionErrorRaw = await waitForTextMessage(socketViewer, (raw) => {
      try {
        const parsed = JSON.parse(raw);
        return parsed.type === 'error' && /insufficient permissions/i.test(parsed.message);
      } catch {
        return false;
      }
    });

    expect(permissionErrorRaw).toContain('insufficient permissions');

    const editorDoc = new Y.Doc();
    editorDoc.getText('main').insert(0, 'allowed edit');
    const editorUpdate = Y.encodeStateAsUpdate(editorDoc);
    const syncPromise = waitForBinaryMessage(
      socketViewer,
      (message) => message.type === MESSAGE_TYPE_SYNC
    );

    socketEditor.send(encodeMessage(MESSAGE_TYPE_SYNC, editorUpdate));
    const syncMessage = await syncPromise;

    const replayDoc = new Y.Doc();
    Y.applyUpdate(replayDoc, syncMessage.payload);
    expect(replayDoc.getText('main').toString()).toContain('allowed edit');

    await closeSocket(socketViewer);
    await closeSocket(socketEditor);
  });

  test('admin can approve suggestions and change permissions; editor cannot', async () => {
    const roomId = 'approval-room';
    const adminToken = createToken({ userId: 'u-admin', username: 'admin', role: 'admin' });
    const editorToken = createToken({ userId: 'u-ed', username: 'editor', role: 'editor' });

    const socketEditor = await connectSocket({ roomId, token: editorToken });

    const suggestionDoc = new Y.Doc();
    const suggestions = suggestionDoc.getMap('editor:suggestions');
    const entry = new Y.Map();
    entry.set('fileId', 'main.js');
    entry.set('startLine', 1);
    entry.set('endLine', 1);
    entry.set('text', 'rename variable');
    entry.set('authorId', 'u-ed');
    entry.set('authorName', 'editor');
    const votes = new Y.Map();
    votes.set('u-ed', 1);
    entry.set('votes', votes);
    suggestions.set('s1', entry);

    socketEditor.send(encodeMessage(MESSAGE_TYPE_SYNC, Y.encodeStateAsUpdate(suggestionDoc)));

    // Let room state settle before approval endpoint call.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const editorApprove = await fetch(`${baseUrl}/api/projects/${roomId}/suggestions/s1/approve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${editorToken}`
      }
    });
    expect(editorApprove.status).toBe(403);

    const adminApprove = await fetch(`${baseUrl}/api/projects/${roomId}/suggestions/s1/approve`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`
      }
    });
    expect(adminApprove.status).toBe(200);

    const editorPermissionChange = await fetch(`${baseUrl}/api/projects/${roomId}/permissions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${editorToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ userId: 'u-viewer', role: 'viewer' })
    });
    expect(editorPermissionChange.status).toBe(403);

    const adminPermissionChange = await fetch(`${baseUrl}/api/projects/${roomId}/permissions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ userId: 'u-viewer', role: 'viewer' })
    });

    expect(adminPermissionChange.status).toBe(200);
    const permissionBody = await adminPermissionChange.json();
    expect(permissionBody).toMatchObject({ ok: true, userId: 'u-viewer', role: 'viewer' });

    await closeSocket(socketEditor);
  });
});
