import type { FileTreeNode } from '@/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CACHE_BASE = path.join(os.homedir(), '.codepilot', 'remote-cache');
const DEFAULT_MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB per connection

// ── In-memory file tree cache ──────────────────────────────────────

interface TreeCacheEntry {
  tree: FileTreeNode[];
  fetchedAt: number;
}

const treeCacheMap = new Map<string, Map<string, TreeCacheEntry>>();

function getTreeCache(connId: string): Map<string, TreeCacheEntry> {
  let cache = treeCacheMap.get(connId);
  if (!cache) {
    cache = new Map();
    treeCacheMap.set(connId, cache);
  }
  return cache;
}

export function getCachedTree(connId: string, dir: string): FileTreeNode[] | null {
  const entry = getTreeCache(connId).get(dir);
  if (!entry) return null;
  return entry.tree;
}

export function setCachedTree(connId: string, dir: string, tree: FileTreeNode[]): void {
  getTreeCache(connId).set(dir, { tree, fetchedAt: Date.now() });
}

export function invalidateTree(connId: string, dir: string): void {
  getTreeCache(connId).delete(dir);
}

export function getTreeAge(connId: string, dir: string): number | null {
  const entry = getTreeCache(connId).get(dir);
  if (!entry) return null;
  return Date.now() - entry.fetchedAt;
}

// ── Disk-backed file content cache (LRU) ────────────────────────────

interface ContentCacheIndex {
  entries: Record<string, { hash: string; size: number; accessedAt: number }>;
  totalSize: number;
}

function getCacheDir(connId: string): string {
  return path.join(CACHE_BASE, connId);
}

function getIndexPath(connId: string): string {
  return path.join(getCacheDir(connId), '_index.json');
}

function loadIndex(connId: string): ContentCacheIndex {
  const indexPath = getIndexPath(connId);
  try {
    if (fs.existsSync(indexPath)) {
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    }
  } catch { /* corrupt index, start fresh */ }
  return { entries: {}, totalSize: 0 };
}

function saveIndex(connId: string, index: ContentCacheIndex): void {
  const dir = getCacheDir(connId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getIndexPath(connId), JSON.stringify(index));
}

function pathToKey(filePath: string): string {
  // Convert file path to safe cache filename
  return Buffer.from(filePath).toString('base64url');
}

export function getCachedFile(connId: string, filePath: string): string | null {
  const index = loadIndex(connId);
  const key = pathToKey(filePath);
  const entry = index.entries[key];
  if (!entry) return null;

  const cachePath = path.join(getCacheDir(connId), key);
  try {
    if (fs.existsSync(cachePath)) {
      // Update access time for LRU
      entry.accessedAt = Date.now();
      saveIndex(connId, index);
      return fs.readFileSync(cachePath, 'utf-8');
    }
  } catch { /* read error */ }

  // Cache file missing, clean up index
  delete index.entries[key];
  index.totalSize = Math.max(0, index.totalSize - (entry.size || 0));
  saveIndex(connId, index);
  return null;
}

export function setCachedFile(connId: string, filePath: string, content: string, hash: string): void {
  const dir = getCacheDir(connId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const index = loadIndex(connId);
  const key = pathToKey(filePath);
  const size = Buffer.byteLength(content, 'utf-8');

  // Remove old entry size if exists
  if (index.entries[key]) {
    index.totalSize -= index.entries[key].size;
  }

  // Evict LRU entries if over limit
  while (index.totalSize + size > DEFAULT_MAX_CACHE_SIZE) {
    const entries = Object.entries(index.entries);
    if (entries.length === 0) break;

    // Find least recently accessed
    entries.sort((a, b) => a[1].accessedAt - b[1].accessedAt);
    const [evictKey, evictEntry] = entries[0];
    const evictPath = path.join(dir, evictKey);
    try { fs.unlinkSync(evictPath); } catch { /* ignore */ }
    index.totalSize -= evictEntry.size;
    delete index.entries[evictKey];
  }

  // Write file content
  fs.writeFileSync(path.join(dir, key), content);
  index.entries[key] = { hash, size, accessedAt: Date.now() };
  index.totalSize += size;
  saveIndex(connId, index);
}

export function invalidateFile(connId: string, filePath: string): void {
  const index = loadIndex(connId);
  const key = pathToKey(filePath);
  const entry = index.entries[key];
  if (entry) {
    const cachePath = path.join(getCacheDir(connId), key);
    try { fs.unlinkSync(cachePath); } catch { /* ignore */ }
    index.totalSize -= entry.size;
    delete index.entries[key];
    saveIndex(connId, index);
  }
}

export function invalidateAll(connId: string): void {
  treeCacheMap.delete(connId);
  const dir = getCacheDir(connId);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

export function getCacheStats(connId: string): { treeEntries: number; fileEntries: number; totalSize: number } {
  const treeCache = treeCacheMap.get(connId);
  const index = loadIndex(connId);
  return {
    treeEntries: treeCache?.size || 0,
    fileEntries: Object.keys(index.entries).length,
    totalSize: index.totalSize,
  };
}

// ── Git status cache (in-memory, short TTL) ────────────────────────

interface GitStatusCacheEntry {
  data: unknown;
  fetchedAt: number;
}

const gitStatusCache = new Map<string, GitStatusCacheEntry>();
const GIT_STATUS_TTL = 5000; // 5 seconds

export function getCachedGitStatus(connId: string, dir: string): unknown | null {
  const key = `${connId}:${dir}`;
  const entry = gitStatusCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > GIT_STATUS_TTL) {
    gitStatusCache.delete(key);
    return null;
  }
  return entry.data;
}

export function setCachedGitStatus(connId: string, dir: string, data: unknown): void {
  gitStatusCache.set(`${connId}:${dir}`, { data, fetchedAt: Date.now() });
}

export function invalidateGitStatus(connId: string, dir: string): void {
  gitStatusCache.delete(`${connId}:${dir}`);
}
