// state-observer.js – V22 – Αφαιρέθηκε ο listener του storage.onChanged για sidebarState
console.log('[StateObserver V22] Module loaded');

let lastAppliedRevision = -1;
let onStateUpdateCallback = null;
let activeWindowId = null;

const knownTabIds = new Set();
let pollingInterval = null;
const POLL_DELAY_MS = 500;

// V22: Το state έρχεται αποκλειστικά μέσω runtime.onMessage (STATE_UPDATE) από τον coordinator_1

function setOnStateUpdate(callback) {
  onStateUpdateCallback = callback;
}

function _setActiveWindowId(id) {
  activeWindowId = id;
}

function animateRemove(element, callback) {
  if (!element) {
    if (typeof callback === 'function') callback();
    return;
  }
  console.log('[StateObserver V22] Fading out element:', element.className || element.tagName);
  element.dataset.fadingOut = 'true';
  element.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
  element.style.opacity = '0';
  element.style.transform = 'scale(0.95)';
  let removed = false;
  function finalize() {
    if (removed) return;
    removed = true;
    element.removeEventListener('transitionend', finalize);
    if (element.parentNode) element.remove();
    if (typeof callback === 'function') callback();
  }
  element.addEventListener('transitionend', finalize, { once: true });
  setTimeout(finalize, 350);
}

function removeImmediately(element) {
  if (!element) return;
  element.querySelectorAll('[data-fading-out="true"]').forEach(child => {
    child.style.transition = 'none';
    child.style.opacity = '';
    child.style.transform = '';
    child.dataset.fadingOut = 'false';
  });
  element.dataset.fadingOut = 'false';
  element.style.transition = 'none';
  element.style.opacity = '';
  element.style.transform = '';
  if (element.parentNode) element.remove();
}

function optimisticCloseTab(tabId, domainItem, skipFade = false) {
  console.log('[StateObserver V22] Optimistic close tab:', tabId);
  if (domainItem && domainItem.dataset.hostname) {
    window.DomainBadge?.decrement(domainItem.dataset.hostname);
  }
}

function optimisticCloseDomain(domainItem, skipFade = false) {
  console.log('[StateObserver V22] Optimistic close domain:', domainItem?.dataset?.hostname);
  if (domainItem && domainItem.dataset.hostname) {
    let tabIds = [];
    try { tabIds = JSON.parse(domainItem.dataset.tabIds || '[]'); } catch (e) {}
    for (let i = 0; i < tabIds.length; i++) {
      window.DomainBadge?.decrement(domainItem.dataset.hostname);
    }
  }
}

function optimisticCloseTree(treeParent, skipFade = false) {
  console.log('[StateObserver V22] Optimistic close tree:', treeParent?.dataset?.groupId);
  if (skipFade) {
    const wrapper = treeParent?.nextElementSibling;
    if (wrapper && wrapper.classList.contains('tree-children-wrapper')) {
      removeImmediately(wrapper);
      removeImmediately(treeParent);
    }
  }
}

async function syncKnownTabs() {
  try {
    const allTabs = await browser.tabs.query({});
    knownTabIds.clear();
    for (const tab of allTabs) knownTabIds.add(tab.id);
  } catch (e) {
    console.error('[StateObserver V22] syncKnownTabs error:', e);
  }
}

async function checkForClosedTabs() {
  try {
    const allTabs = await browser.tabs.query({});
    const currentIds = new Set(allTabs.map(t => t.id));
    const missingIds = [...knownTabIds].filter(id => !currentIds.has(id));

    if (missingIds.length > 0) {
      console.log('[StateObserver V22] Polling detected closed tabs:', missingIds);
      for (const tabId of missingIds) {
        const domainItems = document.querySelectorAll('.domain-item');
        for (const item of domainItems) {
          const card = item.querySelector(`.popup-tab-card[data-tab-id="${tabId}"]`);
          if (card) {
            optimisticCloseTab(tabId, item, false);
            break;
          }
        }
      }
    }

    knownTabIds.clear();
    for (const id of currentIds) knownTabIds.add(id);
  } catch (e) {
    console.error('[StateObserver V22] checkForClosedTabs error:', e);
  }
}

function startPolling() {
  if (pollingInterval) return;
  console.log('[StateObserver V22] Starting tab polling every', POLL_DELAY_MS, 'ms');
  syncKnownTabs();
  pollingInterval = setInterval(checkForClosedTabs, POLL_DELAY_MS);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('[StateObserver V22] Polling stopped');
  }
}

window.animateRemove = animateRemove;

window.StateObserver = {
  setOnStateUpdate,
  optimisticCloseTab,
  optimisticCloseDomain,
  optimisticCloseTree,
  removeImmediately,
  animateRemove,
  getActiveWindowId: () => activeWindowId,
  _setActiveWindowId,
  getLastAppliedRevision: () => lastAppliedRevision,
  startPolling,
  stopPolling,
  syncKnownTabs,
};