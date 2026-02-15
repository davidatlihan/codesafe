import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type ChatPanelProps = {
  roomId: string;
  wsUrl: string;
  token: string;
};

type ChatMessage = {
  id: string;
  username: string;
  text: string;
  sentAt: string;
};

type IncomingSocketMessage =
  | {
      type: 'chat';
      id: string;
      username: string;
      text: string;
      sentAt: string;
    }
  | {
      type: 'welcome';
    };

function parseIncomingSocketMessage(raw: string): IncomingSocketMessage | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type === 'chat') {
      if (
        typeof parsed.id !== 'string' ||
        typeof parsed.username !== 'string' ||
        typeof parsed.text !== 'string' ||
        typeof parsed.sentAt !== 'string'
      ) {
        return null;
      }

      return {
        type: 'chat',
        id: parsed.id,
        username: parsed.username,
        text: parsed.text,
        sentAt: parsed.sentAt
      };
    }

    if (parsed.type === 'welcome') {
      return { type: 'welcome' };
    }

    return null;
  } catch {
    return null;
  }
}

export default function ChatPanel({ roomId, wsUrl, token }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const socketRef = useRef<WebSocket | null>(null);

  const wsAddress = useMemo(
    () => `${wsUrl}?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`,
    [roomId, token, wsUrl]
  );

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let isDisposed = false;
    let activeSocket: WebSocket | null = null;

    const onMessage = (event: MessageEvent): void => {
      if (typeof event.data !== 'string') {
        return;
      }

      const message = parseIncomingSocketMessage(event.data);
      if (!message || message.type !== 'chat') {
        return;
      }

      setMessages((current) => [
        ...current,
        {
          id: message.id,
          username: message.username,
          text: message.text,
          sentAt: message.sentAt
        }
      ]);
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

      const socket = new WebSocket(wsAddress);
      activeSocket = socket;
      socketRef.current = socket;
      socket.addEventListener('message', onMessage);
      socket.addEventListener('open', () => {
        reconnectAttempt = 0;
      });
      socket.addEventListener('close', () => {
        if (activeSocket === socket) {
          activeSocket = null;
          socketRef.current = null;
        }
        scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        socket.close();
      });
    };

    connectSocket();

    return () => {
      isDisposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (activeSocket) {
        activeSocket.removeEventListener('message', onMessage);
        activeSocket.close();
      }
      socketRef.current = null;
    };
  }, [wsAddress]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = input.trim();
    if (text.length === 0) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'chat',
        text
      })
    );
    setInput('');
  };

  return (
    <div className="panel-stack">
      <div className="chat-list">
        {messages.map((message) => (
          <p key={message.id}>
            <strong>{message.username}:</strong> {message.text}
          </p>
        ))}
      </div>
      <form className="chat-form" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Type message"
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
