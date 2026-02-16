import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { MonacoBinding } from 'y-monaco';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';

type SupportedLanguage = 'javascript' | 'python';

type OpenFileTab = {
  id: string;
  name: string;
};

type MonacoEditorProps = {
  roomId: string;
  defaultLanguage?: SupportedLanguage;
  wsUrl: string;
  token: string;
  userId: string;
  username: string;
  openFiles: OpenFileTab[];
  activeFileId: string | null;
  layoutVersion?: number;
  onActiveFileContextChange?: (context: {
    fileId: string;
    fileName: string;
    language: SupportedLanguage;
    content: string;
  } | null) => void;
  onActiveFileChange: (fileId: string | null) => void;
  onCloseFile: (fileId: string) => void;
};

type InlineComment = {
  id: string;
  fileId: string;
  line: number;
  text: string;
  authorId: string;
  authorName: string;
};

const MESSAGE_TYPE_SYNC = 0;
const MESSAGE_TYPE_AWARENESS = 1;

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

function getUserColor(userId: string): string {
  const palette = ['#2563eb', '#059669', '#dc2626', '#7c3aed', '#ea580c', '#0891b2'];
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash << 5) - hash + userId.charCodeAt(index);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

function inferLanguage(fileName: string, fallback: SupportedLanguage): SupportedLanguage {
  const normalized = fileName.toLowerCase();
  if (normalized.endsWith('.py')) {
    return 'python';
  }

  if (
    normalized.endsWith('.js') ||
    normalized.endsWith('.jsx') ||
    normalized.endsWith('.ts') ||
    normalized.endsWith('.tsx')
  ) {
    return 'javascript';
  }

  return fallback;
}

const JS_DOCS: Record<string, string> = {
  map: 'Array.prototype.map(callback): returns a new array transformed by callback.',
  filter: 'Array.prototype.filter(callback): returns elements that satisfy callback.',
  reduce: 'Array.prototype.reduce(callback, initial): combines array values into one.',
  forEach: 'Array.prototype.forEach(callback): iterates through each element.',
  find: 'Array.prototype.find(callback): returns the first matching element or undefined.',
  Promise: 'Promise: represents eventual completion/failure of an asynchronous operation.',
  fetch: 'fetch(url, options): performs an HTTP request and returns a Promise<Response>.',
  setTimeout: 'setTimeout(fn, ms): runs a callback after a delay in milliseconds.',
  JSON: 'JSON: utility for parsing and serializing JSON data.',
  console: 'console: browser/node logging API (log, error, warn, etc.).',
  React: 'React: library for building component-based user interfaces.'
};

const PY_DOCS: Record<string, string> = {
  print: 'print(*values): writes values to standard output.',
  len: 'len(obj): returns the number of items in a container.',
  range: 'range(start, stop, step): generates an immutable numeric sequence.',
  list: 'list(iterable): creates a mutable list.',
  dict: 'dict(...): creates a dictionary mapping keys to values.',
  set: 'set(iterable): creates a set of unique values.',
  int: 'int(value): converts a value to an integer.',
  str: 'str(value): converts a value to a string.',
  import_: 'import: loads modules so their names can be used in code.',
  asyncio: 'asyncio: standard library framework for asynchronous I/O.'
};

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export default function MonacoEditor({
  roomId,
  defaultLanguage = 'javascript',
  wsUrl,
  token,
  userId,
  username,
  openFiles,
  activeFileId,
  layoutVersion = 0,
  onActiveFileContextChange,
  onActiveFileChange,
  onCloseFile
}: MonacoEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorAliveRef = useRef(false);
  const editorBodyRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [isEditorReady, setIsEditorReady] = useState(false);

  const yDocRef = useRef<Y.Doc | null>(null);
  const yFilesRef = useRef<Y.Map<Y.Text> | null>(null);
  const yCommentsRef = useRef<Y.Map<Y.Map<unknown>> | null>(null);
  const yContributionCharsRef = useRef<Y.Map<number> | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  const modelsRef = useRef<Map<string, Monaco.editor.ITextModel>>(new Map());
  const observedTextRef = useRef<Map<string, (event: Y.YTextEvent, transaction: Y.Transaction) => void>>(new Map());
  const activeBindingRef = useRef<MonacoBinding | null>(null);
  const commentDecorationIdsRef = useRef<string[]>([]);
  const hoverDisposablesRef = useRef<Monaco.IDisposable[]>([]);
  const [commentVersion, setCommentVersion] = useState(0);

  const resolvedWsUrl = useMemo(() => wsUrl, [wsUrl]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editorAliveRef.current = true;
    editor.onDidDispose(() => {
      editorAliveRef.current = false;
      if (editorRef.current === editor) {
        editorRef.current = null;
      }
      setIsEditorReady(false);
    });
    monacoRef.current = monaco;
    setIsEditorReady(true);
  };

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) {
      return;
    }

    const provideFromDocs =
      (docs: Record<string, string>) =>
      (
        model: Monaco.editor.ITextModel,
        position: Monaco.Position
      ): Monaco.languages.ProviderResult<Monaco.languages.Hover> => {
        const word = model.getWordAtPosition(position);
        if (!word) {
          return null;
        }

        const key = word.word;
        const normalizedKey = key === 'import' ? 'import_' : key;
        const text = docs[normalizedKey];
        if (!text) {
          return null;
        }

        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: text }]
        };
      };

    hoverDisposablesRef.current.forEach((disposable) => disposable.dispose());
    hoverDisposablesRef.current = [
      monaco.languages.registerHoverProvider('javascript', {
        provideHover: provideFromDocs(JS_DOCS)
      }),
      monaco.languages.registerHoverProvider('typescript', {
        provideHover: provideFromDocs(JS_DOCS)
      }),
      monaco.languages.registerHoverProvider('python', {
        provideHover: provideFromDocs(PY_DOCS)
      })
    ];

    return () => {
      hoverDisposablesRef.current.forEach((disposable) => disposable.dispose());
      hoverDisposablesRef.current = [];
    };
  }, [isEditorReady]);

  useEffect(() => {
    if (!isEditorReady) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const safeRelayout = (): void => {
      if (!editorAliveRef.current || editorRef.current !== editor) {
        return;
      }
      editor.layout();
      editor.render(true);
    };

    let innerFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      safeRelayout();
      innerFrame = requestAnimationFrame(() => {
        safeRelayout();
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      if (innerFrame !== null) {
        cancelAnimationFrame(innerFrame);
      }
    };
  }, [isEditorReady, layoutVersion]);

  useEffect(() => {
    if (!isEditorReady) {
      return;
    }

    const editor = editorRef.current;
    const container = editorBodyRef.current;
    if (!editor || !container) {
      return;
    }

    const relayout = (): void => {
      if (!editorAliveRef.current || editorRef.current !== editor) {
        return;
      }
      editor.layout();
      editor.render(true);
    };

    relayout();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', relayout);
      return () => {
        window.removeEventListener('resize', relayout);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      relayout();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [isEditorReady]);

  useEffect(() => {
    if (!isEditorReady) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const yDoc = new Y.Doc();
    const yFiles = yDoc.getMap<Y.Text>('editor:files');
    const yComments = yDoc.getMap<Y.Map<unknown>>('editor:comments');
    const yContributionChars = yDoc.getMap<number>('editor:contrib:chars');
    const awareness = new Awareness(yDoc);
    const wsOrigin = { source: 'ws' };
    const wsAddress = `${resolvedWsUrl}?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let isDisposed = false;

    yDocRef.current = yDoc;
    yFilesRef.current = yFiles;
    yCommentsRef.current = yComments;
    yContributionCharsRef.current = yContributionChars;
    awarenessRef.current = awareness;

    awareness.setLocalStateField('user', {
      id: userId,
      name: username,
      color: getUserColor(userId)
    });

    const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === wsOrigin || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(encodeMessage(MESSAGE_TYPE_SYNC, update));
    };

    const onAwarenessUpdate = (
      {
        added,
        updated,
        removed
      }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown
    ): void => {
      if (origin === wsOrigin || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const changedClients = [...added, ...updated, ...removed];
      if (changedClients.length === 0) {
        return;
      }

      socket.send(
        encodeMessage(
          MESSAGE_TYPE_AWARENESS,
          encodeAwarenessUpdate(awareness, changedClients)
        )
      );
    };

    const onSocketMessage = (event: MessageEvent): void => {
      if (typeof event.data === 'string') {
        if (event.data === 'ping' && socket && socket.readyState === WebSocket.OPEN) {
          socket.send('pong');
        }
        return;
      }

      const data = new Uint8Array(event.data as ArrayBuffer);
      const parsed = parseMessage(data);
      if (!parsed) {
        return;
      }

      if (parsed.type === MESSAGE_TYPE_SYNC) {
        Y.applyUpdate(yDoc, parsed.payload, wsOrigin);
        return;
      }

      if (parsed.type === MESSAGE_TYPE_AWARENESS) {
        applyAwarenessUpdate(awareness, parsed.payload, wsOrigin);
      }
    };

    const onSocketOpen = (nextSocket: WebSocket): void => {
      reconnectAttempt = 0;
      nextSocket.send(encodeMessage(MESSAGE_TYPE_SYNC, Y.encodeStateAsUpdate(yDoc)));
      nextSocket.send(
        encodeMessage(
          MESSAGE_TYPE_AWARENESS,
          encodeAwarenessUpdate(awareness, [awareness.clientID])
        )
      );
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

    const onCommentsChange = (): void => {
      setCommentVersion((current) => current + 1);
    };

    yDoc.on('update', onDocUpdate);
    yComments.observeDeep(onCommentsChange);
    awareness.on('update', onAwarenessUpdate);
    connectSocket();

    return () => {
      isDisposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      awareness.off('update', onAwarenessUpdate);
      yDoc.off('update', onDocUpdate);
      yComments.unobserveDeep(onCommentsChange);

      activeBindingRef.current?.destroy();
      activeBindingRef.current = null;

      for (const model of modelsRef.current.values()) {
        model.dispose();
      }
      modelsRef.current.clear();
      for (const [fileId, observer] of observedTextRef.current.entries()) {
        const text = yFiles.get(fileId);
        if (text) {
          text.unobserve(observer);
        }
      }
      observedTextRef.current.clear();
      hoverDisposablesRef.current.forEach((disposable) => disposable.dispose());
      hoverDisposablesRef.current = [];
      commentDecorationIdsRef.current = editor.deltaDecorations(commentDecorationIdsRef.current, []);

      awareness.setLocalState(null);
      awareness.destroy();
      yDoc.destroy();

      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }

      yDocRef.current = null;
      yFilesRef.current = null;
      yCommentsRef.current = null;
      yContributionCharsRef.current = null;
      awarenessRef.current = null;
    };
  }, [isEditorReady, roomId, resolvedWsUrl, token, userId, username]);

  const activeComments = useMemo((): InlineComment[] => {
    const yComments = yCommentsRef.current;
    if (!yComments || !activeFileId) {
      return [];
    }

    const output: InlineComment[] = [];
    for (const [id, raw] of yComments.entries()) {
      const fileId = raw.get('fileId');
      const line = raw.get('line');
      const text = raw.get('text');
      const authorId = raw.get('authorId');
      const authorName = raw.get('authorName');

      if (
        typeof fileId !== 'string' ||
        typeof line !== 'number' ||
        typeof text !== 'string' ||
        typeof authorId !== 'string' ||
        typeof authorName !== 'string'
      ) {
        continue;
      }

      if (fileId !== activeFileId) {
        continue;
      }

      output.push({
        id,
        fileId,
        line,
        text,
        authorId,
        authorName
      });
    }

    return output.sort((a, b) => a.line - b.line);
  }, [activeFileId, commentVersion]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const yDoc = yDocRef.current;
    const yFiles = yFilesRef.current;
    const awareness = awarenessRef.current;

    if (!editor || !monaco || !yDoc || !yFiles || !awareness) {
      return;
    }

    // Always tear down the current binding before model set changes/disposal.
    activeBindingRef.current?.destroy();
    activeBindingRef.current = null;

    const openIdSet = new Set(openFiles.map((file) => file.id));

    for (const [fileId, model] of modelsRef.current.entries()) {
      if (!openIdSet.has(fileId)) {
        if (editor.getModel() === model) {
          editor.setModel(null);
        }
        if (!model.isDisposed()) {
          model.dispose();
        }
        modelsRef.current.delete(fileId);

        const text = yFiles.get(fileId);
        const observer = observedTextRef.current.get(fileId);
        if (text && observer) {
          text.unobserve(observer);
        }
        observedTextRef.current.delete(fileId);
      }
    }

    for (const file of openFiles) {
      let yText = yFiles.get(file.id);
      if (!yText) {
        yDoc.transact(() => {
          const created = new Y.Text();
          yFiles.set(file.id, created);
          yText = created;
        });
      }

      let existingModel = modelsRef.current.get(file.id);
      if (existingModel?.isDisposed()) {
        modelsRef.current.delete(file.id);
        existingModel = undefined;
      }

      if (!existingModel && yText) {
        const uri = monaco.Uri.parse(`inmemory://model/${encodeURIComponent(file.id)}`);
        const foundModel = monaco.editor.getModel(uri);
        const model =
          foundModel && !foundModel.isDisposed()
            ? foundModel
            : monaco.editor.createModel(yText.toString(), inferLanguage(file.name, defaultLanguage), uri);
        modelsRef.current.set(file.id, model);
      }

      if (yText && !observedTextRef.current.has(file.id)) {
        const observer = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
          if (!transaction.local) {
            return;
          }

          let insertedChars = 0;
          for (const deltaPart of event.delta) {
            if (typeof deltaPart.insert === 'string') {
              insertedChars += deltaPart.insert.length;
            }
          }

          if (insertedChars <= 0) {
            return;
          }

          const contributionMap = yContributionCharsRef.current;
          if (!contributionMap) {
            return;
          }

          const currentCount = contributionMap.get(userId) ?? 0;
          contributionMap.set(userId, currentCount + insertedChars);
        };

        yText.observe(observer);
        observedTextRef.current.set(file.id, observer);
      }

      const model = modelsRef.current.get(file.id);
      if (model && !model.isDisposed()) {
        monaco.editor.setModelLanguage(model, inferLanguage(file.name, defaultLanguage));
      }
    }

    const nextActiveId =
      activeFileId && openIdSet.has(activeFileId)
        ? activeFileId
        : openFiles.length > 0
          ? openFiles[0].id
          : null;

    if (nextActiveId !== activeFileId) {
      onActiveFileChange(nextActiveId);
      return;
    }

    if (!nextActiveId) {
      editor.setModel(null);
      return;
    }

    const nextModel = modelsRef.current.get(nextActiveId);
    const nextYText = yFiles.get(nextActiveId);
    if (!nextModel || nextModel.isDisposed() || !nextYText) {
      return;
    }

    if (editor.getModel() !== nextModel) {
      editor.setModel(nextModel);
    }

    try {
      activeBindingRef.current = new MonacoBinding(nextYText, nextModel, new Set([editor]), awareness);
    } catch {
      editor.setModel(null);
    }
  }, [activeFileId, defaultLanguage, isEditorReady, onActiveFileChange, openFiles]);

  useEffect(() => {
    if (!onActiveFileContextChange) {
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      onActiveFileContextChange(null);
      return;
    }

    const emitActiveFileContext = (): void => {
      if (!activeFileId) {
        onActiveFileContextChange(null);
        return;
      }

      const activeMeta = openFiles.find((file) => file.id === activeFileId);
      const model = editor.getModel();
      if (!activeMeta || !model) {
        onActiveFileContextChange(null);
        return;
      }

      onActiveFileContextChange({
        fileId: activeMeta.id,
        fileName: activeMeta.name,
        language: inferLanguage(activeMeta.name, defaultLanguage),
        content: model.getValue()
      });
    };

    emitActiveFileContext();
    const modelContentDisposable = editor.onDidChangeModelContent(() => {
      emitActiveFileContext();
    });
    const modelDisposable = editor.onDidChangeModel(() => {
      emitActiveFileContext();
    });

    return () => {
      modelContentDisposable.dispose();
      modelDisposable.dispose();
    };
  }, [activeFileId, defaultLanguage, onActiveFileContextChange, openFiles]);

  const addInlineComment = (line: number): void => {
    const yDoc = yDocRef.current;
    const yComments = yCommentsRef.current;
    if (!yDoc || !yComments || !activeFileId) {
      return;
    }

    const raw = window.prompt(`Comment for line ${line}`);
    const text = raw?.trim();
    if (!text) {
      return;
    }

    yDoc.transact(() => {
      const entry = new Y.Map<unknown>();
      entry.set('fileId', activeFileId);
      entry.set('line', line);
      entry.set('text', text);
      entry.set('authorId', userId);
      entry.set('authorName', username);
      yComments.set(randomId(), entry);
    });
  };

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) {
      return;
    }

    const byLine = new Map<number, InlineComment[]>();
    for (const comment of activeComments) {
      const existing = byLine.get(comment.line);
      if (existing) {
        existing.push(comment);
      } else {
        byLine.set(comment.line, [comment]);
      }
    }

    const nextDecorations = Array.from(byLine.entries()).map(([line, comments]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: 'comment-glyph',
        glyphMarginHoverMessage: {
          value: comments.map((comment) => `**${comment.authorName}**: ${comment.text}`).join('\n\n')
        }
      }
    }));

    commentDecorationIdsRef.current = editor.deltaDecorations(commentDecorationIdsRef.current, nextDecorations);
  }, [activeComments]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) {
      return;
    }

    const disposable = editor.onMouseDown((event) => {
      if (
        event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
      ) {
        const line = event.target.position?.lineNumber;
        if (line) {
          addInlineComment(line);
        }
      }
    });

    return () => {
      disposable.dispose();
    };
  }, [activeFileId, userId, username]);

  return (
    <div className="monaco-shell">
      <div className="editor-tabs" role="tablist" aria-label="Open files">
        {openFiles.map((file) => (
          <button
            key={file.id}
            type="button"
            className={`editor-tab ${activeFileId === file.id ? 'is-active' : ''}`}
            onClick={() => onActiveFileChange(file.id)}
          >
            <span>{file.name}</span>
            <span
              className="tab-close"
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                onCloseFile(file.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseFile(file.id);
                }
              }}
            >
              x
            </span>
          </button>
        ))}
      </div>
      <div ref={editorBodyRef} className="editor-body">
        {openFiles.length === 0 ? (
          <div className="editor-empty">Open a file from the explorer.</div>
        ) : (
          <Editor
            defaultLanguage={defaultLanguage}
            defaultValue=""
            height="100%"
            onMount={handleEditorMount}
            options={{
              lineNumbers: 'on',
              glyphMargin: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true
            }}
            theme="vs"
          />
        )}
      </div>
    </div>
  );
}
