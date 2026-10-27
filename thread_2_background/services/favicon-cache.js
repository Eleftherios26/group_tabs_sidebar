// Favicon Cache (V24) – Αποφυγή περιττών FAVICON_READY, έλεγχος υπάρχοντος cache πριν την αποθήκευση
console.log('[FaviconCache V24] Module loaded');

const DB_NAME = 'FaviconCacheV13';
const STORE_NAME = 'favicons';
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 ημέρες

const _pendingCacheHostnames = new Set();
const _cachedHostnames = new Set();
const _pendingSaves = new Set();

let dbPromise = null;

function openDB() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (database.objectStoreNames.contains(STORE_NAME)) {
        database.deleteObjectStore(STORE_NAME);
      }
      database.createObjectStore(STORE_NAME, { keyPath: 'hostname' });
    };

    request.onsuccess = (event) => {
      const database = event.target.result;
      cleanOldEntries(database).then(() => resolve(database));
    };

    request.onerror = (event) => {
      console.error('[FaviconCache V24] openDB: error', event.target.error);
      dbPromise = null;
      reject(event.target.error);
    };
  });

  return dbPromise;
}

async function cleanOldEntries(database) {
  const tx = database.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const now = Date.now();
  let removedCount = 0;

  return new Promise((resolve) => {
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.timestamp && (now - cursor.value.timestamp > MAX_CACHE_AGE_MS)) {
          cursor.delete();
          removedCount++;
        }
        cursor.continue();
      } else {
        if (removedCount > 0) console.log(`[FaviconCache V24] cleanOldEntries: removed ${removedCount} old entries`);
        resolve();
      }
    };
    cursorRequest.onerror = () => resolve();
  });
}

async function getAverageColorFromBlob(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width === 0 || bitmap.height === 0) return null;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const data = imageData.data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
    }
    if (count === 0) return null;
    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  } catch (e) {
    return null;
  }
}

const FaviconCache = {
  async cacheFavicon(hostname, faviconUrl) {
    if (!hostname || !faviconUrl) return;

    // V24: Έλεγχος αν το favicon είναι ήδη cached με το ίδιο dataUrl
    const existing = await this.getCachedFavicon(hostname);
    if (existing && existing.dataUrl === faviconUrl) {
      console.log(`[FaviconCache V24] cacheFavicon: skipping duplicate for ${hostname} (identical dataUrl)`);
      return;
    }

    const savePromise = this._doCache(hostname, faviconUrl);
    _pendingSaves.add(savePromise);
    savePromise.finally(() => _pendingSaves.delete(savePromise));
    return savePromise;
  },

  async _doCache(hostname, faviconUrl) {
    if (_pendingCacheHostnames.has(hostname)) {
      console.log('[FaviconCache V24] cacheFavicon: already pending for', hostname);
      return;
    }
    _pendingCacheHostnames.add(hostname);

    try {
      const parsed = new URL(faviconUrl);

      if (!['data:', 'moz-extension:'].includes(parsed.protocol)) {
        console.log('[FaviconCache V24] cacheFavicon: rejecting remote URL', parsed.protocol);
        return;
      }

      if (parsed.protocol === 'data:') {
        const database = await openDB();
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        await new Promise((resolve, reject) => {
          const putRequest = store.put({
            hostname,
            dataUrl: faviconUrl,
            color: null,
            timestamp: Date.now()
          });
          putRequest.onsuccess = () => {
            _cachedHostnames.add(hostname);
            resolve();
          };
          putRequest.onerror = (e) => reject(e);
        });
        return;
      }

      if (parsed.protocol === 'moz-extension:') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch(faviconUrl, { cache: 'force-cache', signal: controller.signal });
          clearTimeout(timeout);
          if (!response.ok) return;

          const blob = await response.blob();
          const [color, dataUrl] = await Promise.all([
            getAverageColorFromBlob(blob),
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            })
          ]);

          const database = await openDB();
          const tx = database.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          await new Promise((resolve, reject) => {
            const putRequest = store.put({
              hostname,
              dataUrl,
              color: color || null,
              timestamp: Date.now()
            });
            putRequest.onsuccess = () => {
              _cachedHostnames.add(hostname);
              resolve();
            };
            putRequest.onerror = (e) => reject(e);
          });
        } catch (e) {
          if (e.name !== 'AbortError') {
            console.warn('[FaviconCache V24] cacheFavicon error:', hostname, e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[FaviconCache V24] cacheFavicon: invalid URL', faviconUrl);
    } finally {
      _pendingCacheHostnames.delete(hostname);
    }
  },

  async getCachedFavicon(hostname) {
    if (!hostname) return null;
    try {
      const database = await openDB();
      const tx = database.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const entry = await new Promise((resolve, reject) => {
        const req = store.get(hostname);
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
      });
      if (entry && entry.dataUrl) {
        _cachedHostnames.add(hostname);
        return { dataUrl: entry.dataUrl, color: entry.color || null };
      }
      return null;
    } catch (e) {
      console.error('[FaviconCache V24] getCachedFavicon error:', e);
      return null;
    }
  },

  async waitForAllPending() {
    if (_pendingSaves.size > 0) {
      console.log(`[FaviconCache V24] Waiting for ${_pendingSaves.size} pending favicon saves...`);
      await Promise.all(Array.from(_pendingSaves));
      console.log('[FaviconCache V24] All pending favicon saves completed');
    }
  }
};

self.FaviconCache = FaviconCache;