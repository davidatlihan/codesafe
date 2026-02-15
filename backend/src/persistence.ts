import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import * as Y from 'yjs';
import {
  FileModel,
  ProjectModel,
  type Role,
  SuggestionModel,
  UserModel
} from './models.js';

let dbConnectionPromise: Promise<boolean> | null = null;

type PersistedUser = {
  _id?: unknown;
  role?: unknown;
};

type PersistedProject = {
  permissions?: unknown;
};

function isRole(value: unknown): value is Role {
  return value === 'viewer' || value === 'editor' || value === 'admin';
}

function sanitizePathSegment(segment: string): string {
  const cleaned = segment.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'untitled';
}

function pushUnique(yArray: Y.Array<string>, value: string): void {
  if (!yArray.toArray().includes(value)) {
    yArray.push([value]);
  }
}

function buildFilePathFromTree(fileId: string, treeNodes: Y.Map<Y.Map<unknown>>): string | null {
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

export async function ensureDbConnection(): Promise<boolean> {
  if (dbConnectionPromise) {
    return dbConnectionPromise;
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    dbConnectionPromise = Promise.resolve(false);
    return dbConnectionPromise;
  }

  dbConnectionPromise = mongoose
    .connect(mongoUri)
    .then(() => true)
    .catch((error: unknown) => {
      console.error('MongoDB connection failed:', error);
      return false;
    });

  return dbConnectionPromise ?? Promise.resolve(false);
}

export async function findOrCreateUserByUsername(
  username: string
): Promise<{ userId: string; username: string; role: Role }> {
  const connected = await ensureDbConnection();
  const cleanUsername = username.trim();

  if (!connected) {
    return { userId: randomUUID(), username: cleanUsername, role: 'editor' };
  }

  const hasAdmin = await UserModel.exists({ role: 'admin' });
  const existing = (await UserModel.findOne({ username: cleanUsername }).lean()) as PersistedUser | null;
  if (existing?._id) {
    const existingRole = isRole(existing.role) ? existing.role : 'editor';
    return { userId: String(existing._id), username: cleanUsername, role: existingRole };
  }

  const userId = randomUUID();
  const assignedRole: Role = hasAdmin ? 'editor' : 'admin';
  await UserModel.create({
    _id: userId,
    username: cleanUsername,
    avatar: '',
    join_date: new Date(),
    role: assignedRole
  });

  return { userId, username: cleanUsername, role: assignedRole };
}

export async function loadProjectState(
  projectId: string,
  doc: Y.Doc
): Promise<Map<string, Role>> {
  const connected = await ensureDbConnection();
  if (!connected) {
    return new Map<string, Role>();
  }

  const now = new Date();
  await ProjectModel.updateOne(
    { _id: projectId },
    {
      $setOnInsert: {
        _id: projectId,
        name: projectId,
        created_at: now,
        updated_at: now,
        permissions: {}
      }
    },
    { upsert: true }
  );

  const project = (await ProjectModel.findById(projectId).lean()) as PersistedProject | null;
  const files = await FileModel.find({ project_id: projectId }).lean();
  const suggestions = await SuggestionModel.find({ project_id: projectId }).lean();

  const permissionEntries: Array<[string, Role]> = [];
  if (project?.permissions instanceof Map) {
    for (const [userId, role] of project.permissions.entries()) {
      if (typeof userId === 'string' && isRole(role)) {
        permissionEntries.push([userId, role]);
      }
    }
  } else if (project && typeof project.permissions === 'object' && project.permissions !== null) {
    const plainPermissions = project.permissions as Record<string, unknown>;
    for (const [userId, role] of Object.entries(plainPermissions)) {
      if (typeof userId === 'string' && isRole(role)) {
        permissionEntries.push([userId, role]);
      }
    }
  }

  const yFiles = doc.getMap<Y.Text>('editor:files');
  const treeNodes = doc.getMap<Y.Map<unknown>>('file-tree:nodes');
  const rootIds = doc.getArray<string>('file-tree:roots');
  const ySuggestions = doc.getMap<Y.Map<unknown>>('editor:suggestions');

  doc.transact(() => {
    yFiles.clear();
    treeNodes.clear();
    ySuggestions.clear();
    rootIds.delete(0, rootIds.length);

    for (const file of files) {
      const fileId = String(file._id);
      const content = typeof file.content === 'string' ? file.content : '';
      const path = typeof file.path === 'string' ? file.path : fileId;
      const parts = path.split('/').filter((part: string) => part.length > 0);

      const yText = new Y.Text();
      yText.insert(0, content);
      yFiles.set(fileId, yText);

      let parentFolderId: string | null = null;
      const folderParts = parts.slice(0, Math.max(0, parts.length - 1));
      for (let index = 0; index < folderParts.length; index += 1) {
        const folderPath = folderParts.slice(0, index + 1).join('/');
        const folderId = `folder:${folderPath}`;
        const folderName = folderParts[index];

        let folderNode = treeNodes.get(folderId);
        if (!folderNode) {
          folderNode = new Y.Map<unknown>();
          folderNode.set('name', folderName);
          folderNode.set('kind', 'folder');
          folderNode.set('parentId', parentFolderId);
          folderNode.set('children', new Y.Array<string>());
          treeNodes.set(folderId, folderNode);

          if (parentFolderId) {
            const parentNode = treeNodes.get(parentFolderId);
            const children = parentNode?.get('children');
            if (children instanceof Y.Array) {
              pushUnique(children, folderId);
            }
          } else {
            pushUnique(rootIds, folderId);
          }
        }

        parentFolderId = folderId;
      }

      const fileName = parts.length > 0 ? parts[parts.length - 1] : fileId;
      const fileNode = new Y.Map<unknown>();
      fileNode.set('name', fileName);
      fileNode.set('kind', 'file');
      fileNode.set('parentId', parentFolderId);
      fileNode.set('children', new Y.Array<string>());
      treeNodes.set(fileId, fileNode);

      if (parentFolderId) {
        const parentNode = treeNodes.get(parentFolderId);
        const children = parentNode?.get('children');
        if (children instanceof Y.Array) {
          pushUnique(children, fileId);
        }
      } else {
        pushUnique(rootIds, fileId);
      }
    }

    for (const suggestion of suggestions) {
      const suggestionId = String(suggestion._id);
      const fileId = typeof suggestion.file_id === 'string' ? suggestion.file_id : '';
      const creatorId = typeof suggestion.creator_id === 'string' ? suggestion.creator_id : '';
      const text = typeof suggestion.text === 'string' ? suggestion.text : '';
      if (!fileId || !creatorId || !text) {
        continue;
      }

      const entry = new Y.Map<unknown>();
      entry.set('fileId', fileId);
      entry.set('startLine', 1);
      entry.set('endLine', 1);
      entry.set('text', text);
      entry.set('authorId', creatorId);
      entry.set('authorName', creatorId.slice(0, 8));

      const votesMap = new Y.Map<number>();
      if (suggestion.votes instanceof Map) {
        for (const [voteUserId, vote] of suggestion.votes.entries()) {
          if (typeof voteUserId === 'string' && typeof vote === 'number') {
            votesMap.set(voteUserId, vote);
          }
        }
      }
      entry.set('votes', votesMap);

      ySuggestions.set(suggestionId, entry);
    }
  });

  return new Map<string, Role>(permissionEntries);
}

export async function persistProjectState(projectId: string, doc: Y.Doc): Promise<void> {
  const connected = await ensureDbConnection();
  if (!connected) {
    return;
  }

  const now = new Date();
  await ProjectModel.updateOne(
    { _id: projectId },
    {
      $setOnInsert: {
        _id: projectId,
        name: projectId,
        created_at: now
      },
      $set: {
        updated_at: now
      }
    },
    { upsert: true }
  );

  const yFiles = doc.getMap<Y.Text>('editor:files');
  const treeNodes = doc.getMap<Y.Map<unknown>>('file-tree:nodes');
  const ySuggestions = doc.getMap<Y.Map<unknown>>('editor:suggestions');

  const fileRows: Array<{ _id: string; path: string; content: string }> = [];
  for (const [fileId, yText] of yFiles.entries()) {
    const treePath = buildFilePathFromTree(fileId, treeNodes);
    const fallbackName = `${sanitizePathSegment(fileId)}.txt`;
    fileRows.push({
      _id: fileId,
      path: treePath ?? `files/${fallbackName}`,
      content: yText.toString()
    });
  }

  if (fileRows.length > 0) {
    await FileModel.bulkWrite(
      fileRows.map((file) => ({
        updateOne: {
          filter: { _id: file._id },
          update: {
            $set: {
              project_id: projectId,
              path: file.path,
              content: file.content
            }
          },
          upsert: true
        }
      }))
    );
  }

  const fileIds = fileRows.map((file) => file._id);
  await FileModel.deleteMany({
    project_id: projectId,
    _id: { $nin: fileIds }
  });

  const suggestionRows: Array<{
    _id: string;
    file_id: string;
    creator_id: string;
    text: string;
    votes: Map<string, number>;
    authorName: string;
  }> = [];

  for (const [suggestionId, raw] of ySuggestions.entries()) {
    const fileId = raw.get('fileId');
    const creatorId = raw.get('authorId');
    const text = raw.get('text');
    const votesRaw = raw.get('votes');
    const authorName = raw.get('authorName');

    if (
      typeof fileId !== 'string' ||
      typeof creatorId !== 'string' ||
      typeof text !== 'string' ||
      !(votesRaw instanceof Y.Map)
    ) {
      continue;
    }

    const votes = new Map<string, number>();
    for (const [voteUserId, voteValue] of votesRaw.entries()) {
      if (typeof voteUserId === 'string' && typeof voteValue === 'number') {
        votes.set(voteUserId, voteValue);
      }
    }

    suggestionRows.push({
      _id: suggestionId,
      file_id: fileId,
      creator_id: creatorId,
      text,
      votes,
      authorName: typeof authorName === 'string' ? authorName : creatorId
    });
  }

  if (suggestionRows.length > 0) {
    await SuggestionModel.bulkWrite(
      suggestionRows.map((suggestion) => ({
        updateOne: {
          filter: { _id: suggestion._id },
          update: {
            $set: {
              project_id: projectId,
              file_id: suggestion.file_id,
              creator_id: suggestion.creator_id,
              text: suggestion.text,
              votes: suggestion.votes
            }
          },
          upsert: true
        }
      }))
    );

    await UserModel.bulkWrite(
      suggestionRows.map((suggestion) => ({
        updateOne: {
          filter: { _id: suggestion.creator_id },
          update: {
            $set: {
              username: suggestion.authorName
            },
            $setOnInsert: {
              avatar: '',
              join_date: new Date()
            }
          },
          upsert: true
        }
      }))
    );
  }

  const suggestionIds = suggestionRows.map((suggestion) => suggestion._id);
  await SuggestionModel.deleteMany({
    project_id: projectId,
    _id: { $nin: suggestionIds }
  });
}

export async function setProjectPermission(
  projectId: string,
  userId: string,
  role: Role
): Promise<void> {
  const connected = await ensureDbConnection();
  if (!connected) {
    return;
  }

  await ProjectModel.updateOne(
    { _id: projectId },
    {
      $set: {
        [`permissions.${userId}`]: role,
        updated_at: new Date()
      },
      $setOnInsert: {
        _id: projectId,
        name: projectId,
        created_at: new Date()
      }
    },
    { upsert: true }
  );
}
