import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';

type SuggestionsPanelProps = {
  roomId: string;
  wsUrl: string;
  token: string;
  userId: string;
  username: string;
  activeFileId: string | null;
};

type Suggestion = {
  id: string;
  fileId: string;
  startLine: number;
  endLine: number;
  text: string;
  authorName: string;
  upvotes: number;
  downvotes: number;
  myVote: number;
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

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export default function SuggestionsPanel({
  roomId,
  wsUrl,
  token,
  userId,
  username,
  activeFileId
}: SuggestionsPanelProps) {
  const yDocRef = useRef<Y.Doc | null>(null);
  const ySuggestionsRef = useRef<Y.Map<Y.Map<unknown>> | null>(null);

  const [version, setVersion] = useState(0);
  const [fileIdInput, setFileIdInput] = useState('');
  const [startLineInput, setStartLineInput] = useState('1');
  const [endLineInput, setEndLineInput] = useState('1');
  const [textInput, setTextInput] = useState('');
  const [snapshot, setSnapshot] = useState<Array<[string, Y.Map<unknown>]>>([]);

  const wsAddress = useMemo(
    () => `${wsUrl}?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`,
    [roomId, token, wsUrl]
  );

  useEffect(() => {
    if (activeFileId) {
      setFileIdInput(activeFileId);
    }
  }, [activeFileId]);

  useEffect(() => {
    const yDoc = new Y.Doc();
    const ySuggestions = yDoc.getMap<Y.Map<unknown>>('editor:suggestions');
    const wsOrigin = { source: 'suggestions-ws' };
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let isDisposed = false;

    yDocRef.current = yDoc;
    ySuggestionsRef.current = ySuggestions;

    const refresh = (): void => {
      setVersion((current) => current + 1);
      setSnapshot(Array.from(ySuggestions.entries()));
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
    ySuggestions.observeDeep(refresh);
    connectSocket();
    refresh();

    return () => {
      isDisposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ySuggestions.unobserveDeep(refresh);
      yDoc.off('update', onDocUpdate);
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
      yDoc.destroy();
      yDocRef.current = null;
      ySuggestionsRef.current = null;
    };
  }, [wsAddress]);

  const suggestions = useMemo((): Suggestion[] => {
    const output: Suggestion[] = [];

    for (const [id, raw] of snapshot) {
      const fileId = raw.get('fileId');
      const startLine = raw.get('startLine');
      const endLine = raw.get('endLine');
      const text = raw.get('text');
      const authorName = raw.get('authorName');
      const votes = raw.get('votes');

      if (
        typeof fileId !== 'string' ||
        typeof startLine !== 'number' ||
        typeof endLine !== 'number' ||
        typeof text !== 'string' ||
        typeof authorName !== 'string' ||
        !(votes instanceof Y.Map)
      ) {
        continue;
      }

      let upvotes = 0;
      let downvotes = 0;
      let myVote = 0;
      for (const [voteUserId, vote] of votes.entries()) {
        if (typeof voteUserId !== 'string' || typeof vote !== 'number') {
          continue;
        }

        if (vote > 0) {
          upvotes += 1;
        }
        if (vote < 0) {
          downvotes += 1;
        }
        if (voteUserId === userId) {
          myVote = vote;
        }
      }

      output.push({
        id,
        fileId,
        startLine,
        endLine,
        text,
        authorName,
        upvotes,
        downvotes,
        myVote
      });
    }

    return output.sort((a, b) => {
      if (a.fileId !== b.fileId) {
        return a.fileId.localeCompare(b.fileId);
      }

      return a.startLine - b.startLine || a.endLine - b.endLine;
    });
  }, [snapshot, userId, version]);

  const submitSuggestion = (): void => {
    const yDoc = yDocRef.current;
    const ySuggestions = ySuggestionsRef.current;
    const fileId = fileIdInput.trim();
    const text = textInput.trim();
    const startLine = Math.max(1, Number.parseInt(startLineInput, 10) || 1);
    const endLine = Math.max(startLine, Number.parseInt(endLineInput, 10) || startLine);

    if (!yDoc || !ySuggestions || !fileId || !text) {
      return;
    }

    yDoc.transact(() => {
      const suggestionId = randomId();
      const entry = new Y.Map<unknown>();
      entry.set('fileId', fileId);
      entry.set('startLine', startLine);
      entry.set('endLine', endLine);
      entry.set('text', text);
      entry.set('authorId', userId);
      entry.set('authorName', username);
      const votes = new Y.Map<number>();
      votes.set(userId, 1);
      entry.set('votes', votes);
      ySuggestions.set(suggestionId, entry);
    });

    setTextInput('');
  };

  const voteSuggestion = (suggestionId: string, vote: 1 | -1): void => {
    const yDoc = yDocRef.current;
    const ySuggestions = ySuggestionsRef.current;
    if (!yDoc || !ySuggestions) {
      return;
    }

    yDoc.transact(() => {
      const suggestion = ySuggestions.get(suggestionId);
      const votes = suggestion?.get('votes');
      if (!(suggestion instanceof Y.Map) || !(votes instanceof Y.Map)) {
        return;
      }

      const currentVote = votes.get(userId);
      if (currentVote === vote) {
        votes.delete(userId);
      } else {
        votes.set(userId, vote);
      }
    });
  };

  return (
    <div className="suggestions-panel">
      <div className="suggestions-controls">
        <input
          value={fileIdInput}
          onChange={(event) => setFileIdInput(event.target.value)}
          placeholder="File id"
        />
        <div className="suggestions-line-inputs">
          <input
            value={startLineInput}
            onChange={(event) => setStartLineInput(event.target.value)}
            placeholder="Start"
          />
          <input
            value={endLineInput}
            onChange={(event) => setEndLineInput(event.target.value)}
            placeholder="End"
          />
        </div>
        <textarea
          value={textInput}
          onChange={(event) => setTextInput(event.target.value)}
          placeholder="Write suggestion"
        />
        <button type="button" onClick={submitSuggestion}>
          Submit
        </button>
      </div>

      <div className="suggestions-list">
        {suggestions.map((suggestion) => (
          <div key={suggestion.id} className="suggestion-item">
            <div>
              {suggestion.fileId} L{suggestion.startLine}-{suggestion.endLine} | {suggestion.authorName}
            </div>
            <div>{suggestion.text}</div>
            <div className="suggestion-votes">
              <span>
                {suggestion.upvotes + suggestion.downvotes} votes (+{suggestion.upvotes}/-{suggestion.downvotes})
              </span>
              <button type="button" onClick={() => voteSuggestion(suggestion.id, 1)}>
                {suggestion.myVote > 0 ? 'Unvote +' : 'Upvote'}
              </button>
              <button type="button" onClick={() => voteSuggestion(suggestion.id, -1)}>
                {suggestion.myVote < 0 ? 'Unvote -' : 'Downvote'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
