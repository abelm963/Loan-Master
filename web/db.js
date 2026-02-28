const DB_NAME = 'loan-master-db';
const DB_VERSION = 1;
const QUEUE_STORE = 'queue';
const CACHE_STORE = 'cache';

let dbPromise;

export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

export async function queueAdd(item) {
  const store = await tx(QUEUE_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.add(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function queueList() {
  const store = await tx(QUEUE_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function queueDelete(id) {
  const store = await tx(QUEUE_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheSet(key, value) {
  const store = await tx(CACHE_STORE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ key, value, updatedAt: new Date().toISOString() });
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet(key) {
  const store = await tx(CACHE_STORE, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}
