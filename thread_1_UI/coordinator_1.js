// Coordinator 1 – Sidebar UI (V26.1)
// V26.1: Fix heartbeat ACK – χρήση await sendMessage + updateActivity() όταν ληφθεί ACK.
//        Fix heartbeat windowId – χρήση myWindowId αντί για StateObserver.getActiveWindowId(),
//        με fallback αν το myWindowId δεν έχει αρχικοποιηθεί ακόμα.
console.log('[Coordinator1 V26.1] Initializing...');

let globalAbortController = null;
window.isDragging = false;
let pendingStateDuringDrag = null;
let _lastAppliedRevision = -1;
const _pendingRevisions = new Set();
let initialRenderDone = false;

// V26.1: Το δικό μας windowId – σταθερό για τη ζωή του sidebar.
let myWindowId = null;

let dragSafetyTimer = null;
function resetDragIfStuck() {
  if (window.isDragging) {
    window.isDragging = false;
    document.querySelectorAll('.domain-item.dragging').forEach(el => el.classList.remove('dragging'));
  }
  if (pendingStateDuringDrag) {
    const state = pendingStateDuringDrag;
    pendingStateDuringDrag = null;
    window._applyStateNow(state);
  }
  if (dragSafetyTimer) {
    clearTimeout(dragSafetyTimer);
    dragSafetyTimer = null;
  }
}

let pendingScrollToWindowId = null;
let lastFocusedWindowId = null;
let lastFocusTimestamp = 0;
const FOCUS_DEBOUNCE_MS = 500;

window.sendAction = async function(type, payload, retries = 2) {
  console.log('[Coordinator1 V26.1] sendAction:', type, payload);

  if (type === 'REQUEST_FOCUS_WINDOW' && payload.windowId) {
    const now = Date.now();
    if (payload.windowId === lastFocusedWindowId && (now - lastFocusTimestamp) < FOCUS_DEBOUNCE_MS) {
      console.log('[Coordinator1 V26.1] Ignoring duplicate REQUEST_FOCUS_WINDOW for window', payload.windowId);
      return;
    }
    lastFocusedWindowId = payload.windowId;
    lastFocusTimestamp = now;
  }

  if (type === 'REQUEST_MOVE_TAB' && payload.targetWindowId) {
    pendingScrollToWindowId = payload.targetWindowId;
  }

  const msg = {
    type, source: 'sidebar', target: 'background',
    requestId: crypto.randomUUID(), timestamp: new Date().toISOString(), payload,
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await browser.runtime.sendMessage(msg);
      if (resp && resp.type === 'ACTION_ALREADY_EXECUTED') {
        console.log('[Coordinator1 V26.1] Action already executed');
        return resp;
      }
      if (resp && resp.success === false) {
        if (resp.error && resp.error.includes('Invalid tab ID')) {
          console.warn('[Coordinator1 V26.1] Tab not found, action aborted');
          return resp;
        }
        console.warn('[Coordinator1 V26.1] Action failed:', resp.error);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
      }
      return resp;
    } catch (e) {
      console.warn('[Coordinator1 V26.1] sendAction error:', e);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  return null;
};

window._applyStateNow = async function(state) {
  if (window.isDragging) {
    console.log('[Coordinator1 V26.1] Dragging, deferring state update');
    pendingStateDuringDrag = state;
    if (!dragSafetyTimer) dragSafetyTimer = setTimeout(resetDragIfStuck, 3000);
    return;
  }
  await handleStateUpdateNow(state);
};

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'STATE_UPDATE' && message.payload) {
    console.log('[Coordinator1 V26.1] State update received via runtime message, enqueuing to StateScheduler');
    StateScheduler.enqueue(message.payload);
  }
  if (message && message.type === 'PERFORMANCE_TIER_CHANGED') {
    console.log('[Coordinator1 V26.1] Performance tier change requested, reloading...');
    location.reload();
  }
});

StateObserver.setOnStateUpdate(async (newState) => {
  console.log('[Coordinator1 V26.1] State update received via StateObserver, enqueuing to StateScheduler');
  StateScheduler.enqueue(newState);
});

async function handleStateUpdateNow(state) {
  if (dragSafetyTimer) { clearTimeout(dragSafetyTimer); dragSafetyTimer = null; }

  const rev = state.stateRevision;

  if (_pendingRevisions.has(rev)) {
    console.log('[Coordinator1 V26.1] Revision already pending:', rev);
    return;
  }
  if (rev <= _lastAppliedRevision) {
    console.log('[Coordinator1 V26.1] Skipping older/duplicate revision:', rev);
    return;
  }

  _pendingRevisions.add(rev);

  if (state.activeWindowId !== undefined && StateObserver.getActiveWindowId() !== state.activeWindowId) {
    StateObserver._setActiveWindowId(state.activeWindowId);
  }

  if (globalAbortController) {
    console.log('[Coordinator1 V26.1] Aborting previous patch');
    globalAbortController.abort();
  }

  globalAbortController = new AbortController();
  const signal = globalAbortController.signal;

  try {
    if (!initialRenderDone) {
      window._initialRender = true;
    }

    console.log('[Coordinator1 V26.1] Patching state revision:', rev);
    await DOMPatcher.patchState(state, signal, () => StateObserver.getActiveWindowId());

    _lastAppliedRevision = rev;
    ensureNewTabButton();

    if (!initialRenderDone) {
      initialRenderDone = true;
      window._initialRender = false;

      if (typeof PreRender !== 'undefined' && PreRender.setInitialRenderComplete) {
        PreRender.setInitialRenderComplete();
        console.log('[Coordinator1 V26.1] PreRender initial render complete – fade‑in enabled');
      }
      const root = document.getElementById('sidebar-root');
      if (root) {
        root.classList.add('dock-reveal');
        console.log('[Coordinator1 V26.1] dock-reveal animation activated');
      }
    }

    if (pendingScrollToWindowId) {
      const targetId = pendingScrollToWindowId;
      pendingScrollToWindowId = null;
      setTimeout(() => {
        const targetGroup = document.querySelector(`.window-group[data-window-id="${targetId}"]`);
        if (targetGroup) {
          targetGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetGroup.style.transition = 'box-shadow 0.3s';
          targetGroup.style.boxShadow = '0 0 20px rgba(0,150,255,0.8)';
          setTimeout(() => { targetGroup.style.boxShadow = ''; }, 2000);
        }
      }, 200);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[Coordinator1 V26.1] Patch error:', err);
    }
  } finally {
    globalAbortController = null;
    _pendingRevisions.delete(rev);
  }
}

// ── Εγκατάσταση global listeners ΜΙΑ ΦΟΡΑ ──
function setupGlobalListeners() {
  console.log('[Coordinator1 V26.1] Setting up global listeners once');

  document.addEventListener('click', function(e) {
    const group = e.target.closest('.window-group');
    if (!group || e.target.closest('button')) return;
    const windowId = parseInt(group.dataset.windowId, 10);
    if (!isNaN(windowId)) {
      window.sendAction('REQUEST_FOCUS_WINDOW', { windowId });
    }
  });

  document.addEventListener('click', globalCloseButtonHandler);
  document.addEventListener('click', domainActivationHandler);
  document.addEventListener('contextmenu', domainContextMenuHandler);

  if (typeof attachDragDrop === 'function') {
    attachDragDrop();
  }

  if (typeof attachTreeListeners === 'function') {
    attachTreeListeners(new AbortController().signal);
  }

  if (typeof attachPopupListeners === 'function') {
    attachPopupListeners(new AbortController().signal);
  }

  if (typeof initZoom === 'function') {
    initZoom();
  }

  ensureNewTabButton();
}

function globalCloseButtonHandler(e) {
  const closeDomainBtn = e.target.closest('.close-domain-btn');
  if (closeDomainBtn) {
    e.stopPropagation();
    const domainItem = closeDomainBtn.closest('.domain-item');
    if (domainItem) {
      const hostname = domainItem.dataset.hostname;
      let tabIds = [];
      try { tabIds = JSON.parse(domainItem.dataset.tabIds || '[]'); } catch (e) {}
      const validTabIds = [];
      const popupCards = domainItem.querySelectorAll('.popup-tab-card');
      for (const card of popupCards) {
        const cardTabId = parseInt(card.dataset.tabId, 10);
        if (tabIds.includes(cardTabId)) {
          validTabIds.push(cardTabId);
        }
      }
      const finalTabIds = validTabIds.length > 0 ? validTabIds : tabIds;

      StateObserver.optimisticCloseDomain(domainItem, false);
      window.sendAction('REQUEST_CLOSE_DOMAIN_TABS', { hostname, tabIds: finalTabIds });
    }
    return;
  }

  const closeTreeBtn = e.target.closest('.close-tree-btn');
  if (closeTreeBtn) {
    e.stopPropagation();
    const treeParent = closeTreeBtn.closest('.tree-parent');
    if (treeParent) {
      const groupId = treeParent.dataset.groupId;
      const windowGroup = treeParent.closest('.window-group');
      const windowId = windowGroup ? parseInt(windowGroup.dataset.windowId, 10) : StateObserver.getActiveWindowId();
      StateObserver.optimisticCloseTree(treeParent, true);
      window.sendAction('REQUEST_CLOSE_ALL_TABS_IN_GROUP', { groupId, windowId });
    }
    return;
  }

  const tabCloseBtn = e.target.closest('.tab-btn.close-btn');
  if (tabCloseBtn) {
    e.stopPropagation();
    const card = tabCloseBtn.closest('.popup-tab-card');
    if (card) {
      const tabId = parseInt(card.dataset.tabId, 10);
      const domainItem = card.closest('.domain-item');
      if (!isNaN(tabId) && domainItem) {
        window.DomainBadge?.decrement(domainItem.dataset.hostname);
        StateObserver.optimisticCloseTab(tabId, domainItem, false);
        window.sendAction('REQUEST_CLOSE_TAB', { tabId });
      }
    }
    return;
  }
}

function domainActivationHandler(e) {
  const domainItem = e.target.closest('.domain-item:not(.tree-parent)');
  if (!domainItem || e.target.closest('button')) return;
  if (domainItem.dataset.fadingOut === 'true') return;
  e.preventDefault();
  const popup = domainItem.querySelector('.domain-popup');
  if (!popup || popup.classList.contains('single-hidden')) {
    const tabCard = domainItem.querySelector('.popup-tab-card');
    if (tabCard && tabCard.dataset.tabId) {
      const tabId = parseInt(tabCard.dataset.tabId);
      if (!isNaN(tabId)) {
        window.sendAction('REQUEST_ACTIVATE_TAB', { tabId });
      }
    }
  } else {
    if (domainItem.classList.contains('show-popup')) {
      if (typeof closePopupDirectly === 'function') closePopupDirectly(domainItem, popup);
    } else {
      if (typeof openPopup === 'function') openPopup(domainItem);
    }
  }
}

// ── Custom context menu ──
let currentContextMenu = null;

function domainContextMenuHandler(e) {
  const domainItem = e.target.closest('.domain-item');
  if (!domainItem || e.target.closest('button')) return;
  e.preventDefault();
  const displayHostname = domainItem.dataset.firstHostname || domainItem.dataset.hostname;
  if (displayHostname) showCustomContextMenu(e.clientX, e.clientY, displayHostname, domainItem);
}

function showCustomContextMenu(x, y, hostname, domainItem) {
  hideCustomContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu-glass';
  menu.dataset.hostname = hostname;
  menu.style.minWidth = 'unset';
  menu.style.maxWidth = 'none';
  menu.style.width = 'auto';
  menu.style.visibility = 'hidden';
  menu.style.whiteSpace = 'nowrap';
  document.body.appendChild(menu);

  const option = document.createElement('div');
  option.className = 'context-menu-item';
  option.style.whiteSpace = 'inherit';
  option.textContent = browser.i18n.getMessage('contextMenuOpenNewTab') || 'Άνοιγμα νέας καρτέλας';
  menu.appendChild(option);

  const glassPane = document.getElementById('glass-pane');
  const bounds = glassPane ? glassPane.getBoundingClientRect() : document.body.getBoundingClientRect();
  const PADDING = 8;
  const MAX_WIDTH = bounds.width - PADDING * 2;
  const MIN_WIDTH = 120;

  setTimeout(() => {
    let naturalWidth = menu.scrollWidth;
    let finalWidth = Math.min(naturalWidth, MAX_WIDTH);

    if (finalWidth < naturalWidth) {
      menu.style.whiteSpace = 'normal';
      menu.style.wordBreak = 'break-word';
      naturalWidth = menu.scrollWidth;
      finalWidth = Math.min(naturalWidth, MAX_WIDTH);
    } else {
      menu.style.whiteSpace = 'nowrap';
    }

    menu.style.width = finalWidth + 'px';
    menu.style.maxWidth = finalWidth + 'px';
    menu.style.minWidth = MIN_WIDTH + 'px';

    const menuHeight = menu.offsetHeight;

    let left = x;
    if (left + finalWidth > bounds.right - PADDING) {
      left = bounds.right - PADDING - finalWidth;
    }
    if (left < bounds.left + PADDING) {
      left = bounds.left + PADDING;
    }

    let top = y;
    if (top + menuHeight > bounds.bottom - PADDING) {
      top = bounds.bottom - PADDING - menuHeight;
    }
    if (top < bounds.top + PADDING) {
      top = bounds.top + PADDING;
    }

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.visibility = 'visible';
  }, 10);

  option.addEventListener('click', (e) => {
    e.stopPropagation();
    const groupId = domainItem ? domainItem.dataset.groupId || null : null;

    let finalHostname = hostname;
    if (hostname && hostname.startsWith('about:home::')) {
      finalHostname = 'about:home';
    } else if (hostname && hostname.startsWith('about:privatebrowsing::')) {
      finalHostname = 'about:privatebrowsing';
    }

    window.sendAction('REQUEST_OPEN_NEW_TAB_FROM_DOMAIN', {
      hostname: finalHostname,
      groupId: groupId
    });
    hideCustomContextMenu();
  });

  currentContextMenu = menu;

  setTimeout(() => {
    document.addEventListener('click', closeContextMenuOnOutsideClick);
    document.addEventListener('keydown', closeContextMenuOnEscape);
  }, 0);
}

function hideCustomContextMenu() {
  if (currentContextMenu) {
    currentContextMenu.remove();
    currentContextMenu = null;
    document.removeEventListener('click', closeContextMenuOnOutsideClick);
    document.removeEventListener('keydown', closeContextMenuOnEscape);
  }
}

function closeContextMenuOnOutsideClick(e) {
  if (currentContextMenu && !currentContextMenu.contains(e.target)) hideCustomContextMenu();
}
function closeContextMenuOnEscape(e) {
  if (e.key === 'Escape') hideCustomContextMenu();
}

// ── Heartbeat & Wake-Up ──
let heartbeatTimer = null;
const HEARTBEAT_INTERVAL = 2000;
let lastHeartbeatActivity = Date.now();
let lastReattachTime = 0;
const MIN_REATTACH_INTERVAL = 10000;

function startHeartbeat() {
  if (heartbeatTimer) return;
  lastHeartbeatActivity = Date.now();

  // V26.1: Έλεγχος κάθε HEARTBEAT_INTERVAL (2s) αν πέρασαν >60s από την τελευταία δραστηριότητα.
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastHeartbeatActivity > 60000 && now - lastReattachTime > MIN_REATTACH_INTERVAL) {
      console.warn('[Coordinator1 V26.1] Long idle – requesting fresh state');
      requestInitialState();
      lastReattachTime = now;
    }
  }, HEARTBEAT_INTERVAL);

  window.addEventListener('focus', updateActivity);
  window.addEventListener('mousemove', updateActivity);
  window.addEventListener('keydown', updateActivity);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateActivity();
  });
  window.addEventListener('scroll', updateActivity, { capture: true, passive: true });
  document.addEventListener('click', updateActivity, { capture: true });

  // V26.1: ΔΕΝ χρειάζεται πλέον heartbeatListener – το ACK έρχεται μέσω response του sendMessage.
  browser.runtime.onMessage.addListener(faviconReadyListener);
}

function faviconReadyListener(message) {
  if (message && message.type === 'FAVICON_READY' && message.hostname) {
    console.log(`[Coordinator1 V26.1] FAVICON_READY received for ${message.hostname}`);
    if (window.BSF && window.BSF.onFaviconReady) {
      window.BSF.onFaviconReady(message.hostname);
    }
  }
}

function updateActivity() {
  lastHeartbeatActivity = Date.now();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  window.removeEventListener('focus', updateActivity);
  window.removeEventListener('mousemove', updateActivity);
  window.removeEventListener('keydown', updateActivity);
  window.removeEventListener('scroll', updateActivity, { capture: true });
  document.removeEventListener('click', updateActivity, { capture: true });
  browser.runtime.onMessage.removeListener(faviconReadyListener);
}

function setupWakeUpHandler() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastHeartbeatActivity = Date.now();
      requestInitialState();
    }
  });
  window.addEventListener('focus', () => {
    lastHeartbeatActivity = Date.now();
    requestInitialState();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      lastHeartbeatActivity = Date.now();
      requestInitialState();
    }
  });
}

async function requestInitialState() {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'GET_STATE', source: 'sidebar' });
    if (resp && resp.payload) window._applyStateNow(resp.payload);
  } catch (e) {}
}

function ensureNewTabButton() {
  if (document.getElementById('new-tab-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'new-tab-btn'; btn.id = 'new-tab-btn';
  btn.title = browser.i18n.getMessage('newTab') || 'Open new tab';
  btn.textContent = '+';
  btn.addEventListener('click', () => window.sendAction('REQUEST_OPEN_NEW_TAB', {}));
  document.body.appendChild(btn);
}

function waitForBackgroundReady() {
  return new Promise((resolve) => {
    browser.storage.local.get('backgroundReady').then(({ backgroundReady }) => {
      if (backgroundReady === true) {
        console.log('[Coordinator1 V26.1] Background already ready');
        resolve();
        return;
      }
      console.log('[Coordinator1 V26.1] Waiting for background to be ready...');
      const listener = (changes, areaName) => {
        if (areaName === 'local' && changes.backgroundReady && changes.backgroundReady.newValue === true) {
          browser.storage.onChanged.removeListener(listener);
          console.log('[Coordinator1 V26.1] Background ready signal received');
          resolve();
        }
      };
      browser.storage.onChanged.addListener(listener);
      setTimeout(() => {
        browser.storage.onChanged.removeListener(listener);
        console.warn('[Coordinator1 V26.1] Timeout waiting for background ready, proceeding anyway');
        resolve();
      }, 5000);
    });
  });
}

// ========== INIT ==========
(async function init() {
  console.log('[Coordinator1 V26.1] Initializing...');
  window.isDragging = false;

  // V26.1: Αποθήκευση του δικού μας windowId μία φορά.
  try {
    const currentWin = await browser.windows.getCurrent();
    myWindowId = currentWin.id;
    console.log(`[Coordinator1 V26.1] myWindowId = ${myWindowId}`);
  } catch (e) {
    console.warn('[Coordinator1 V26.1] Could not get current window id, will fall back to active:', e);
    myWindowId = null;
  }

  // V24: Διάβασε χειροκίνητη παράκαμψη απόδοσης
  let tier;
  try {
    const data = await browser.storage.local.get('performanceTierOverride');
    const override = data.performanceTierOverride;
    if (override && override !== 'auto') {
      tier = PerformanceTier.forceTier(override);
      console.log(`[Coordinator1 V26.1] Manual performance tier: ${tier}`);
    } else {
      tier = PerformanceTier.detect();
    }
  } catch (e) {
    tier = PerformanceTier.detect();
  }
  // Αποθήκευση του effective tier για το popup
  await browser.storage.local.set({ performanceEffectiveTier: tier });

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.body.classList.add('reduced-graphics');
  }

  if (typeof TreeState !== 'undefined' && TreeState.load) await TreeState.load();

  setupWakeUpHandler();
  startHeartbeat();
  StateObserver.startPolling();
  browser.tabs.onCreated.addListener(() => { StateObserver.syncKnownTabs(); });

  setupGlobalListeners();

  await waitForBackgroundReady();
  await requestInitialState();

  // V26.1: Χρήση myWindowId αν υπάρχει, αλλιώς fallback.
  if (myWindowId !== null) {
    browser.runtime.sendMessage({ type: 'SIDEBAR_READY', source: 'sidebar', windowId: myWindowId }).catch(() => {});
  } else {
    try {
      const currentWin = await browser.windows.getCurrent();
      myWindowId = currentWin.id;
      browser.runtime.sendMessage({ type: 'SIDEBAR_READY', source: 'sidebar', windowId: myWindowId }).catch(() => {});
    } catch (e) {
      browser.runtime.sendMessage({ type: 'SIDEBAR_READY', source: 'sidebar' }).catch(() => {});
    }
  }

  // V26.1: Heartbeat με async/await + χρήση myWindowId (fallback σε active).
  setInterval(async () => {
    try {
      const heartbeatWindowId = (myWindowId !== null) ? myWindowId : StateObserver.getActiveWindowId();
      const resp = await browser.runtime.sendMessage({
        type: 'SIDEBAR_HEARTBEAT',
        source: 'sidebar',
        windowId: heartbeatWindowId
      });
      if (resp && resp.type === 'SIDEBAR_HEARTBEAT_ACK') {
        updateActivity();
      }
    } catch (e) {
      // Background not responding – μην κάνεις reset το idle timer.
    }
  }, 20000);

  console.log('[Coordinator1 V26.1] Init complete');
})();

window.addEventListener('beforeunload', () => {
  stopHeartbeat();
  StateObserver.stopPolling();
});