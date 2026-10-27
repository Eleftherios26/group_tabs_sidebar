// Coordinator 2 – Background Event Page (V26.1)
// V26.1: Αύξηση FAVICON_READY_DEDUP_MS 2000 → 30000.
//        Προσθήκη tabs.onAttached / tabs.onDetached για άμεση ενημέρωση native tab drag μεταξύ windows.
//        Το SIDEBAR_HEARTBEAT handler παραμένει ως έχει (sendResponse ACK).
console.log('[Coordinator2 V26.1] Module loaded');

const STORAGE_KEYS = {
  STATE_SNAPSHOT: 'v10_state_snapshot',
  EVENT_BUFFER: 'v10_event_buffer',
  EXECUTION_STORE: 'v10_execution_store'
};

const MAX_EVENT_BUFFER = 200;
const MAX_EXECUTION_STORE = 500;

let currentState = {
  windowGroups: [],
  activeWindowId: null,
  stateRevision: 0,
  stateVersion: 1,
};

const eventBuffer = [];
const executionStore = new Map();
const dirtyWindows = new Set();

const tabUrlMap = new Map(); // tabId -> { url, incognito }

const knownTabIds = new Set();
const POLL_ALARM_NAME = 'check-missing-tabs';
const POLL_INTERVAL_MINUTES = 1;
const CLEANUP_STALE_ALARM = 'cleanup-stale-sidebars';
const CLEANUP_STALE_INTERVAL = 10;
const UPDATE_SCS_ALARM = 'update-scs-stats';
const UPDATE_SCS_INTERVAL = 3;

let updateAvailable = false;
let focusedWindowId = null;

let executionStoreSaveTimer = null;
const EXECUTION_STORE_SAVE_DELAY = 1000;
let eventBufferSaveTimer = null;
const EVENT_BUFFER_SAVE_DELAY = 1000;

const faviconUrlMap = new Map();
const MAX_FAVICON_URL_CACHE = 200;
const faviconUrlMapOrder = [];

const closingWindows = new Set();

let sendStateDebounceTimer = null;
const SEND_STATE_DEBOUNCE_MS = 0;

let _batchClosing = false;
let _batchClosingTimer = null;

const BATCH_UPDATE_MS = 50;

const LAST_UPDATE_KEY = 'lastStateUpdateTimestamp';
let lastStateUpdateTimestamp = null;
let _rebuildPromise = null;

let _lastScsStats = null;

const _recentlyNotifiedHostnames = new Map();
// V26.1: Αύξηση από 2000ms σε 30000ms για αποφυγή διπλών FAVICON_READY.
const FAVICON_READY_DEDUP_MS = 30000;

// V26: Μηχανισμός διατήρησης του τελευταίου γνωστού έγκυρου favicon ανά hostname
const lastKnownFavicon = new Map(); // hostname -> favIconUrl

// V26: Ουρά σειριακής δημιουργίας tabs
let tabCreationQueue = Promise.resolve();

// V26.02: Σύνολο γνωστών παραθύρων για ανίχνευση νέων παραθύρων
const knownWindowIds = new Set();

function enqueueTabCreation(createFn) {
  const result = tabCreationQueue.then(() => createFn());
  tabCreationQueue = result.catch(() => {});
  return result;
}

DomainManager.setLastKnownFaviconMap(lastKnownFavicon);

function getStableAboutId(tab) {
  if (!tab || !tab.url) return null;
  const url = tab.url;
  if (url === 'about:home' || url === 'about:privatebrowsing' || url === 'about:blank' || url === 'about:newtab') {
    const host = (tab.incognito || url === 'about:privatebrowsing') ? 'about:privatebrowsing' : 'about:home';
    return `${host}::window-${tab.windowId}`;
  }
  return null;
}

function addFaviconUrlToCache(hostname, url) {
  if (faviconUrlMap.has(hostname)) {
    const idx = faviconUrlMapOrder.indexOf(hostname);
    if (idx > -1) faviconUrlMapOrder.splice(idx, 1);
  } else if (faviconUrlMap.size >= MAX_FAVICON_URL_CACHE) {
    const oldest = faviconUrlMapOrder.shift();
    if (oldest) faviconUrlMap.delete(oldest);
  }
  faviconUrlMap.set(hostname, url);
  faviconUrlMapOrder.push(hostname);
}

const faviconFetchPromises = new Map();

function generateRequestId() { return crypto.randomUUID(); }
function nowISO() { return new Date().toISOString(); }

let isInitialized = false;
const earlyEventQueue = [];

function queueEarlyEvent(handler) {
  if (isInitialized) { handler(); } else { earlyEventQueue.push(handler); }
}

function drainEarlyEvents() {
  while (earlyEventQueue.length > 0) {
    const handler = earlyEventQueue.shift();
    try { handler(); } catch (e) { console.error(e); }
  }
}

// ---- Σύνδεση με το AboutPageManager (V26) ----
AboutPageManager.setOnChangeCallback((windowId) => {
  if (!isInitialized) return;
  if (windowId) {
    dirtyWindows.add(windowId);
    console.log(`[Coordinator2 V26.1] Window ${windowId} marked dirty due to pending change`);
  }
  scheduleUpdate(0);
});

setInterval(() => {
  AboutPageManager.cleanupStaleTabs();
}, 30000);

function notifyFaviconReady(hostname) {
  if (_recentlyNotifiedHostnames.has(hostname)) {
    console.log(`[Coordinator2 V26.1] FAVICON_READY suppressed for ${hostname} (recently sent)`);
    return;
  }
  const msg = {
    type: 'FAVICON_READY',
    source: 'background',
    target: 'sidebar',
    hostname: hostname,
    timestamp: nowISO(),
    requestId: generateRequestId()
  };
  browser.runtime.sendMessage(msg).catch(() => {});
  console.log(`[Coordinator2 V26.1] FAVICON_READY sent for ${hostname}`);
  const timeoutId = setTimeout(() => {
    _recentlyNotifiedHostnames.delete(hostname);
  }, FAVICON_READY_DEDUP_MS);
  _recentlyNotifiedHostnames.set(hostname, timeoutId);
}

function cacheAndNotify(hostname, faviconUrl) {
  return FaviconCache.cacheFavicon(hostname, faviconUrl)
    .then(() => notifyFaviconReady(hostname))
    .catch(e => CentralLogger.error('coordinator', 'cacheFavicon', e.message));
}

// ---- Top-level browser event listeners ----
browser.tabs.onCreated.addListener((tab) => {
  queueEarlyEvent(async () => {
    if (closingWindows.has(tab.windowId)) return;
    knownTabIds.add(tab.id);
    tabUrlMap.set(tab.id, { url: tab.url, incognito: tab.incognito });

    const stableId = getStableAboutId(tab);
    if (stableId) {
      console.log(`[Coordinator2 V26.1] Common about:home ID for window ${tab.windowId}: ${stableId}`);
      DomainManager.clearRecentlyRemoved(stableId);
    }

    const url = tab.url || '';

    // V26.02: Ανίχνευση νέου παραθύρου με ασφάλεια μέσω knownWindowIds
    const isNewWindow = !knownWindowIds.has(tab.windowId);
    if (isNewWindow) {
      knownWindowIds.add(tab.windowId);
      console.log(`[Coordinator2 V26.1] Detected new window ${tab.windowId} from tab ${tab.id}`);
    }

    const isNewWindowAboutPage = isNewWindow &&
      (url === 'about:home' || url === 'about:privatebrowsing' || url === 'about:blank' || url === 'about:newtab');

    if (isNewWindowAboutPage) {
      console.log(`[Coordinator2 V26.1] Tab ${tab.id} in new window – showing about page immediately`);
    } else if (url === 'about:home' || url === 'about:privatebrowsing' || url === 'about:blank' || url === 'about:newtab') {
      AboutPageManager.markTabPlaceholder(tab.id, tab.windowId);
    }

    if (tab.favIconUrl && (tab.favIconUrl.startsWith('data:') || tab.favIconUrl.startsWith('moz-extension:'))) {
      const hostname = DomainManager.getHostnameForTab(tab);
      if (hostname) {
        addFaviconUrlToCache(hostname, tab.favIconUrl);
        cacheAndNotify(hostname, tab.favIconUrl);
        lastKnownFavicon.set(hostname, tab.favIconUrl);
      }
    } else if (tab.favIconUrl && !lastKnownFavicon.has(DomainManager.getHostnameForTab(tab))) {
      const hostname = DomainManager.getHostnameForTab(tab);
      if (hostname) lastKnownFavicon.set(hostname, tab.favIconUrl);
    }

    if (tab.openerTabId) {
      DomainManager.handleTabCreatedFromOpener(tab.id, tab.openerTabId, tab.windowId)
        .catch(e => CentralLogger.error('coordinator', 'handleTabCreatedFromOpener', e.message));
    }
    dirtyWindows.add(tab.windowId);
    pushEvent({ event: 'tabCreated', tabId: tab.id, windowId: tab.windowId, timestamp: nowISO() });
    scheduleUpdate(BATCH_UPDATE_MS);
  });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  queueEarlyEvent(() => {
    if (closingWindows.has(tab.windowId)) return;

    if (AboutPageManager.isPending(tabId) && changeInfo.url) {
      const newUrl = changeInfo.url;
      const isAboutPage = (newUrl === 'about:home' || newUrl === 'about:privatebrowsing' || newUrl === 'about:blank' || newUrl === 'about:newtab');
      if (!isAboutPage) {
        console.log(`[Coordinator2 V26.1] Tab ${tabId} got non-about:home URL: ${newUrl}, releasing from pending`);
        AboutPageManager.releaseTab(tabId);
      }
    }

    if (AboutPageManager.isPending(tabId)) return;

    if (changeInfo.favIconUrl) {
      const currentTab = tab;
      if (currentTab && currentTab.url && currentTab.favIconUrl && (currentTab.favIconUrl.startsWith('data:') || currentTab.favIconUrl.startsWith('moz-extension:'))) {
        const hostname = DomainManager.getHostnameForTab(currentTab);
        if (hostname) {
          addFaviconUrlToCache(hostname, currentTab.favIconUrl);
          cacheAndNotify(hostname, currentTab.favIconUrl);
          lastKnownFavicon.set(hostname, currentTab.favIconUrl);
        }
      }
    }

    if (changeInfo.url) {
      const oldUrl = (tabUrlMap.get(tabId)?.url) || tab.url;
      tabUrlMap.set(tabId, { url: changeInfo.url, incognito: tab.incognito });
      DomainManager.handleTabNavigation(tabId, oldUrl, changeInfo.url)
        .catch(e => CentralLogger.error('coordinator', 'handleTabNavigation', e.message));
      dirtyWindows.add(tab.windowId);
      pushEvent({ event: 'tabUpdated', tabId, windowId: tab.windowId, timestamp: nowISO() });
      scheduleUpdate(BATCH_UPDATE_MS);
    }
  });
});

// V26.1: Άμεση ενημέρωση όταν σύρεται tab native μεταξύ windows.
browser.tabs.onAttached.addListener((tabId, attachInfo) => {
  queueEarlyEvent(async () => {
    if (closingWindows.has(attachInfo.newWindowId)) return;
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab) {
        tabUrlMap.set(tabId, { url: tab.url, incognito: tab.incognito });
      }
    } catch (e) { /* tab μπορεί να έχει κλείσει */ }
    console.log(`[Coordinator2 V26.1] Tab ${tabId} attached to window ${attachInfo.newWindowId} (from ${attachInfo.oldWindowId})`);
    dirtyWindows.add(attachInfo.oldWindowId);
    dirtyWindows.add(attachInfo.newWindowId);
    pushEvent({ event: 'tabAttached', tabId, windowId: attachInfo.newWindowId, timestamp: nowISO() });
    scheduleUpdate(BATCH_UPDATE_MS);
  });
});

// V26.1: Σήμανση παλιού window ως dirty όταν αποσπάται tab.
browser.tabs.onDetached.addListener((tabId, detachInfo) => {
  queueEarlyEvent(() => {
    if (closingWindows.has(detachInfo.oldWindowId)) return;
    console.log(`[Coordinator2 V26.1] Tab ${tabId} detached from window ${detachInfo.oldWindowId}`);
    dirtyWindows.add(detachInfo.oldWindowId);
    pushEvent({ event: 'tabDetached', tabId, windowId: detachInfo.oldWindowId, timestamp: nowISO() });
    scheduleUpdate(BATCH_UPDATE_MS);
  });
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  queueEarlyEvent(async () => {
    console.log(`[Coordinator2 V26.1 onRemoved] Tab ${tabId} removed, windowId=${removeInfo.windowId}`);

    let remainingTabs = [];
    try {
      if (removeInfo.windowId && !closingWindows.has(removeInfo.windowId)) {
        const allTabs = await browser.tabs.query({ windowId: removeInfo.windowId });
        remainingTabs = allTabs.filter(t => t.id !== tabId);
      }
    } catch (e) { /* αγνοούμε αν το παράθυρο έχει ήδη κλείσει */ }

    const tabData = tabUrlMap.get(tabId);
    if (tabData) {
      const url = tabData.url;
      const incognito = tabData.incognito;
      const windowId = removeInfo.windowId;
      const hostname = DomainManager.getHostnameForTab({ url, incognito, windowId });
      if (hostname) {
        const hasOtherTabsWithSameHostname = remainingTabs.some(t => {
          const h = DomainManager.getHostnameForTab(t);
          return h === hostname;
        });
        if (!hasOtherTabsWithSameHostname) {
          DomainManager.markHostnameAsRecentlyRemoved(hostname);
          console.log(`[Coordinator2 V26.1] Marked ${hostname} as recently removed (no other tabs with this hostname)`);
        } else {
          console.log(`[Coordinator2 V26.1] Not marking ${hostname} as recently removed – other tabs exist`);
        }
      }
    }

    knownTabIds.delete(tabId);
    tabUrlMap.delete(tabId);
    AboutPageManager.releaseTab(tabId);
    DomainManager.handleTabRemoved(tabId)
      .catch(e => CentralLogger.error('coordinator', 'handleTabRemoved', e.message));

    if (removeInfo.windowId && !closingWindows.has(removeInfo.windowId)) {
      try {
        await DomainManager.updateWindowStateWithRealTabs(removeInfo.windowId, currentState, remainingTabs);
        currentState.stateRevision++;
        await persistAllState();

        if (!_batchClosing) {
          const msg = {
            type: 'STATE_UPDATE', source: 'background', target: 'sidebar',
            payload: currentState, revision: currentState.stateRevision,
            timestamp: nowISO(), requestId: generateRequestId(),
          };
          browser.runtime.sendMessage(msg).catch(() => {});
          browser.runtime.sendMessage({ ...msg, target: 'popup' }).catch(() => {});
        }
        dirtyWindows.delete(removeInfo.windowId);
        scheduleUpdate(0);
      } catch (e) {
        dirtyWindows.add(removeInfo.windowId);
        scheduleUpdate(0);
      }
    }
    pushEvent({ event: 'tabRemoved', tabId, windowId: removeInfo.windowId, timestamp: nowISO() });
  });
});

browser.tabs.onActivated.addListener((activeInfo) => {
  queueEarlyEvent(() => {
    if (closingWindows.has(activeInfo.windowId)) return;
    dirtyWindows.add(activeInfo.windowId);
    pushEvent({ event: 'tabActivated', tabId: activeInfo.tabId, windowId: activeInfo.windowId, timestamp: nowISO() });
    scheduleUpdate(BATCH_UPDATE_MS);
  });
});

browser.windows.onCreated.addListener((win) => {
  queueEarlyEvent(() => {
    knownWindowIds.add(win.id);
    dirtyWindows.add(win.id);
    pushEvent({ event: 'windowCreated', windowId: win.id, timestamp: nowISO() });
    scheduleUpdate(BATCH_UPDATE_MS);
  });
});

browser.windows.onRemoved.addListener((windowId) => {
  queueEarlyEvent(() => {
    knownWindowIds.delete(windowId);
    handleWindowRemoved(windowId);
    pushEvent({ event: 'windowRemoved', windowId, timestamp: nowISO() });
  });
});

browser.windows.onFocusChanged.addListener((windowId) => {
  queueEarlyEvent(() => {
    if (windowId === browser.windows.WINDOW_ID_NONE) {
      focusedWindowId = null;
    } else {
      focusedWindowId = windowId;
      browser.windows.get(windowId).then(win => {
        if (win) {
          currentState.activeWindowId = windowId;
          currentState.stateRevision++;
          persistAllState().catch(() => {});
          sendStateToAllViews();
        }
      }).catch(() => {});
    }
  });
});

// ---- Message listener ----
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ error: 'Invalid message' });
    return false;
  }

  if (message.type.startsWith('REQUEST_')) {
    handleActionRequest(message, sender, sendResponse);
    return true;
  }

  switch (message.type) {
    case 'PING':
      sendResponse({ pong: true, revision: currentState.stateRevision });
      break;
    case 'GET_STATE':
      (async () => {
        if (_rebuildPromise) {
          console.log('[Coordinator2 V26.1] Waiting for rebuild before sending state (GET_STATE)');
          await _rebuildPromise;
        }
        sendResponse({
          type: 'STATE_SNAPSHOT',
          source: 'background',
          payload: currentState,
          revision: currentState.stateRevision,
          timestamp: nowISO(),
          requestId: message.requestId || generateRequestId()
        });
      })();
      return true;
    case 'FETCH_FAVICON': {
      const hostname = message.hostname;
      if (!faviconFetchPromises.has(hostname)) {
        faviconFetchPromises.set(hostname, (async () => {
          try {
            const cached = await FaviconCache.getCachedFavicon(hostname);
            if (cached) return { dataUrl: cached.dataUrl, color: cached.color };
            return { dataUrl: null, color: null };
          } catch (e) {
            CentralLogger.error('coordinator', 'FETCH_FAVICON', e.message);
            return { dataUrl: null, color: null };
          } finally {
            faviconFetchPromises.delete(hostname);
          }
        })());
      }
      faviconFetchPromises.get(hostname).then(result => sendResponse(result));
      return true;
    }
    case 'CACHE_FAVICON': {
      const hostname = message.hostname;
      const faviconUrl = message.faviconUrl;
      if (!faviconUrl || (!faviconUrl.startsWith('data:') && !faviconUrl.startsWith('moz-extension:'))) {
        sendResponse({ success: false, error: 'Only local URLs allowed' });
        return false;
      }
      cacheAndNotify(hostname, faviconUrl)
        .then(() => sendResponse({ success: true }))
        .catch(err => {
          CentralLogger.error('coordinator', 'CACHE_FAVICON', err.message);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }
    case 'LOG_EVENT':
      CentralLogger.log(message.source, message.service, message.message, message.logType || 'info');
      updateScsStats();
      sendResponse({});
      break;
    case 'SIDEBAR_READY':
      updateSidebarActiveStorage();
      sendResponse({});
      setTimeout(async () => {
        if (_rebuildPromise) {
          console.log('[Coordinator2 V26.1] Waiting for rebuild before sending state (SIDEBAR_READY)');
          await _rebuildPromise;
        }
        const stateMessage = {
          type: 'STATE_UPDATE',
          source: 'background',
          target: 'sidebar',
          payload: currentState,
          revision: currentState.stateRevision,
          timestamp: nowISO(),
          requestId: generateRequestId(),
        };
        browser.runtime.sendMessage(stateMessage).catch(() => {});
        browser.runtime.sendMessage({ ...stateMessage, target: 'popup' }).catch(() => {});
      }, 100);
      break;
    case 'SIDEBAR_HEARTBEAT':
      updateSidebarActiveStorage();
      sendResponse({ type: 'SIDEBAR_HEARTBEAT_ACK', timestamp: nowISO() });
      break;
    case 'SIDEBAR_STATUS':
      const requestedWindowId = message.windowId;
      const active = ToolbarBadgeController.isSidebarActiveInWindow(requestedWindowId);
      sendResponse({ success: true, reason: active ? 'active' : 'sidebar-closed', active });
      break;
    case 'CLEAR_SCS_COUNTERS':
      CentralLogger.clearPersistentStats();
      _lastScsStats = null;
      updateScsStats();
      sendResponse({ success: true });
      break;
    case 'REQUEST_CLEAR_BADGE':
      if (browser.action) browser.action.setBadgeText({ text: '' }).catch(() => {});
      sendResponse({ success: true });
      break;
    case 'SET_UPDATE_AVAILABLE':
      updateAvailable = message.payload?.available || false;
      browser.storage.local.set({ sidebarUpdateAvailable: updateAvailable }).catch(() => {});
      if (typeof ToolbarBadgeController !== 'undefined') {
        ToolbarBadgeController.notifyUpdateAvailable(updateAvailable);
      }
      sendResponse({ success: true });
      break;
    case 'GET_SCS_STATS':
      {
        const stats = CentralLogger.getStats();
        sendResponse({ success: true, errors: stats.errors, warnings: stats.warnings });
      }
      break;
    case 'GET_SESSION_ID':
      sendResponse({ success: true, sessionId: CentralLogger._sessionId });
      break;
    case 'GET_LOGS':
      CentralLogger.getAllLogs()
        .then((logs) => {
          sendResponse({ success: true, logs });
        })
        .catch((error) => {
          CentralLogger.error('coordinator', 'GET_LOGS', error.message);
          sendResponse({ success: false, error: error.message });
        });
      return true;
    case 'GET_UPDATE_STATUS':
      sendResponse({ success: true, updateAvailable });
      break;
    case 'FETCH_TAB_DETAILS': {
      (async () => {
        try {
          const { hostname, windowId } = message;
          if (!hostname || windowId === undefined) {
            sendResponse({ success: false, error: 'Missing hostname or windowId' });
            return;
          }

          const allTabs = await browser.tabs.query({ windowId });
          const tabs = allTabs.filter(tab => {
            const tabHost = DomainManager.getHostnameForTab(tab);
            if (hostname.startsWith('about:home::') || hostname.startsWith('about:privatebrowsing::')) {
              return tabHost === hostname;
            }
            const groupId = Object.keys(DomainManager._getMergedGroups(windowId) || {}).find(gid => gid === hostname);
            if (groupId) {
              const group = DomainManager._getMergedGroups(windowId)[groupId];
              return group && group.domains.includes(tabHost);
            }
            return tabHost === hostname;
          });

          const fullTabs = tabs.map(tab => ({
            id: tab.id,
            title: tab.title || '',
            url: tab.url || '',
            active: tab.active,
            visible: !tab.hidden,
            audible: tab.audible,
            mutedInfo: tab.mutedInfo,
            favIconUrl: tab.favIconUrl
          }));

          sendResponse({ success: true, tabs: fullTabs });
        } catch (e) {
          CentralLogger.error('coordinator', 'FETCH_TAB_DETAILS', e.message);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }
    default:
      sendResponse({ error: 'Unknown message type' });
  }
  return false;
});

// ---- Helpers ----
async function saveExecutionStoreDebounced() {
  if (executionStoreSaveTimer) clearTimeout(executionStoreSaveTimer);
  executionStoreSaveTimer = setTimeout(async () => {
    executionStoreSaveTimer = null;
    await browser.storage.local.set({
      [STORAGE_KEYS.EXECUTION_STORE]: Array.from(executionStore.entries())
    }).catch(e => CentralLogger.error('coordinator', 'saveExecutionStore', e.message));
  }, EXECUTION_STORE_SAVE_DELAY);
}

async function persistEventBufferDebounced() {
  if (eventBufferSaveTimer) clearTimeout(eventBufferSaveTimer);
  eventBufferSaveTimer = setTimeout(async () => {
    eventBufferSaveTimer = null;
    await browser.storage.local.set({ [STORAGE_KEYS.EVENT_BUFFER]: eventBuffer.slice() })
      .catch(e => CentralLogger.error('coordinator', 'persistEventBuffer', e.message));
  }, EVENT_BUFFER_SAVE_DELAY);
}

function pushEvent(event) {
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_EVENT_BUFFER) eventBuffer.shift();
  persistEventBufferDebounced();
}

async function persistAllState() {
  try {
    const snapshot = JSON.parse(JSON.stringify(currentState));
    const size = JSON.stringify(snapshot).length;
    if (size > 500000) {
      CentralLogger.warn('coordinator', 'persistAllState', `Very large state size: ${size} bytes`);
    }
    await browser.storage.local.set({
      [STORAGE_KEYS.STATE_SNAPSHOT]: snapshot,
      [LAST_UPDATE_KEY]: Date.now()
    });
    lastStateUpdateTimestamp = Date.now();
  } catch (e) { CentralLogger.error('coordinator', 'persistAllState', e.message); }
}

async function loadStateSnapshot() {
  const data = await browser.storage.local.get(STORAGE_KEYS.STATE_SNAPSHOT);
  if (data[STORAGE_KEYS.STATE_SNAPSHOT]) {
    const saved = data[STORAGE_KEYS.STATE_SNAPSHOT];
    if (saved.stateVersion === currentState.stateVersion) {
      currentState = saved;
    }
  }
}

async function loadEventBuffer() {
  const data = await browser.storage.local.get(STORAGE_KEYS.EVENT_BUFFER);
  if (data[STORAGE_KEYS.EVENT_BUFFER] && Array.isArray(data[STORAGE_KEYS.EVENT_BUFFER])) {
    eventBuffer.length = 0;
    eventBuffer.push(...data[STORAGE_KEYS.EVENT_BUFFER]);
  }
}

async function sendStateToAllViews() {
  await FaviconCache.waitForAllPending();
  doSendStateToAllViews();
}

function doSendStateToAllViews() {
  if (sendStateDebounceTimer) clearTimeout(sendStateDebounceTimer);

  sendStateDebounceTimer = setTimeout(async () => {
    sendStateDebounceTimer = null;

    const message = {
      type: 'STATE_UPDATE', source: 'background', target: 'sidebar',
      payload: currentState, revision: currentState.stateRevision,
      timestamp: nowISO(), requestId: generateRequestId(),
    };
    try { await browser.runtime.sendMessage(message); } catch (e) {}
    browser.runtime.sendMessage({ ...message, target: 'popup' }).catch(() => {});
  }, SEND_STATE_DEBOUNCE_MS);

  const stack = new Error().stack || '';
  if (stack.includes('handleWindowRemoved')) {
    clearTimeout(sendStateDebounceTimer);
    sendStateDebounceTimer = null;

    const message = {
      type: 'STATE_UPDATE', source: 'background', target: 'sidebar',
      payload: currentState, revision: currentState.stateRevision,
      timestamp: nowISO(), requestId: generateRequestId(),
    };
    browser.runtime.sendMessage(message).catch(() => {});
    browser.runtime.sendMessage({ ...message, target: 'popup' }).catch(() => {});
  }
}

async function handleWindowRemoved(windowId) {
  if (!currentState.windowGroups.some(wg => wg.windowId === windowId)) {
    closingWindows.delete(windowId);
    dirtyWindows.delete(windowId);
    return;
  }

  closingWindows.add(windowId);

  try {
    await DomainManager.updateWindowState(windowId, currentState);
    currentState.stateRevision++;
    await persistAllState();
    await sendStateToAllViews();
  } catch (e) {
    CentralLogger.error('coordinator', 'handleWindowRemoved', e.message);
  }

  dirtyWindows.delete(windowId);
  closingWindows.delete(windowId);
}

async function buildSnapshot() {
  const raw = await DomainManager.getStateSnapshot();
  if (raw && raw.windowGroups) {
    currentState = { ...raw, stateRevision: currentState.stateRevision + 1, stateVersion: currentState.stateVersion };
    await persistAllState();
    await sendStateToAllViews();
  }
  return currentState;
}

async function incrementalReconcile() {
  if (dirtyWindows.size > 0) {
    const dirtyIds = [...dirtyWindows];
    dirtyWindows.clear();

    for (const winId of dirtyIds) {
      if (closingWindows.has(winId)) continue;
      try {
        await DomainManager.updateWindowState(winId, currentState);
        restoreLastKnownFavicons(winId);
      } catch (e) {
        CentralLogger.error('coordinator', `reconcile window ${winId}`, e.message);
      }
    }

    currentState.stateRevision++;

    const totalRealTabs = currentState.windowGroups.reduce((sum, wg) => {
      for (const domain of Object.values(wg.domainMap)) {
        sum += (domain.tabs?.length || 0);
      }
      return sum;
    }, 0);

    if (totalRealTabs === 0 && AboutPageManager.getPendingCount() > 0) {
      return;
    }

    await persistAllState();
    await sendStateToAllViews();
  }
}

function restoreLastKnownFavicons(windowId) {
  const wg = currentState.windowGroups.find(w => w.windowId === windowId);
  if (!wg || !wg.domainMap) return;
  for (const [hostname, domain] of Object.entries(wg.domainMap)) {
    if (domain.isMerged && domain.hostGroups) {
      for (const hg of domain.hostGroups) {
        if (!hg.favIconUrl && lastKnownFavicon.has(hg.hostname)) {
          hg.favIconUrl = lastKnownFavicon.get(hg.hostname);
          console.log(`[Coordinator2 V26.1] Restored favicon for ${hg.hostname} from lastKnownFavicon`);
        }
      }
    } else {
      if (!domain.favIconUrl && lastKnownFavicon.has(hostname)) {
        domain.favIconUrl = lastKnownFavicon.get(hostname);
        console.log(`[Coordinator2 V26.1] Restored favicon for ${hostname} from lastKnownFavicon`);
      }
    }
  }
}

async function replayEvents() {
  const stored = await browser.storage.local.get(STORAGE_KEYS.EVENT_BUFFER);
  const bufferToReplay = stored[STORAGE_KEYS.EVENT_BUFFER] || [];
  if (bufferToReplay.length === 0) return;
  bufferToReplay.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const removedTabs = new Set();
  const removedWindows = new Set();
  for (const ev of bufferToReplay) {
    switch (ev.event) {
      case 'tabCreated': if (!removedTabs.has(ev.tabId)) dirtyWindows.add(ev.windowId); break;
      case 'tabUpdated': dirtyWindows.add(ev.windowId); break;
      case 'tabRemoved': removedTabs.add(ev.tabId); if (ev.windowId) dirtyWindows.add(ev.windowId); break;
      case 'tabActivated': if (ev.windowId) dirtyWindows.add(ev.windowId); break;
      case 'tabAttached': dirtyWindows.add(ev.windowId); break;
      case 'tabDetached': dirtyWindows.add(ev.windowId); break;
      case 'windowCreated': if (!removedWindows.has(ev.windowId)) dirtyWindows.add(ev.windowId); break;
      case 'windowRemoved': removedWindows.add(ev.windowId); dirtyWindows.add(ev.windowId); break;
    }
  }
  eventBuffer.length = 0;
  await persistEventBufferDebounced();
}

async function ensureDomainOrders() {
  const data = await browser.storage.local.get(['session_domainOrder', 'session_mergedGroups']);
  let domainOrder = data.session_domainOrder || {};
  let mergedGroups = data.session_mergedGroups || {};
  let needsSave = false;
  const allWindows = await browser.windows.getAll();
  for (const win of allWindows) {
    if (win.type === 'devtools') continue;
    const windowId = win.id;
    if (!domainOrder[windowId] || domainOrder[windowId].length === 0) {
      const tabs = await browser.tabs.query({ windowId });
      const hostnames = [];
      for (const tab of tabs) {
        const hostname = DomainManager.getHostnameForTab(tab);
        if (hostname && !hostnames.includes(hostname)) hostnames.push(hostname);
      }
      if (mergedGroups[windowId]) {
        for (const groupId of Object.keys(mergedGroups[windowId])) {
          if (!hostnames.includes(groupId)) hostnames.push(groupId);
        }
      }
      domainOrder[windowId] = hostnames;
      needsSave = true;
    }
  }
  if (needsSave) {
    await browser.storage.local.set({ session_domainOrder: domainOrder });
  }
}

function cleanupStaleSidebars() {
  // Διαχειρίζεται από το ToolbarBadgeController
}

async function updateSidebarActiveStorage() {
  const active = ToolbarBadgeController.isSidebarActiveInWindow(null);
  await browser.storage.local.set({ sidebarActive: active }).catch(() => {});
}

function updateScsStats() {
  const stats = CentralLogger.getStats();
  const newStats = { errors: stats.errors, warnings: stats.warnings };
  if (_lastScsStats && _lastScsStats.errors === newStats.errors && _lastScsStats.warnings === newStats.warnings) {
    return;
  }
  _lastScsStats = newStats;
  browser.storage.local.set({ scsStats: newStats }).catch(() => {});
}

async function checkMissingTabs() {
  try {
    const allTabs = await browser.tabs.query({});
    const currentIds = new Set(allTabs.map(t => t.id));
    const missingIds = [...knownTabIds].filter(id => !currentIds.has(id));

    if (missingIds.length > 0) {
      for (const tabId of missingIds) {
        knownTabIds.delete(tabId);
        tabUrlMap.delete(tabId);
        AboutPageManager.releaseTab(tabId);
        DomainManager.handleTabRemoved(tabId).catch(e => CentralLogger.error('coordinator', 'handleTabRemoved from alarm', e.message));
      }

      const wins = await browser.windows.getAll({ populate: true });
      for (const win of wins) {
        if (win.type !== 'devtools') {
          try { await DomainManager.updateWindowState(win.id, currentState); } catch (e) {}
        }
      }
      currentState.stateRevision++;
      await persistAllState();
    }

    knownTabIds.clear();
    for (const id of currentIds) knownTabIds.add(id);
  } catch (e) {
    console.error('[Coordinator2 V26.1] checkMissingTabs error:', e);
  }
}

if (browser.runtime.onUpdateAvailable) {
  browser.runtime.onUpdateAvailable.addListener((details) => {
    updateAvailable = true;
    browser.storage.local.set({ sidebarUpdateAvailable: true }).catch(() => {});
    if (typeof ToolbarBadgeController !== 'undefined') {
      ToolbarBadgeController.notifyUpdateAvailable(true);
    }
  });
}

const pendingGroupAssignments = new Map();

async function handleActionRequest(message, sender, sendResponse) {
  const reqId = message.requestId;
  if (!reqId) {
    sendResponse({ success: false, error: 'Missing requestId' });
    return;
  }

  const ackMsg = {
    type: 'ACTION_ACK',
    requestId: reqId,
    timestamp: nowISO()
  };
  if (sender.tab && sender.tab.id) {
    browser.tabs.sendMessage(sender.tab.id, ackMsg).catch(() => {});
  } else {
    browser.runtime.sendMessage(ackMsg).catch(() => {});
  }

  if (executionStore.has(reqId)) {
    const stored = executionStore.get(reqId);
    sendResponse({
      type: 'ACTION_ALREADY_EXECUTED',
      requestId: reqId,
      stateRevision: stored.stateRevision
    });
    return;
  }

  try {
    const result = await executeAction(message);
    if (result.success) {
      executionStore.set(reqId, {
        stateRevision: currentState.stateRevision,
        timestamp: nowISO()
      });
      if (executionStore.size > MAX_EXECUTION_STORE) {
        const keys = Array.from(executionStore.keys());
        keys.slice(0, executionStore.size - MAX_EXECUTION_STORE).forEach(k => executionStore.delete(k));
      }
      saveExecutionStoreDebounced();
    }
    sendResponse({
      ...result,
      revision: currentState.stateRevision,
      type: result.success ? 'ACTION_EXECUTED' : 'ACTION_FAILED'
    });
  } catch (e) {
    if (e.message && e.message.includes('Invalid tab ID')) {
      console.warn('[Coordinator2 V26.1] Action failed: Invalid tab ID');
      sendResponse({
        success: false,
        error: 'Invalid tab ID',
        revision: currentState.stateRevision
      });
      return;
    }
    CentralLogger.error('coordinator', `action ${message.type}`, e.message);
    sendResponse({
      success: false,
      error: e.message,
      revision: currentState.stateRevision
    });
  }
}

function waitForTabAndAssign(tabId, assignment) {
  const listener = (updatedTabId, changeInfo, tab) => {
    if (updatedTabId !== tabId) return;
    if (AboutPageManager.isPending(tabId)) return;

    browser.tabs.onUpdated.removeListener(listener);
    pendingGroupAssignments.delete(tabId);

    if (assignment.groupId) {
      DomainManager._setTabGroup(tabId, assignment.groupId);
    } else if (assignment.hostname) {
      const groups = DomainManager._getMergedGroups(assignment.windowId);
      if (groups) {
        for (const [groupId, group] of Object.entries(groups)) {
          if (group.domains.includes(assignment.hostname)) {
            DomainManager._setTabGroup(tabId, groupId);
            break;
          }
        }
      }
    }
    if (!closingWindows.has(assignment.windowId)) {
      dirtyWindows.add(assignment.windowId);
      scheduleUpdate(BATCH_UPDATE_MS);
    }
  };

  browser.tabs.onUpdated.addListener(listener);

  setTimeout(() => {
    if (pendingGroupAssignments.has(tabId)) {
      browser.tabs.onUpdated.removeListener(listener);
      pendingGroupAssignments.delete(tabId);
    }
  }, 15000);
}

async function executeAction(message) {
  switch (message.type) {
    case 'REQUEST_ACTIVATE_TAB':
      try {
        const tabExists = await browser.tabs.get(message.payload.tabId).catch(() => null);
        if (!tabExists) {
          console.warn('[Coordinator2 V26.1] Tab not found, skipping activation');
          return { success: false, error: 'Invalid tab ID' };
        }
        await browser.tabs.update(message.payload.tabId, { active: true });
        const tab = await browser.tabs.get(message.payload.tabId);
        await browser.windows.update(tab.windowId, { focused: true });
        dirtyWindows.add(tab.windowId);
      } catch (e) {
        CentralLogger.error('coordinator', `action ${message.type}`, e.message);
        return { success: false, error: e.message };
      }
      break;
    case 'REQUEST_CLOSE_TAB':
      await safeRemoveTab(message.payload.tabId);
      break;
    case 'REQUEST_MERGE_DOMAINS':
      await DomainManager.mergeDomains(message.payload.sourceHostname, message.payload.targetHostname, message.payload.windowId);
      if (message.payload.windowId) dirtyWindows.add(message.payload.windowId);
      break;
    case 'REQUEST_UNMERGE_DOMAIN':
      await DomainManager.unmergeDomain(message.payload.hostname, message.payload.windowId);
      if (message.payload.windowId) dirtyWindows.add(message.payload.windowId);
      break;
    case 'REQUEST_REORDER_MERGED_GROUP':
      await DomainManager.reorderMergedGroup(message.payload.groupId, message.payload.sourceHostname, message.payload.targetHostname, message.payload.insertBefore, message.payload.windowId);
      if (message.payload.windowId) dirtyWindows.add(message.payload.windowId);
      break;
    case 'REQUEST_CLOSE_DOMAIN_TABS':
      if (message.payload.tabIds && message.payload.tabIds.length > 0) {
        for (const id of message.payload.tabIds) await safeRemoveTab(id);
      } else {
        await closeDomainTabs(message.payload.hostname);
      }
      break;
    case 'REQUEST_TOGGLE_TAB_VISIBILITY':
      await toggleTabVisibility(message.payload.tabId);
      break;
    case 'REQUEST_OPEN_NEW_TAB':
      await enqueueTabCreation(async () => {
        const newTab = await browser.tabs.create({});
        AboutPageManager.markTabPlaceholder(newTab.id, newTab.windowId);
        await new Promise(resolve => setTimeout(resolve, 0));
        dirtyWindows.add(newTab.windowId);
      });
      break;
    case 'REQUEST_OPEN_NEW_TAB_FROM_DOMAIN': {
      await enqueueTabCreation(async () => {
        const hostname = message.payload.hostname;
        const groupId = message.payload.groupId;
        let url = hostname;

        const ALLOWED_PROTOCOLS = ['http:', 'https:', 'about:', 'moz-extension:'];
        let isAllowed = false;

        if (!hostname) {
          url = 'about:blank';
          isAllowed = true;
        } else if (hostname.startsWith('about:')) {
          url = hostname;
          isAllowed = true;
        } else if (hostname.match(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//)) {
          try {
            const parsed = new URL(hostname);
            if (ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
              isAllowed = true;
              url = hostname;
            }
          } catch {
            isAllowed = false;
          }
        } else {
          url = 'https://' + hostname;
          isAllowed = true;
        }

        if (!isAllowed) {
          url = 'about:blank';
        }

        let newTab;
        if (url === 'about:home' || url === 'about:newtab' || url === 'about:blank' || url === 'about:privatebrowsing') {
          newTab = await browser.tabs.create({});
          AboutPageManager.markTabPlaceholder(newTab.id, newTab.windowId);
        } else {
          newTab = await browser.tabs.create({ url });
          AboutPageManager.markTabWithDestination(newTab.id, newTab.windowId);
        }

        await new Promise(resolve => setTimeout(resolve, 0));
        dirtyWindows.add(newTab.windowId);

        if (groupId || hostname) {
          pendingGroupAssignments.set(newTab.id, {
            groupId: groupId || null,
            hostname: hostname,
            windowId: newTab.windowId
          });
          waitForTabAndAssign(newTab.id, pendingGroupAssignments.get(newTab.id));
        }
      });
      break;
    }
    case 'REQUEST_CLOSE_ALL_TABS_IN_GROUP':
      _batchClosing = true;
      if (_batchClosingTimer) clearTimeout(_batchClosingTimer);
      await DomainManager.closeAllTabsInGroup(message.payload.groupId, message.payload.windowId);
      _batchClosingTimer = setTimeout(() => {
        _batchClosing = false;
        _batchClosingTimer = null;
        if (message.payload.windowId) dirtyWindows.add(message.payload.windowId);
        scheduleUpdate(0);
      }, 150);
      return { success: true };
    case 'REQUEST_CLOSE_ALL_TABS_IN_WINDOW':
      {
        const winId = message.payload.windowId;
        closingWindows.add(winId);

        const tabs = await browser.tabs.query({ windowId: winId });
        for (const t of tabs) {
          await safeRemoveTab(t.id);
        }

        currentState.windowGroups = currentState.windowGroups.filter(wg => wg.windowId !== winId);
        currentState.stateRevision++;
        await persistAllState();
        await sendStateToAllViews();

        closingWindows.delete(winId);
        dirtyWindows.delete(winId);
      }
      break;
    case 'REQUEST_UPDATE_DOMAIN_ORDER':
      DomainManager.setDomainOrder(message.payload.windowId, message.payload.order);
      dirtyWindows.add(message.payload.windowId);
      break;
    case 'REQUEST_FOCUS_WINDOW':
      try {
        const win = await browser.windows.get(message.payload.windowId);
        if (win) {
          await browser.windows.update(message.payload.windowId, { focused: true });
          currentState.activeWindowId = message.payload.windowId;
          dirtyWindows.add(message.payload.windowId);
        }
      } catch (e) {
        console.warn(`[Coordinator2 V26.1] REQUEST_FOCUS_WINDOW skipped – window ${message.payload.windowId} no longer exists`);
      }
      break;
    case 'REQUEST_MOVE_TAB':
      try {
        await moveDomainTabs(message.payload.hostname, message.payload.targetWindowId, message.payload.originalWindowId);
      } catch (e) {
        CentralLogger.error('coordinator', 'moveDomainTabs', e.message);
      }
      break;
    case 'REQUEST_MOVE_GROUP': {
      const { groupId, targetWindowId, originalWindowId } = message.payload;
      await DomainManager.moveGroup(groupId, targetWindowId, originalWindowId);
      dirtyWindows.add(targetWindowId);
      dirtyWindows.add(originalWindowId);
      break;
    }
    default:
      return { success: false, error: `Unknown action: ${message.type}` };
  }

  scheduleUpdate(0);
  return { success: true };
}

async function safeRemoveTab(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && tab.url.startsWith('moz-extension://')) return false;
    await browser.tabs.remove(tabId);
    return true;
  } catch (e) { return false; }
}

async function closeDomainTabs(hostname) {
  const tabs = await browser.tabs.query({});
  const toClose = tabs.filter(t => {
    try { return DomainManager.getHostnameForTab(t) === hostname; } catch { return false; }
  });
  for (const tab of toClose) {
    if (tab.windowId) dirtyWindows.add(tab.windowId);
    await safeRemoveTab(tab.id);
  }
}

async function toggleTabVisibility(tabId) {
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch (e) {
    console.warn('[Coordinator2 V26.1] Toggle visibility: tab not found', tabId);
    return { success: false, error: 'Invalid tab ID' };
  }

  if (tab.hidden) {
    try {
      await browser.tabs.show(tabId);
      await browser.tabs.update(tabId, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
      dirtyWindows.add(tab.windowId);
    } catch (e) {
      return { success: false, error: e.message };
    }
    return { success: true };
  }

  if (tab.active) {
    const allTabs = await browser.tabs.query({ windowId: tab.windowId });
    const otherVisible = allTabs.filter(t => t.id !== tabId && !t.hidden);
    if (otherVisible.length === 0) {
      console.warn('[Coordinator2 V26.1] Cannot hide last visible tab');
      return { success: false, error: 'Cannot hide last visible tab' };
    }
    await browser.tabs.update(otherVisible[0].id, { active: true });
  }

  try {
    const updatedTab = await browser.tabs.get(tabId);
    if (updatedTab.active) {
      console.warn('[Coordinator2 V26.1] Tab still active, abort hide');
      return { success: false, error: 'Tab is active' };
    }
    await browser.tabs.hide(tabId);
    dirtyWindows.add(tab.windowId);
  } catch (e) {
    return { success: false, error: e.message };
  }
  return { success: true };
}

async function moveDomainTabs(hostname, targetWindowId, originalWindowId) {
  if (!originalWindowId) {
    CentralLogger.error('coordinator', 'moveDomainTabs', 'Missing originalWindowId');
    return;
  }
  const allTabs = await browser.tabs.query({});
  const toMove = allTabs.filter(t => {
    try {
      if (t.windowId !== originalWindowId) return false;
      return DomainManager.getHostnameForTab(t) === hostname;
    } catch { return false; }
  });
  for (const tab of toMove) {
    try { await browser.tabs.move(tab.id, { windowId: targetWindowId, index: -1 }); }
    catch (e) { CentralLogger.error('coordinator', 'moveTab', e.message); }
  }
  dirtyWindows.add(targetWindowId);
  dirtyWindows.add(originalWindowId);
}

let updateTimer = null;
function scheduleUpdate(delay = BATCH_UPDATE_MS) {
  if (_batchClosing) return Promise.resolve();
  if (updateTimer) clearTimeout(updateTimer);
  return new Promise(resolve => {
    updateTimer = setTimeout(async () => {
      updateTimer = null;
      await incrementalReconcile();
      resolve();
    }, delay);
  });
}

async function init() {
  await browser.storage.local.set({ backgroundReady: false }).catch(() => {});

  CentralLogger.init();
  ErrorCollector.init();
  HealthChecker.init();
  LiveReporter.init(CentralLogger);

  await loadStateSnapshot();
  if (currentState.windowGroups && currentState.windowGroups.length > 0) {
    await persistAllState();
  }
  await loadEventBuffer();
  await DomainManager.initSessionData();

  // V26.02: Γέμισμα knownWindowIds με τα υπάρχοντα παράθυρα
  const existingWindows = await browser.windows.getAll();
  existingWindows.forEach(w => knownWindowIds.add(w.id));

  const tsData = await browser.storage.local.get(LAST_UPDATE_KEY);
  const storedTs = tsData[LAST_UPDATE_KEY] || 0;
  const now = Date.now();
  const STALE_THRESHOLD_MS = 30000;
  const stateIsStale = (now - storedTs) > STALE_THRESHOLD_MS || storedTs === 0;

  if (stateIsStale) {
    console.log(`[Coordinator2 V26.1] State is stale (${now - storedTs}ms), performing quick rebuild`);

    _rebuildPromise = (async () => {
      const allTabsNow = await browser.tabs.query({});
      allTabsNow.forEach(t => {
        knownTabIds.add(t.id);
        tabUrlMap.set(t.id, { url: t.url, incognito: t.incognito });
        if (t.favIconUrl && (t.favIconUrl.startsWith('data:') || t.favIconUrl.startsWith('moz-extension:'))) {
          const hostname = DomainManager.getHostnameForTab(t);
          if (hostname) lastKnownFavicon.set(hostname, t.favIconUrl);
        }
      });
      isInitialized = true;
      drainEarlyEvents();
      const allWindowsNow = await browser.windows.getAll();
      for (const win of allWindowsNow) {
        knownWindowIds.add(win.id);
        if (win.type !== 'devtools') {
          dirtyWindows.add(win.id);
        }
      }
      await incrementalReconcile();
      console.log('[Coordinator2 V26.1] Quick rebuild (reconcile) complete');
    })();

    await _rebuildPromise;
    _rebuildPromise = null;
  } else {
    const allTabs = await browser.tabs.query({});
    allTabs.forEach(t => {
      tabUrlMap.set(t.id, { url: t.url, incognito: t.incognito });
      knownTabIds.add(t.id);
      if (t.url && t.favIconUrl && (t.favIconUrl.startsWith('data:') || t.favIconUrl.startsWith('moz-extension:'))) {
        const hostname = DomainManager.getHostnameForTab(t);
        if (hostname) {
          addFaviconUrlToCache(hostname, t.favIconUrl);
          cacheAndNotify(hostname, t.favIconUrl);
          lastKnownFavicon.set(hostname, t.favIconUrl);
        }
      } else if (t.favIconUrl && !lastKnownFavicon.has(DomainManager.getHostnameForTab(t))) {
        const hostname = DomainManager.getHostnameForTab(t);
        if (hostname) lastKnownFavicon.set(hostname, t.favIconUrl);
      }
    });
    const storedExec = (await browser.storage.local.get(STORAGE_KEYS.EXECUTION_STORE))[STORAGE_KEYS.EXECUTION_STORE];
    if (storedExec && Array.isArray(storedExec)) {
      storedExec.forEach(([k, v]) => executionStore.set(k, v));
    }
    await replayEvents();

    isInitialized = true;
    drainEarlyEvents();

    const allWindowsNow = await browser.windows.getAll();
    allWindowsNow.forEach(w => {
      knownWindowIds.add(w.id);
      if (w.type !== 'devtools') dirtyWindows.add(w.id);
    });

    await incrementalReconcile();
  }

  await ensureDomainOrders();

  browser.alarms.create(POLL_ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  browser.alarms.create(CLEANUP_STALE_ALARM, { periodInMinutes: CLEANUP_STALE_INTERVAL / 60 });
  browser.alarms.create(UPDATE_SCS_ALARM, { periodInMinutes: UPDATE_SCS_INTERVAL / 60 });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM_NAME) {
      checkMissingTabs();
    } else if (alarm.name === CLEANUP_STALE_ALARM) {
      cleanupStaleSidebars();
    } else if (alarm.name === UPDATE_SCS_ALARM) {
      updateScsStats();
    }
  });

  const { lastVersion } = await browser.storage.local.get('lastVersion');
  const currentVersion = browser.runtime.getManifest().version;
  if (lastVersion && lastVersion !== currentVersion) {
    try {
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon.svg',
        title: 'Group Tabs Sidebar',
        message: `Η επέκταση ενημερώθηκε στην έκδοση ${currentVersion}!`
      });
    } catch (e) {}
  }
  await browser.storage.local.set({ lastVersion: currentVersion });

  await browser.storage.local.set({ sidebarUpdateAvailable: false }).catch(() => {});
  updateAvailable = false;
  try {
    const win = await browser.windows.getLastFocused();
    if (win) focusedWindowId = win.id;
  } catch (e) {}
  updateSidebarActiveStorage();
  updateScsStats();

  await browser.storage.local.set({ backgroundReady: true }).catch(() => {});
  console.log('[Coordinator2 V26.1] Initialization complete');
}

init().catch(err => {
  console.error('[Coordinator2 V26.1] Init failed:', err);
  CentralLogger.error('coordinator', 'init', err.message);
});