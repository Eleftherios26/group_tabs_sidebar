// Central Logger (V17) – Persistent σφάλματα/προειδοποιήσεις, sessionId, IndexedDB
// V17: Αποθήκευση logs σε IndexedDB (LogDatabase / logs) αντί για storage.local.
//      Το storage.local χρησιμοποιείται μόνο για persistent counters.
//      Τα logs διατηρούνται για 30 ημέρες, με αυτόματο cleanup κάθε 1 ώρα.
//      Το sessionId αποθηκεύεται στο storage.session (διατηρείται όσο ο Firefox είναι ανοιχτός).
(function() {
  'use strict';

  const DB_NAME = 'LogDatabase';
  const DB_VERSION = 1;
  const STORE_NAME = 'logs';
  const LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 ημέρες
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 ώρα

  const ERROR_COUNT_KEY = 'scs_persistent_error_count';
  const WARNING_COUNT_KEY = 'scs_persistent_warning_count';
  const SESSION_ID_KEY = 'currentSessionId';

  console.log('[CentralLogger V17] Module loaded – IndexedDB storage');

  const CentralLogger = {
    _db: null,
    _persistentErrors: 0,
    _persistentWarnings: 0,
    _sessionId: null,
    _cleanupTimer: null,

    async init() {
      console.log('[CentralLogger V17] Initializing');
      await this._openDB();
      await this._initSessionId();
      await this._cleanupOldLogs();

      try {
        const data = await browser.storage.local.get([ERROR_COUNT_KEY, WARNING_COUNT_KEY]);
        this._persistentErrors = data[ERROR_COUNT_KEY] || 0;
        this._persistentWarnings = data[WARNING_COUNT_KEY] || 0;
        console.log('[CentralLogger V17] Loaded persistent counters:', { errors: this._persistentErrors, warnings: this._persistentWarnings });
      } catch (e) {
        console.error('[CentralLogger V17] Failed to load persistent counters:', e);
      }

      // Αυτόματο cleanup κάθε 1 ώρα
      this._cleanupTimer = setInterval(() => this._cleanupOldLogs(), CLEANUP_INTERVAL_MS);

      console.log('[CentralLogger V17] Session ID:', this._sessionId);
    },

    async _openDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            store.createIndex('time', 'time', { unique: false });
            console.log('[CentralLogger V17] Object store created with index');
          }
        };
        request.onsuccess = (event) => {
          this._db = event.target.result;
          console.log('[CentralLogger V17] Database opened');
          resolve();
        };
        request.onerror = (event) => {
          console.error('[CentralLogger V17] Database open error:', event.target.error);
          reject(event.target.error);
        };
      });
    },

    async _initSessionId() {
      try {
        const data = await browser.storage.session.get(SESSION_ID_KEY);
        if (data[SESSION_ID_KEY]) {
          this._sessionId = data[SESSION_ID_KEY];
          console.log('[CentralLogger V17] Loaded existing session ID:', this._sessionId);
        } else {
          this._sessionId = crypto.randomUUID();
          await browser.storage.session.set({ [SESSION_ID_KEY]: this._sessionId });
          console.log('[CentralLogger V17] Created new session ID:', this._sessionId);
        }
      } catch (e) {
        console.error('[CentralLogger V17] Failed to init session ID:', e);
        this._sessionId = crypto.randomUUID();
      }
    },

    async _cleanupOldLogs() {
      if (!this._db) return;
      const cutoff = new Date(Date.now() - LOG_TTL_MS).toISOString();

      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('time');
        const range = IDBKeyRange.upperBound(cutoff);
        const request = index.openCursor(range);
        let deleted = 0;
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            if (deleted > 0) console.log('[CentralLogger V17] Cleaned up', deleted, 'old logs');
            resolve();
          }
        };
        request.onerror = (event) => {
          console.error('[CentralLogger V17] Cleanup error:', event.target.error);
          reject(event.target.error);
        };
      });
    },

    log(source, service, message, type = 'info') {
      if (!this._db) {
        console.warn('[CentralLogger V17] Database not ready, logging to console only');
        console.log(`[CentralLogger V17] ${type.toUpperCase()}: [${source}] [${service}] ${message}`);
        return;
      }

      const entry = {
        source,
        service,
        message,
        time: new Date().toISOString(),
        type,
        sessionId: this._sessionId
      };

      // Ασύγχρονη αποθήκευση (fire and forget)
      const tx = this._db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.add(entry);

      if (type === 'warn') {
        console.warn(`[CentralLogger V17] WARNING: [${source}] [${service}] ${message}`);
        this._persistentWarnings++;
        this._savePersistentCounters();
      } else if (type === 'error') {
        console.error(`[CentralLogger V17] ERROR: [${source}] [${service}] ${message}`);
        this._persistentErrors++;
        this._savePersistentCounters();
      } else {
        console.log(`[CentralLogger V17] INFO: [${source}] [${service}] ${message}`);
      }
    },

    error(source, service, message) { this.log(source, service, message, 'error'); },
    warn(source, service, message) { this.log(source, service, message, 'warn'); },

    getStats() {
      return {
        errors: this._persistentErrors,
        warnings: this._persistentWarnings
      };
    },

    clearPersistentStats() {
      this._persistentErrors = 0;
      this._persistentWarnings = 0;
      this._savePersistentCounters();
    },

    async _savePersistentCounters() {
      try {
        await browser.storage.local.set({
          [ERROR_COUNT_KEY]: this._persistentErrors,
          [WARNING_COUNT_KEY]: this._persistentWarnings
        });
      } catch (e) {
        console.error('[CentralLogger V17] Failed to save persistent counters:', e);
      }
    },

    // Μέθοδος για ανάγνωση όλων των logs (από το popup για εξαγωγή)
    async getAllLogs() {
      if (!this._db) return [];
      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = (event) => {
          console.error('[CentralLogger V17] getAllLogs error:', event.target.error);
          reject(event.target.error);
        };
      });
    }
  };

  self.CentralLogger = CentralLogger;
})();