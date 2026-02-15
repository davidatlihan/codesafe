import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';

type FileExplorerProps = {
  roomId: string;
  wsUrl: string;
  token: string;
  onOpenFile?: (fileId: string, fileName: string) => void;
};

type NodeKind = 'file' | 'folder';

type TreeNode = {
  id: string;
  name: string;
  kind: NodeKind;
  parentId: string | null;
  children: string[];
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

function removeValue(array: Y.Array<string>, value: string): void {
  const index = array.toArray().indexOf(value);
  if (index >= 0) {
    array.delete(index, 1);
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function readNode(id: string, nodes: Y.Map<Y.Map<unknown>>): TreeNode | null {
  const raw = nodes.get(id);
  if (!raw) {
    return null;
  }

  const name = raw.get('name');
  const kind = raw.get('kind');
  const parentId = raw.get('parentId');
  const childrenArray = raw.get('children');

  if (
    typeof name !== 'string' ||
    (kind !== 'file' && kind !== 'folder') ||
    !(parentId === null || typeof parentId === 'string') ||
    !(childrenArray instanceof Y.Array)
  ) {
    return null;
  }

  return {
    id,
    name,
    kind,
    parentId,
    children: childrenArray.toArray()
  };
}

export default function FileExplorer({ roomId, wsUrl, token, onOpenFile }: FileExplorerProps) {
  const yDocRef = useRef<Y.Doc | null>(null);
  const nodesRef = useRef<Y.Map<Y.Map<unknown>> | null>(null);
  const rootIdsRef = useRef<Y.Array<string> | null>(null);
  const [version, setVersion] = useState(0);

  const wsAddress = useMemo(
    () => `${wsUrl}?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`,
    [roomId, token, wsUrl]
  );

  useEffect(() => {
    const yDoc = new Y.Doc();
    const nodes = yDoc.getMap<Y.Map<unknown>>('file-tree:nodes');
    const rootIds = yDoc.getArray<string>('file-tree:roots');
    const wsOrigin = { source: 'file-explorer-ws' };
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let isDisposed = false;

    yDocRef.current = yDoc;
    nodesRef.current = nodes;
    rootIdsRef.current = rootIds;

    if (rootIds.length === 0) {
      yDoc.transact(() => {
        const rootId = randomId();
        const rootNode = new Y.Map<unknown>();
        rootNode.set('name', 'project');
        rootNode.set('kind', 'folder');
        rootNode.set('parentId', null);
        rootNode.set('children', new Y.Array<string>());
        nodes.set(rootId, rootNode);
        rootIds.push([rootId]);
      });
    }

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

    const rerender = (): void => {
      setVersion((current) => current + 1);
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
    nodes.observeDeep(rerender);
    rootIds.observe(rerender);
    connectSocket();

    return () => {
      isDisposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      nodes.unobserveDeep(rerender);
      rootIds.unobserve(rerender);
      yDoc.off('update', onDocUpdate);

      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }

      yDoc.destroy();
      yDocRef.current = null;
      nodesRef.current = null;
      rootIdsRef.current = null;
    };
  }, [wsAddress]);

  const createNode = (kind: NodeKind, parentId: string | null): void => {
    const yDoc = yDocRef.current;
    const nodes = nodesRef.current;
    const rootIds = rootIdsRef.current;
    if (!yDoc || !nodes || !rootIds) {
      return;
    }

    const nameInput = window.prompt(`Enter ${kind} name`);
    const name = nameInput?.trim();
    if (!name) {
      return;
    }

    yDoc.transact(() => {
      const id = randomId();
      const node = new Y.Map<unknown>();
      node.set('name', name);
      node.set('kind', kind);
      node.set('parentId', parentId);
      node.set('children', new Y.Array<string>());
      nodes.set(id, node);

      if (parentId) {
        const parent = nodes.get(parentId);
        const children = parent?.get('children');
        if (children instanceof Y.Array) {
          children.push([id]);
        }
      } else {
        rootIds.push([id]);
      }
    });
  };

  const renameNode = (id: string): void => {
    const yDoc = yDocRef.current;
    const nodes = nodesRef.current;
    if (!yDoc || !nodes) {
      return;
    }

    const current = readNode(id, nodes);
    if (!current) {
      return;
    }

    const nameInput = window.prompt('Rename item', current.name);
    const nextName = nameInput?.trim();
    if (!nextName) {
      return;
    }

    yDoc.transact(() => {
      const node = nodes.get(id);
      node?.set('name', nextName);
    });
  };

  const deleteNode = (id: string): void => {
    const yDoc = yDocRef.current;
    const nodes = nodesRef.current;
    const rootIds = rootIdsRef.current;
    if (!yDoc || !nodes || !rootIds) {
      return;
    }

    const node = readNode(id, nodes);
    if (!node) {
      return;
    }

    const confirmed = window.confirm(`Delete "${node.name}"?`);
    if (!confirmed) {
      return;
    }

    yDoc.transact(() => {
      const stack = [id];
      while (stack.length > 0) {
        const currentId = stack.pop();
        if (!currentId) {
          continue;
        }

        const currentNode = readNode(currentId, nodes);
        if (!currentNode) {
          continue;
        }

        for (const childId of currentNode.children) {
          stack.push(childId);
        }

        nodes.delete(currentId);
      }

      if (node.parentId) {
        const parent = nodes.get(node.parentId);
        const children = parent?.get('children');
        if (children instanceof Y.Array) {
          removeValue(children, id);
        }
      } else {
        removeValue(rootIds, id);
      }
    });
  };

  const nodes = nodesRef.current;
  const rootIds = rootIdsRef.current;

  const renderNode = (id: string, depth: number): ReactElement | null => {
    if (!nodes) {
      return null;
    }

    const node = readNode(id, nodes);
    if (!node) {
      return null;
    }

    return (
      <li key={node.id}>
        <div className="tree-row" style={{ paddingLeft: `${depth * 12}px` }}>
          {node.kind === 'file' ? (
            <button type="button" className="tree-node-button" onClick={() => onOpenFile?.(node.id, node.name)}>
              [F] {node.name}
            </button>
          ) : (
            <span>[D] {node.name}</span>
          )}
          <div className="tree-actions">
            {node.kind === 'folder' ? (
              <>
                <button type="button" onClick={() => createNode('folder', node.id)}>
                  +Folder
                </button>
                <button type="button" onClick={() => createNode('file', node.id)}>
                  +File
                </button>
              </>
            ) : null}
            <button type="button" onClick={() => renameNode(node.id)}>
              Rename
            </button>
            <button type="button" onClick={() => deleteNode(node.id)}>
              Delete
            </button>
          </div>
        </div>
        {node.kind === 'folder' && node.children.length > 0 ? (
          <ul>{node.children.map((childId) => renderNode(childId, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <aside className="file-explorer" data-version={version}>
      <div className="explorer-toolbar">
        <strong>Files</strong>
        <div className="tree-actions">
          <button type="button" onClick={() => createNode('folder', null)}>
            +Root Folder
          </button>
          <button type="button" onClick={() => createNode('file', null)}>
            +Root File
          </button>
        </div>
      </div>
      <ul className="tree-root">{rootIds ? rootIds.toArray().map((id) => renderNode(id, 0)) : null}</ul>
    </aside>
  );
}
