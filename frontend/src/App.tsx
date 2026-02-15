import { FormEvent, useMemo, useState } from 'react';
import ReactGridLayout, { WidthProvider } from 'react-grid-layout';
import ChatPanel from './components/ChatPanel';
import FileExplorer from './components/FileExplorer';
import LeaderboardPanel from './components/LeaderboardPanel';
import MonacoEditor from './components/MonacoEditor';
import SuggestionsPanel from './components/SuggestionsPanel';

type AuthState = {
  token: string;
  userId: string;
  username: string;
  role: 'viewer' | 'editor' | 'admin';
};

type OpenFileTab = {
  id: string;
  name: string;
};

type PanelKey = 'explorer' | 'editor' | 'suggestions' | 'chat' | 'leaderboard';

type HiddenPanels = Record<PanelKey, boolean>;

type GridLayoutItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
};

const GridLayout = WidthProvider(ReactGridLayout);

const LAYOUT_STORAGE_KEY = 'workspace-layout-v1';
const HIDDEN_STORAGE_KEY = 'workspace-hidden-panels-v1';

const DEFAULT_LAYOUT: GridLayoutItem[] = [
  { i: 'explorer', x: 0, y: 0, w: 3, h: 10, minW: 2, minH: 6 },
  { i: 'editor', x: 3, y: 0, w: 6, h: 10, minW: 4, minH: 6 },
  { i: 'suggestions', x: 9, y: 0, w: 3, h: 5, minW: 2, minH: 4 },
  { i: 'chat', x: 9, y: 5, w: 3, h: 3, minW: 2, minH: 3 },
  { i: 'leaderboard', x: 9, y: 8, w: 3, h: 2, minW: 2, minH: 2 }
];

const DEFAULT_HIDDEN: HiddenPanels = {
  explorer: false,
  editor: false,
  suggestions: false,
  chat: false,
  leaderboard: false
};
const ALL_PANELS: PanelKey[] = ['explorer', 'editor', 'suggestions', 'chat', 'leaderboard'];

function toWsUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) {
    return `wss://${baseUrl.slice('https://'.length)}`;
  }

  if (baseUrl.startsWith('http://')) {
    return `ws://${baseUrl.slice('http://'.length)}`;
  }

  return baseUrl;
}

function safeReadLayout(): GridLayoutItem[] {
  const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_LAYOUT;
  }

  try {
    const parsed = JSON.parse(raw) as GridLayoutItem[];
    if (!Array.isArray(parsed)) {
      return DEFAULT_LAYOUT;
    }

    const known = new Set(DEFAULT_LAYOUT.map((item) => item.i));
    const validItems = parsed.filter((item): item is GridLayoutItem => {
      return (
        typeof item.i === 'string' &&
        known.has(item.i) &&
        typeof item.x === 'number' &&
        typeof item.y === 'number' &&
        typeof item.w === 'number' &&
        typeof item.h === 'number'
      );
    });

    if (validItems.length !== DEFAULT_LAYOUT.length) {
      return DEFAULT_LAYOUT;
    }

    return validItems;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function safeReadHiddenPanels(): HiddenPanels {
  const raw = localStorage.getItem(HIDDEN_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_HIDDEN;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<HiddenPanels>;
    return {
      explorer: Boolean(parsed.explorer),
      editor: Boolean(parsed.editor),
      suggestions: Boolean(parsed.suggestions),
      chat: Boolean(parsed.chat),
      leaderboard: Boolean(parsed.leaderboard)
    };
  } catch {
    return DEFAULT_HIDDEN;
  }
}

function App() {
  const query = new URLSearchParams(window.location.search);
  const roomId = query.get('room') ?? 'default-project';
  const defaultLanguage = query.get('lang') === 'python' ? 'python' : 'javascript';
  const [username, setUsername] = useState('');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [layout, setLayout] = useState<GridLayoutItem[]>(safeReadLayout);
  const [hiddenPanels, setHiddenPanels] = useState<HiddenPanels>(safeReadHiddenPanels);
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>(() => [
    {
      id: defaultLanguage === 'python' ? 'main-py' : 'main-js',
      name: defaultLanguage === 'python' ? 'main.py' : 'main.js'
    }
  ]);
  const [activeTabId, setActiveTabId] = useState<string | null>(() =>
    defaultLanguage === 'python' ? 'main-py' : 'main-js'
  );

  const apiBaseUrl = useMemo(() => {
    const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
    return env.VITE_API_URL ?? 'http://localhost:4000';
  }, []);

  const wsBaseUrl = useMemo(() => {
    const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
    return env.VITE_WS_URL ?? toWsUrl(apiBaseUrl);
  }, [apiBaseUrl]);

  const handleOpenFile = (fileId: string, fileName: string): void => {
    setOpenTabs((current) => {
      if (current.some((tab) => tab.id === fileId)) {
        return current.map((tab) =>
          tab.id === fileId ? { ...tab, name: fileName } : tab
        );
      }

      return [...current, { id: fileId, name: fileName }];
    });

    setActiveTabId(fileId);
  };

  const handleCloseTab = (fileId: string): void => {
    setOpenTabs((current) => {
      const index = current.findIndex((tab) => tab.id === fileId);
      if (index < 0) {
        return current;
      }

      const nextTabs = current.filter((tab) => tab.id !== fileId);

      setActiveTabId((activeCurrent) => {
        if (activeCurrent !== fileId) {
          return activeCurrent;
        }

        if (nextTabs.length === 0) {
          return null;
        }

        const fallbackIndex = index === 0 ? 0 : index - 1;
        return nextTabs[Math.min(fallbackIndex, nextTabs.length - 1)].id;
      });

      return nextTabs;
    });
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username: username.trim() })
      });

      if (!response.ok) {
        throw new Error('Login failed');
      }

      const data = (await response.json()) as {
        token?: string;
        user?: {
          userId?: string;
          username?: string;
          role?: 'viewer' | 'editor' | 'admin';
        };
      };

      if (!data.token || !data.user?.userId || !data.user.username || !data.user.role) {
        throw new Error('Invalid login response');
      }

      setAuth({
        token: data.token,
        userId: data.user.userId,
        username: data.user.username,
        role: data.user.role
      });
    } catch {
      setError('Unable to login. Check backend server and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLayoutChange = (nextLayout: GridLayoutItem[]): void => {
    setLayout((current) => {
      const byId = new Map(nextLayout.map((item) => [item.i, item]));
      const merged = current.map((item) => byId.get(item.i) ?? item);
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(merged));
      return merged;
    });
  };

  const closePanel = (panel: PanelKey): void => {
    setHiddenPanels((current) => {
      const nextPanels = {
        ...current,
        [panel]: true
      };
      localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(nextPanels));
      return nextPanels;
    });
  };

  const reopenPanel = (panel: PanelKey): void => {
    setHiddenPanels((current) => {
      const nextPanels = {
        ...current,
        [panel]: false
      };
      localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(nextPanels));
      return nextPanels;
    });
  };

  const handleDownloadProject = async (): Promise<void> => {
    if (!auth) {
      return;
    }

    try {
      const response = await fetch(
        `${apiBaseUrl}/api/projects/${encodeURIComponent(roomId)}/export`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`
          }
        }
      );

      if (!response.ok) {
        throw new Error('failed to export');
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${roomId}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      window.alert('Project export failed. Ensure backend is running and project is active.');
    }
  };

  if (!auth) {
    return (
      <main className="login-shell">
        <form className="login-form" onSubmit={handleLogin}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Enter username"
            autoComplete="off"
            required
          />
          <button type="submit" disabled={isLoading}>
            {isLoading ? 'Signing in...' : 'Join Room'}
          </button>
          {error ? <p>{error}</p> : null}
        </form>
      </main>
    );
  }

  const panelMeta: Array<{ key: PanelKey; label: string }> = [
    { key: 'explorer', label: 'File Explorer' },
    { key: 'editor', label: 'Editor' },
    { key: 'suggestions', label: 'Suggestions' },
    { key: 'chat', label: 'Chat' },
    { key: 'leaderboard', label: 'Leaderboard' }
  ];
  const visibleLayout = layout.filter((item) =>
    ALL_PANELS.includes(item.i as PanelKey) && !hiddenPanels[item.i as PanelKey]
  );

  return (
    <main className="workspace-grid-shell">
      <div className="panel-toggle-bar">
        <button type="button" onClick={handleDownloadProject}>
          Download Project
        </button>
        {panelMeta
          .filter((panel) => hiddenPanels[panel.key])
          .map((panel) => (
            <button key={panel.key} type="button" onClick={() => reopenPanel(panel.key)}>
              Show {panel.label}
            </button>
          ))}
      </div>

      <GridLayout
        className="workspace-grid"
        cols={12}
        rowHeight={32}
        margin={[8, 8]}
        containerPadding={[8, 8]}
        layout={visibleLayout}
        draggableHandle=".panel-header"
        draggableCancel=".panel-header button"
        onLayoutChange={handleLayoutChange}
      >
        {!hiddenPanels.explorer ? (
          <section key="explorer" className="panel">
            <header className="panel-header">
              <span>File Explorer</span>
              <button type="button" onClick={() => closePanel('explorer')}>Close</button>
            </header>
            <div className="panel-body panel-body-scroll">
              <FileExplorer
                roomId={roomId}
                wsUrl={wsBaseUrl}
                token={auth.token}
                onOpenFile={handleOpenFile}
              />
            </div>
          </section>
        ) : null}

        {!hiddenPanels.editor ? (
          <section key="editor" className="panel">
            <header className="panel-header">
              <span>Editor</span>
              <button type="button" onClick={() => closePanel('editor')}>Close</button>
            </header>
            <div className="panel-body panel-body-editor">
              <MonacoEditor
                roomId={roomId}
                defaultLanguage={defaultLanguage}
                wsUrl={wsBaseUrl}
                token={auth.token}
                userId={auth.userId}
                username={auth.username}
                openFiles={openTabs}
                activeFileId={activeTabId}
                onActiveFileChange={setActiveTabId}
                onCloseFile={handleCloseTab}
              />
            </div>
          </section>
        ) : null}

        {!hiddenPanels.suggestions ? (
          <section key="suggestions" className="panel">
            <header className="panel-header">
              <span>Suggestions</span>
              <button type="button" onClick={() => closePanel('suggestions')}>Close</button>
            </header>
            <div className="panel-body panel-body-scroll">
              <SuggestionsPanel
                roomId={roomId}
                wsUrl={wsBaseUrl}
                token={auth.token}
                userId={auth.userId}
                username={auth.username}
                activeFileId={activeTabId}
              />
            </div>
          </section>
        ) : null}

        {!hiddenPanels.chat ? (
          <section key="chat" className="panel">
            <header className="panel-header">
              <span>Chat</span>
              <button type="button" onClick={() => closePanel('chat')}>Close</button>
            </header>
            <div className="panel-body">
              <ChatPanel roomId={roomId} wsUrl={wsBaseUrl} token={auth.token} />
            </div>
          </section>
        ) : null}

        {!hiddenPanels.leaderboard ? (
          <section key="leaderboard" className="panel">
            <header className="panel-header">
              <span>Leaderboard</span>
              <button type="button" onClick={() => closePanel('leaderboard')}>Close</button>
            </header>
            <div className="panel-body">
              <LeaderboardPanel
                roomId={roomId}
                wsUrl={wsBaseUrl}
                token={auth.token}
                currentUserId={auth.userId}
                currentUsername={auth.username}
              />
            </div>
          </section>
        ) : null}
      </GridLayout>
    </main>
  );
}

export default App;
