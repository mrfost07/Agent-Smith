/**
 * IndexedDB Storage Layer using `idb`
 * Database: `pilotpanel`
 * Stores: sessions, messages, images, modelContext
 */

import { openDB, IDBPDatabase } from 'idb';
import { Session, StoredMessage, StoredImage } from './types';

const DB_NAME = 'pilotpanel';
const CURRENT_SCHEMA_VERSION = 2;
let connection: Promise<IDBPDatabase> | undefined;

export async function getDb(): Promise<IDBPDatabase> {
  if (connection) return connection;
  const opened = openDB(DB_NAME, CURRENT_SCHEMA_VERSION, {
    upgrade(db, oldVersion, newVersion) {
      // 1. Sessions store
      if (!db.objectStoreNames.contains('sessions')) {
        const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' });
        sessionStore.createIndex('updatedAt', 'updatedAt');
        sessionStore.createIndex('status', 'status');
        sessionStore.createIndex('pinned', 'pinned');
        sessionStore.createIndex('archived', 'archived');
      }

      // 2. Messages store
      if (!db.objectStoreNames.contains('messages')) {
        const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
        msgStore.createIndex('sessionId', 'sessionId');
        msgStore.createIndex('sessionSeq', ['sessionId', 'seq']);
        msgStore.createIndex('ts', 'ts');
      }

      // 3. Images store
      if (!db.objectStoreNames.contains('images')) {
        const imgStore = db.createObjectStore('images', { keyPath: 'id' });
        imgStore.createIndex('sessionId', 'sessionId');
        imgStore.createIndex('ts', 'ts');
      }

      // 4. Model context store (compacted message array for LLM)
      if (!db.objectStoreNames.contains('modelContext')) {
        db.createObjectStore('modelContext', { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains('trading')) {
        db.createObjectStore('trading', { keyPath: 'sessionId' });
      }
    },
    blocking() {
      void opened.then(db => db.close()).catch(() => {});
      if (connection === opened) connection = undefined;
    },
    terminated() {
      if (connection === opened) connection = undefined;
    },
  });
  connection = opened;
  try {
    return await opened;
  } catch (error) {
    if (connection === opened) connection = undefined;
    throw error;
  }
}

// ============================================================================
// Sessions API
// ============================================================================

export async function saveSession(session: Session): Promise<void> {
  const db = await getDb();
  await db.put('sessions', session);
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = await getDb();
  return db.get('sessions', id);
}

export async function editSession(id: string, edit: (session: Session) => void): Promise<Session | undefined> {
  const db = await getDb();
  const tx = db.transaction('sessions', 'readwrite');
  const session = await tx.store.get(id);
  if (session) {
    edit(session);
    await tx.store.put(session);
  }
  await tx.done;
  return session;
}

export async function getAllSessions(): Promise<Session[]> {
  const db = await getDb();
  const tx = db.transaction('sessions', 'readonly');
  const index = tx.store.index('updatedAt');
  const all = await index.getAll();
  return all.reverse(); // Newest first
}

export async function deleteSessionFull(sessionId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['sessions', 'messages', 'images', 'modelContext', 'trading'], 'readwrite');

  // 1. Delete session record
  await tx.objectStore('sessions').delete(sessionId);

  // 2. Delete messages
  const msgIdx = tx.objectStore('messages').index('sessionId');
  let msgCursor = await msgIdx.openCursor(sessionId);
  while (msgCursor) {
    await msgCursor.delete();
    msgCursor = await msgCursor.continue();
  }

  // 3. Delete images
  const imgIdx = tx.objectStore('images').index('sessionId');
  let imgCursor = await imgIdx.openCursor(sessionId);
  while (imgCursor) {
    await imgCursor.delete();
    imgCursor = await imgCursor.continue();
  }

  // 4. Delete modelContext
  await tx.objectStore('modelContext').delete(sessionId);
  await tx.objectStore('trading').delete(sessionId);

  await tx.done;
}

export async function deleteSessionScreenshots(sessionId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('images', 'readwrite');
  const imgIdx = tx.store.index('sessionId');
  let cursor = await imgIdx.openCursor(sessionId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

// ============================================================================
// Messages API
// ============================================================================

export async function saveMessage(msg: StoredMessage): Promise<void> {
  const db = await getDb();
  await db.put('messages', msg);
}

export async function appendSessionMessage(msg: StoredMessage): Promise<Session> {
  const db = await getDb();
  const tx = db.transaction(['sessions', 'messages'], 'readwrite');
  const sessions = tx.objectStore('sessions');
  const messages = tx.objectStore('messages');
  const session = await sessions.get(msg.sessionId);
  if (!session) throw new Error('The saved session no longer exists.');
  const range = IDBKeyRange.bound([msg.sessionId, 0], [msg.sessionId, Infinity]);
  const last = await messages.index('sessionSeq').openCursor(range, 'prev');
  msg.seq = (last?.value.seq ?? 0) + 1;
  if (msg.kind === 'step') session.stepCount++;
  session.updatedAt = msg.ts;
  await messages.put(msg);
  await sessions.put(session);
  await tx.done;
  return session;
}

export async function getSessionMessages(sessionId: string): Promise<StoredMessage[]> {
  const db = await getDb();
  const tx = db.transaction('messages', 'readonly');
  const index = tx.store.index('sessionSeq');
  const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
  const messages = await index.getAll(range);
  // Earlier extension versions could reset seq when the service worker restarted.
  return messages.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}

// ============================================================================
// Images API (Thumbnails + 5 Full-Size FIFO Pruning)
// ============================================================================

export async function saveImage(img: StoredImage): Promise<void> {
  const db = await getDb();
  await db.put('images', img);

  // Enforce policy: Keep full-size screenshots only for the last 5 steps per session
  await pruneOlderFullImages(img.sessionId, 5);
}

export async function getImage(id: string): Promise<StoredImage | undefined> {
  const db = await getDb();
  return db.get('images', id);
}

async function pruneOlderFullImages(sessionId: string, keepCount: number): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction('images', 'readwrite');
    const index = tx.store.index('sessionId');
    const images: StoredImage[] = await index.getAll(sessionId);

    if (images.length > keepCount) {
      // Sort oldest first
      images.sort((a, b) => a.ts - b.ts);
      const toPrune = images.slice(0, images.length - keepCount);
      for (const item of toPrune) {
        // Strip full-size blob, keeping thumbnail intact
        item.blob = '';
        await tx.store.put(item);
      }
    }
    await tx.done;
  } catch (err) {
    console.warn('[DB] pruneOlderFullImages error:', err);
  }
}

// ============================================================================
// Model Context API
// ============================================================================

export async function saveModelContext(sessionId: string, context: any[]): Promise<void> {
  const db = await getDb();
  await db.put('modelContext', { sessionId, context, updatedAt: Date.now() });
}

export async function getModelContext(sessionId: string): Promise<any[] | null> {
  const db = await getDb();
  const record = await db.get('modelContext', sessionId);
  return record?.context || null;
}

// ============================================================================
// Data Retention & Cleanup (Default 90 days, skip pinned)
// ============================================================================

export async function cleanupExpiredSessions(retentionDays = 90): Promise<number> {
  if (retentionDays <= 0) return 0; // 'forever'
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const db = await getDb();
  const allSessions = await db.getAll('sessions');
  let purgedCount = 0;

  for (const session of allSessions) {
    if (!session.pinned && session.updatedAt < cutoff) {
      await deleteSessionFull(session.id);
      purgedCount++;
    }
  }

  if (purgedCount > 0) {
    console.log(`[DB] Purged ${purgedCount} sessions older than ${retentionDays} days.`);
  }
  return purgedCount;
}

export async function clearAllData(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['sessions', 'messages', 'images', 'modelContext', 'trading'], 'readwrite');
  await tx.objectStore('sessions').clear();
  await tx.objectStore('messages').clear();
  await tx.objectStore('images').clear();
  await tx.objectStore('modelContext').clear();
  await tx.objectStore('trading').clear();
  await tx.done;
}

export async function getStorageStats(): Promise<{ usedBytes: number; quotaBytes: number; percent: number }> {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    const usedBytes = estimate.usage || 0;
    const quotaBytes = estimate.quota || 1;
    const percent = Math.min(100, Math.round((usedBytes / quotaBytes) * 100));
    return { usedBytes, quotaBytes, percent };
  }
  return { usedBytes: 0, quotaBytes: 1, percent: 0 };
}
