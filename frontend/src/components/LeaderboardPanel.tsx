import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';

type LeaderboardPanelProps = {
  roomId: string;
  wsUrl: string;
  token: string;
  currentUserId: string;
  currentUsername: string;
};

type LeaderboardRow = {
  userId: string;
  username: string;
  charactersTyped: number;
  suggestionsMade: number;
  suggestionsApproved: number;
  commentsLeft: number;
};

const MESSAGE_TYPE_SYNC = 0;

function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  const message = new Uint8Array(payload.length + 1);
  message[0] = type;
  message.set(payload, 1);
  return message;
}

function parseMessage(data: Uint8Array): { type: number; payload: Uint8Array } | null {
  if (data.length === 0) {
    return null;
  }

  return {
    type: data[0],
    payload: data.subarray(1)
  };
}

function extractSuggestionScore(raw: Y.Map<unknown>): { upvotes: number; downvotes: number } {
  const votes = raw.get('votes');
  if (!(votes instanceof Y.Map)) {
    return { upvotes: 0, downvotes: 0 };
  }

  let upvotes = 0;
  let downvotes = 0;
  for (const vote of votes.values()) {
    if (typeof vote !== 'number') {
      continue;
    }

    if (vote > 0) {
      upvotes += 1;
    }
    if (vote < 0) {
      downvotes += 1;
    }
  }

  return { upvotes, downvotes };
}

export default function LeaderboardPanel({
  roomId,
  wsUrl,
  token,
  currentUserId,
  currentUsername
}: LeaderboardPanelProps) {
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    chars: Array<[string, number]>;
    suggestions: Array<[string, Y.Map<unknown>]>;
    comments: Array<[string, Y.Map<unknown>]>;
  }>({
    chars: [],
    suggestions: [],
    comments: []
  });

  const wsAddress = useMemo(
    () => `${wsUrl}?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`,
    [roomId, token, wsUrl]
  );

  useEffect(() => {
    const yDoc = new Y.Doc();
    const yChars = yDoc.getMap<number>('editor:contrib:chars');
    const ySuggestions = yDoc.getMap<Y.Map<unknown>>('editor:suggestions');
    const yComments = yDoc.getMap<Y.Map<unknown>>('editor:comments');
    const wsOrigin = { source: 'leaderboard-ws' };
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let isDisposed = false;

    const refresh = (): void => {
      setVersion((current) => current + 1);
      setSnapshot({
        chars: Array.from(yChars.entries()),
        suggestions: Array.from(ySuggestions.entries()),
        comments: Array.from(yComments.entries())
      });
    };

    const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === wsOrigin || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(encodeMessage(MESSAGE_TYPE_SYNC, update));
    };

    const onSocketOpen = (nextSocket: WebSocket): void => {
      reconnectAttempt = 0;
      nextSocket.send(encodeMessage(MESSAGE_TYPE_SYNC, Y.encodeStateAsUpdate(yDoc)));
    };

    const onSocketMessage = (event: MessageEvent): void => {
      if (typeof event.data === 'string') {
        return;
      }

      const parsed = parseMessage(new Uint8Array(event.data as ArrayBuffer));
      if (!parsed || parsed.type !== MESSAGE_TYPE_SYNC) {
        return;
      }

      Y.applyUpdate(yDoc, parsed.payload, wsOrigin);
    };

    const scheduleReconnect = (): void => {
      if (isDisposed || reconnectTimer) {
        return;
      }
      const delay = Math.min(500 * 2 ** reconnectAttempt, 5000);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSocket();
      }, delay);
    };

    const connectSocket = (): void => {
      if (isDisposed) {
        return;
      }

      const nextSocket = new WebSocket(wsAddress);
      nextSocket.binaryType = 'arraybuffer';
      socket = nextSocket;

      nextSocket.addEventListener('open', () => {
        onSocketOpen(nextSocket);
      });
      nextSocket.addEventListener('message', onSocketMessage);
      nextSocket.addEventListener('close', () => {
        if (socket === nextSocket) {
          socket = null;
        }
        scheduleReconnect();
      });
      nextSocket.addEventListener('error', () => {
        nextSocket.close();
      });
    };

    yDoc.on('update', onDocUpdate);
    yChars.observe(refresh);
    ySuggestions.observeDeep(refresh);
    yComments.observeDeep(refresh);
    connectSocket();
    refresh();

    return () => {
      isDisposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      yComments.unobserveDeep(refresh);
      ySuggestions.unobserveDeep(refresh);
      yChars.unobserve(refresh);
      yDoc.off('update', onDocUpdate);
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
      yDoc.destroy();
    };
  }, [wsAddress]);

  const rows = useMemo((): LeaderboardRow[] => {
    const byUser = new Map<string, LeaderboardRow>();

    const ensureRow = (userId: string, username: string): LeaderboardRow => {
      const existing = byUser.get(userId);
      if (existing) {
        if (existing.username.startsWith('User ') && username && !username.startsWith('User ')) {
          existing.username = username;
        }
        return existing;
      }

      const row: LeaderboardRow = {
        userId,
        username: username || `User ${userId.slice(0, 6)}`,
        charactersTyped: 0,
        suggestionsMade: 0,
        suggestionsApproved: 0,
        commentsLeft: 0
      };
      byUser.set(userId, row);
      return row;
    };

    ensureRow(currentUserId, currentUsername);

    for (const [userId, count] of snapshot.chars) {
      if (typeof userId !== 'string' || typeof count !== 'number') {
        continue;
      }
      const row = ensureRow(userId, `User ${userId.slice(0, 6)}`);
      row.charactersTyped = count;
    }

    for (const [, suggestion] of snapshot.suggestions) {
      const authorId = suggestion.get('authorId');
      const authorName = suggestion.get('authorName');
      if (typeof authorId !== 'string' || typeof authorName !== 'string') {
        continue;
      }

      const row = ensureRow(authorId, authorName);
      row.suggestionsMade += 1;
      const { upvotes, downvotes } = extractSuggestionScore(suggestion);
      if (upvotes > downvotes) {
        row.suggestionsApproved += 1;
      }
    }

    for (const [, comment] of snapshot.comments) {
      const authorId = comment.get('authorId');
      const authorName = comment.get('authorName');
      if (typeof authorId !== 'string' || typeof authorName !== 'string') {
        continue;
      }

      const row = ensureRow(authorId, authorName);
      row.commentsLeft += 1;
    }

    return Array.from(byUser.values()).sort((a, b) => {
      const scoreA =
        a.charactersTyped +
        a.suggestionsMade * 20 +
        a.suggestionsApproved * 35 +
        a.commentsLeft * 10;
      const scoreB =
        b.charactersTyped +
        b.suggestionsMade * 20 +
        b.suggestionsApproved * 35 +
        b.commentsLeft * 10;
      return scoreB - scoreA;
    });
  }, [currentUserId, currentUsername, snapshot, version]);

  return (
    <div className="leaderboard-list">
      {rows.map((row) => (
        <div key={row.userId} className="leaderboard-item">
          <div className="leaderboard-name">{row.username}</div>
          <div>typed: {row.charactersTyped}</div>
          <div>suggestions: {row.suggestionsMade}</div>
          <div>approved: {row.suggestionsApproved}</div>
          <div>comments: {row.commentsLeft}</div>
        </div>
      ))}
    </div>
  );
}
