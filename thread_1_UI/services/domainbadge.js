// domainbadge.js – V17 – Αυτόνομος μετρητής καρτελών, ΔΕΝ αφαιρεί DOM, ΔΕΝ ενημερώνει badges
// V17: refreshFromTabs ΔΕΝ αγγίζει πια badges/popups.
//      Το decrement μπορεί να φιμωθεί προσωρινά από τον DOMPatcher όταν εφαρμόζει state.
'use strict';
console.log('[DomainBadge V17] Module loaded');

const DomainBadge = (() => {
  const pendingDecrements = new Map();
  let _suppressOptimistic = false;

  function getHostnameFromTab(tab) {
    if (!tab.url) return null;
    if (tab.url.startsWith('about:')) {
      const lower = tab.url.toLowerCase();
      if (['about:home','about:newtab','about:blank','about:privatebrowsing'].some(p => lower.startsWith(p))) {
        return tab.incognito ? 'about:privatebrowsing' : 'about:home';
      }
      const m = lower.match(/^(about:[a-z]+)/i);
      return m ? m[1] : lower;
    }
    try { return new URL(tab.url).hostname; } catch { return null; }
  }

  async function refreshFromTabs() {
    try {
      const allTabs = await browser.tabs.query({});
      const items = document.querySelectorAll('.domain-item[data-hostname], .domain-item[data-first-hostname]');
      
      for (const item of items) {
        if (item.dataset.fadingOut === 'true') continue;
        const hostname = item.dataset.firstHostname || item.dataset.hostname;
        if (!hostname) continue;
        
        const windowGroup = item.closest('.window-group');
        const windowId = windowGroup ? parseInt(windowGroup.dataset.windowId, 10) : null;
        
        const realTabs = allTabs.filter(tab => {
          const tabHostname = getHostnameFromTab(tab);
          if (tabHostname !== hostname) return false;
          if (windowId !== null && tab.windowId !== windowId) return false;
          return true;
        });
        
        const realCount = realTabs.length;
        const pending = pendingDecrements.get(hostname) || 0;
        
        if (realCount === 0 && pending === 0) {
          pendingDecrements.delete(hostname);
        }
      }
    } catch (e) {
      console.error('[DomainBadge V17] refreshFromTabs error:', e);
    }
  }

  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshFromTabs();
    }, 250);
  }

  function decrement(hostname) {
    if (!hostname) return;
    if (_suppressOptimistic) {
      console.log('[DomainBadge V17] Optimistic decrement suppressed for', hostname);
      return;
    }
    pendingDecrements.set(hostname, (pendingDecrements.get(hostname) || 0) + 1);
    const items = document.querySelectorAll(`.domain-item[data-hostname="${hostname}"], .domain-item[data-first-hostname="${hostname}"]`);
    for (const item of items) {
      if (item.dataset.fadingOut === 'true') continue;
      const badge = item.querySelector('.badge');
      if (badge) {
        const cur = parseInt(badge.textContent, 10);
        if (!isNaN(cur) && cur > 0) {
          badge.textContent = cur - 1;
          console.log(`[DomainBadge V17] Optimistic decrement: ${hostname} → ${cur - 1}`);
        }
      }
    }
  }

  function clearPending(hostname) {
    if (hostname) pendingDecrements.delete(hostname);
  }

  function syncFromDOM(visibleHostnames) {
    for (const [hostname] of pendingDecrements.entries()) {
      if (!visibleHostnames.has(hostname)) {
        pendingDecrements.delete(hostname);
      }
    }
  }

  async function getRealCount(hostname, windowId) {
    const allTabs = await browser.tabs.query({ windowId: windowId || undefined });
    return allTabs.filter(tab => getHostnameFromTab(tab) === hostname).length;
  }

  function suppressOptimistic(value) {
    _suppressOptimistic = value;
    if (value) {
      console.log('[DomainBadge V17] Optimistic updates suppressed');
    } else {
      console.log('[DomainBadge V17] Optimistic updates resumed');
    }
  }

  browser.tabs.onCreated.addListener(() => scheduleRefresh());
  browser.tabs.onRemoved.addListener(() => scheduleRefresh());
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) scheduleRefresh();
  });

  return { decrement, clearPending, refreshFromTabs, syncFromDOM, getRealCount, suppressOptimistic };
})();

window.DomainBadge = DomainBadge;