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

type ListedRoom = {
  id: string;
  name: string;
  updatedAt: string;
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

function defaultApiBaseUrl(): string {
  const { protocol, hostname, origin } = window.location;
  const isLocalhost =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0';

  if (isLocalhost) {
    return 'http://localhost:4000';
  }

  if (protocol === 'https:' || protocol === 'http:') {
    return origin;
  }

  return 'http://localhost:4000';
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

function normalizeRoomId(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return '';
  }

  const sanitized = trimmed.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return sanitized;
}

function App() {
  const query = new URLSearchParams(window.location.search);
  const initialRoomId = normalizeRoomId(query.get('room') ?? '');
  const defaultLanguage = query.get('lang') === 'python' ? 'python' : 'javascript';
  const [username, setUsername] = useState('');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialRoomId || null
  );
  const [projectNameInput, setProjectNameInput] = useState('');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ListedRoom[]>([]);
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const [layout, setLayout] = useState<GridLayoutItem[]>(safeReadLayout);
  const [hiddenPanels, setHiddenPanels] = useState<HiddenPanels>(safeReadHiddenPanels);
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const apiBaseUrl = useMemo(() => {
    const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
    return env.VITE_API_URL ?? defaultApiBaseUrl();
  }, []);

  const wsBaseUrl = useMemo(() => {
    const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
    return env.VITE_WS_URL ?? toWsUrl(apiBaseUrl);
  }, [apiBaseUrl]);

  const resetOpenTabs = (): void => {
    setOpenTabs([]);
    setActiveTabId(null);
  };

  const applyRoomChange = (nextRoomRaw: string): void => {
    const nextRoom = normalizeRoomId(nextRoomRaw);
    if (!nextRoom) {
      setProjectError('Project is required');
      return;
    }

    setProjectError(null);
    setSelectedProjectId(nextRoom);
    resetOpenTabs();

    const nextQuery = new URLSearchParams(window.location.search);
    nextQuery.set('room', nextRoom);
    window.history.replaceState({}, '', `${window.location.pathname}?${nextQuery.toString()}`);
  };

  const refreshProjects = async (authToken: string): Promise<void> => {
    setIsProjectLoading(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects`, {
        headers: {
          Authorization: `Bearer ${authToken}`
        }
      });
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as { projects?: ListedRoom[] };
      if (!Array.isArray(data.projects)) {
        return;
      }
      setProjects(data.projects);
    } catch {
      // Ignore project list refresh errors in UI.
    } finally {
      setIsProjectLoading(false);
    }
  };

  const handleCreateProject = async (): Promise<void> => {
    const nextName = projectNameInput.trim();
    if (!auth) {
      return;
    }
    if (!nextName) {
      setProjectError('Project name is required');
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`
        },
        body: JSON.stringify({
          name: nextName
        })
      });

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(bodyText || `Failed to create project (${response.status})`);
      }

      const data = (await response.json()) as { project?: { id?: string; name?: string } };
      const projectId = data.project?.id;
      if (!projectId) {
        throw new Error('Invalid project response');
      }
      setProjectNameInput('');
      await refreshProjects(auth.token);
      applyRoomChange(projectId);
    } catch (caughtError: unknown) {
      if (caughtError instanceof Error) {
        setProjectError(caughtError.message);
      } else {
        setProjectError('Failed to create project');
      }
    }
  };

  const handleRenameProject = async (projectId: string, currentName: string): Promise<void> => {
    if (!auth) {
      return;
    }

    const rawName = window.prompt('Rename project', currentName);
    const nextName = rawName?.trim();
    if (!nextName || nextName === currentName) {
      return;
    }

    const response = await fetch(`${apiBaseUrl}/api/projects/${encodeURIComponent(projectId)}/rename`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`
      },
      body: JSON.stringify({ name: nextName })
    });
    if (!response.ok) {
      const bodyText = await response.text();
      setProjectError(bodyText || 'Failed to rename project');
      return;
    }
    setProjectError(null);
    await refreshProjects(auth.token);
  };

  const handleDeleteProject = async (projectId: string, name: string): Promise<void> => {
    if (!auth) {
      return;
    }
    if (!window.confirm(`Delete project "${name}"?`)) {
      return;
    }

    const response = await fetch(`${apiBaseUrl}/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${auth.token}`
      }
    });
    if (!response.ok) {
      const bodyText = await response.text();
      setProjectError(bodyText || 'Failed to delete project');
      return;
    }
    if (selectedProjectId === projectId) {
      setSelectedProjectId(null);
    }
    setProjectError(null);
    await refreshProjects(auth.token);
  };

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
      const loginUrl = `${apiBaseUrl}/api/auth/login`;
      const response = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username: username.trim() })
      });

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(`Login failed (${response.status}) via ${loginUrl}: ${bodyText || response.statusText}`);
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
      await refreshProjects(data.token);
    } catch (caughtError: unknown) {
      if (caughtError instanceof Error) {
        setError(caughtError.message);
      } else {
        setError(`Unable to login via ${apiBaseUrl}/api/auth/login`);
      }
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
    if (!auth || !selectedProjectId) {
      return;
    }

    try {
      const response = await fetch(
        `${apiBaseUrl}/api/projects/${encodeURIComponent(selectedProjectId)}/export`,
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
      anchor.download = `${selectedProjectId}.zip`;
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

  if (!selectedProjectId) {
    return (
      <main className="login-shell">
        <section className="login-form">
          <label htmlFor="project-name">Project Name</label>
          <input
            id="project-name"
            value={projectNameInput}
            onChange={(event) => setProjectNameInput(event.target.value)}
            placeholder="Create new project"
            autoComplete="off"
          />
          <button type="button" onClick={() => void handleCreateProject()} disabled={isProjectLoading}>
            Create Project
          </button>
          <button type="button" onClick={() => void refreshProjects(auth.token)} disabled={isProjectLoading}>
            Refresh Projects
          </button>
          <div className="room-list">
            {projects.map((project) => (
              <div key={project.id} className="tree-row">
                <button type="button" className="tree-node-button" onClick={() => applyRoomChange(project.id)}>
                  {project.name}
                </button>
                <div className="tree-actions">
                  <button type="button" onClick={() => void handleRenameProject(project.id, project.name)}>
                    Rename
                  </button>
                  <button type="button" onClick={() => void handleDeleteProject(project.id, project.name)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
          {projectError ? <p>{projectError}</p> : null}
        </section>
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
        <span className="room-label">Project: {selectedProjectId}</span>
        <button type="button" onClick={handleDownloadProject}>
          Download Project
        </button>
        <button type="button" onClick={() => setSelectedProjectId(null)}>
          Change Project
        </button>
        {panelMeta
          .filter((panel) => hiddenPanels[panel.key])
          .map((panel) => (
            <button key={panel.key} type="button" onClick={() => reopenPanel(panel.key)}>
              Show {panel.label}
            </button>
          ))}
        <span>{auth.username}</span>
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
                roomId={selectedProjectId}
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
                roomId={selectedProjectId}
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
                roomId={selectedProjectId}
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
              <ChatPanel roomId={selectedProjectId} wsUrl={wsBaseUrl} token={auth.token} />
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
                roomId={selectedProjectId}
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
