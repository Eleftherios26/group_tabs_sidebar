// ============================================================
// Domain Manager V26 – Ελαφρύ state: αφαίρεση title/url από tabs
// ============================================================

const IGNORED_PREFIXES = ['chrome:', 'moz-extension:', 'view-source:', 'data:', 'javascript:'];

const HOMEPAGE_OVERRIDE_EXTENSIONS = new Set([
  'cbf-overlay@Dimitrios.gr',
]);

// ---------- Storage reference ----------
const STORAGE = browser.storage.local;

// Δηλώνουμε έναν χάρτη που θα μας δώσει ο coordinator_2
let lastKnownFaviconMap = new Map();

function isHomepageOverrideURL(url) {
  if (!url || !url.startsWith('moz-extension://')) return false;
  try {
    const id = new URL(url).hostname;
    return HOMEPAGE_OVERRIDE_EXTENSIONS.has(id);
  } catch { return false; }
}

function shouldIgnoreUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return IGNORED_PREFIXES.some(p => lower.startsWith(p));
}

function getHostname(url) {
  if (!url || shouldIgnoreUrl(url)) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

function getAboutHostname(url, isIncognito = false) {
  if (isHomepageOverrideURL(url)) {
    return isIncognito ? 'about:privatebrowsing' : 'about:home';
  }

  const match = url.match(/^(about:[a-z]+)/i);
  if (!match) return url.toLowerCase();
  const host = match[1].toLowerCase();

  if (isIncognito && (host === 'about:home' || host === 'about:newtab' || host === 'about:blank' || host === 'about:privatebrowsing')) {
    return 'about:privatebrowsing';
  }
  if (host === 'about:home' || host === 'about:newtab' || host === 'about:blank') return 'about:home';
  return host;
}

function getStableAboutIdForTab(tab) {
  const url = tab.url;
  if (url === 'about:home' || url === 'about:newtab' || url === 'about:blank' ||
      url === 'about:privatebrowsing' || isHomepageOverrideURL(url)) {
    const host = (tab.incognito || url === 'about:privatebrowsing')
      ? 'about:privatebrowsing'
      : 'about:home';
    return `${host}::window-${tab.windowId}`;
  }
  return null;
}

function getHostnameForTab(tab) {
  const stableId = getStableAboutIdForTab(tab);
  if (stableId) return stableId;

  const url = tab.url;
  if (url && url.toLowerCase().startsWith('about:')) {
    return getAboutHostname(url, tab.incognito === true);
  }
  if (isHomepageOverrideURL(url)) {
    return getAboutHostname(url, tab.incognito === true);
  }
  return getHostname(url);
}

function sanitizeFavIconUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'data:', 'moz-extension:'].includes(parsed.protocol)) return null;
    if (parsed.protocol === 'data:' && url.length > 10000) return null;
    return url;
  } catch { return null; }
}

function isSystemAboutTab(tab) {
  if (!tab.url || !tab.url.toLowerCase().startsWith('about:')) return false;
  const lower = tab.url.toLowerCase();
  return !['about:home', 'about:newtab', 'about:blank', 'about:privatebrowsing'].some(p => lower.startsWith(p));
}

function isStableAboutKey(hostname) {
  return hostname === 'about:home' || hostname === 'about:privatebrowsing' ||
         hostname.startsWith('about:home::') || hostname.startsWith('about:privatebrowsing::');
}

async function getActiveWindowId() {
  try { const win = await browser.windows.getLastFocused(); if (win?.id) return win.id; } catch (e) {}
  try {
    const wins = await browser.windows.getAll();
    for (const w of wins) {
      try { const tabs = await browser.tabs.query({ windowId: w.id }); if (tabs.length > 0) return w.id; } catch {}
    }
  } catch (e) {}
  return null;
}

let mergedGroupsPerWindow = {};
let domainOrderPerWindow = {};
let tabGroupMap = {};

async function saveDomainOrder() {
  try { await STORAGE.set({ session_domainOrder: domainOrderPerWindow }); }
  catch (e) { console.error('[DomainManager V26] saveDomainOrder error:', e); }
}

async function saveMergedGroups() {
  try { await STORAGE.set({ session_mergedGroups: mergedGroupsPerWindow }); }
  catch (e) { console.error('[DomainManager V26] saveMergedGroups error:', e); }
}

async function saveTabGroupMap() {
  try { await STORAGE.set({ session_tabGroupMap: tabGroupMap }); }
  catch (e) { console.error('[DomainManager V26] saveTabGroupMap error:', e); }
}

async function loadTabGroupMap() {
  const data = await STORAGE.get('session_tabGroupMap');
  tabGroupMap = data.session_tabGroupMap || {};
}

async function ensureDomainOrderIncludesHostnames(windowId, hostnames) {
  let order = domainOrderPerWindow[windowId];
  if (!order) {
    order = [];
    domainOrderPerWindow[windowId] = order;
  }
  let modified = false;
  for (const h of hostnames) {
    if (!order.includes(h)) {
      order.push(h);
      modified = true;
    }
  }
  if (modified) {
    await saveDomainOrder();
  }
}

function cleanDomainOrder(windowId, currentKeys) {
  const order = domainOrderPerWindow[windowId];
  if (!order || order.length === 0) return false;
  
  const newOrder = order.filter(key => currentKeys.has(key));
  if (newOrder.length !== order.length) {
    domainOrderPerWindow[windowId] = newOrder;
    console.log(`[DomainManager V26] Cleaned domainOrder for window ${windowId}`);
    return true;
  }
  return false;
}

// ── V26: Αφαίρεση title/url από τα tabs στο domainMap ──
function createLightTab(tab) {
  return {
    id: tab.id,
    active: tab.active,
    visible: tab.hidden ? false : true
  };
}

async function resolveFaviconsInDomainMap(domainMap) {
  for (const [key, group] of Object.entries(domainMap)) {
    if (!group.isMerged) {
      if (!group.favIconUrl || group.favIconUrl.startsWith('http:') || group.favIconUrl.startsWith('https:')) {
        const cached = await FaviconCache.getCachedFavicon(key);
        if (cached && cached.dataUrl) {
          group.favIconUrl = cached.dataUrl;
        } else if (lastKnownFaviconMap && lastKnownFaviconMap.has(key)) {
          group.favIconUrl = lastKnownFaviconMap.get(key);
        }
      }
    } else if (group.hostGroups) {
      for (const hg of group.hostGroups) {
        if (!hg.favIconUrl || hg.favIconUrl.startsWith('http:') || hg.favIconUrl.startsWith('https:')) {
          const cached = await FaviconCache.getCachedFavicon(hg.hostname);
          if (cached && cached.dataUrl) {
            hg.favIconUrl = cached.dataUrl;
          } else if (lastKnownFaviconMap && lastKnownFaviconMap.has(hg.hostname)) {
            hg.favIconUrl = lastKnownFaviconMap.get(hg.hostname);
          }
        }
      }
    }
  }
}

const _recentlyRemovedHostnames = new Map();

function _markHostnameAsRecentlyRemoved(hostname) {
  if (!hostname) return;
  const existing = _recentlyRemovedHostnames.get(hostname);
  if (existing) {
    clearTimeout(existing);
  }
  const timeoutId = setTimeout(() => {
    _recentlyRemovedHostnames.delete(hostname);
    console.log(`[DomainManager V26] Hostname ${hostname} removed from recently-removed list`);
  }, 2000);
  _recentlyRemovedHostnames.set(hostname, timeoutId);
}

function _isRecentlyRemoved(hostname) {
  return _recentlyRemovedHostnames.has(hostname);
}

const DomainManager = {
  _windowIndexMap: new Map(),

  setLastKnownFaviconMap(map) {
    lastKnownFaviconMap = map;
    console.log('[DomainManager V26] lastKnownFaviconMap updated');
  },

  async initSessionData() {
    console.log('[DomainManager V26] initSessionData');
    const data = await STORAGE.get(['session_domainOrder', 'session_mergedGroups']);
    domainOrderPerWindow = data.session_domainOrder || {};
    mergedGroupsPerWindow = data.session_mergedGroups || {};
    await loadTabGroupMap();
    await this._migrateGroupsToUUID();
  },

  async _migrateGroupsToUUID() {
    console.log('[DomainManager V26] Checking for old hostname-based groupIds...');
    let needsSave = false;
    for (const [windowId, groups] of Object.entries(mergedGroupsPerWindow)) {
      const newGroups = {};
      for (const [oldId, group] of Object.entries(groups)) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(oldId)) {
          newGroups[oldId] = group;
        } else {
          const newId = crypto.randomUUID();
          console.log(`[DomainManager V26] Migrating group ${oldId} -> ${newId}`);
          newGroups[newId] = group;
          for (const [tabId, gid] of Object.entries(tabGroupMap)) {
            if (gid === oldId) tabGroupMap[tabId] = newId;
          }
          if (domainOrderPerWindow[windowId]) {
            domainOrderPerWindow[windowId] = domainOrderPerWindow[windowId].map(h => h === oldId ? newId : h);
          }
          needsSave = true;
        }
      }
      mergedGroupsPerWindow[windowId] = newGroups;
    }
    if (needsSave) {
      await saveMergedGroups();
      await saveDomainOrder();
      await saveTabGroupMap();
      console.log('[DomainManager V26] Migration completed.');
    } else {
      console.log('[DomainManager V26] No migration needed.');
    }
  },

  getHostnameForTab(tab) {
    return getHostnameForTab(tab);
  },

  async handleTabCreatedFromOpener(tabId, openerTabId, windowId) {
    const groupId = tabGroupMap[openerTabId];
    if (!groupId) return;

    const tab = await browser.tabs.get(tabId);
    const newHostname = getHostnameForTab(tab);
    if (!newHostname) return;

    const groups = mergedGroupsPerWindow[windowId] || {};
    const group = groups[groupId];
    if (!group) return;

    if (!group.domains.includes(newHostname)) {
      group.domains.push(newHostname);
    }

    tabGroupMap[tabId] = groupId;
    await saveMergedGroups();
    await saveTabGroupMap();
    console.log(`[DomainManager V26] Tab ${tabId} joined group ${groupId}`);
  },

  async handleTabNavigation(tabId, oldUrl, newUrl) {
    if (!oldUrl || !newUrl) return;
    const oldHostname = getHostnameForTab({ url: oldUrl });
    const newHostname = getHostnameForTab({ url: newUrl });
    if (!oldHostname || !newHostname || oldHostname === newHostname) return;

    const groupId = tabGroupMap[tabId];
    if (!groupId) return;

    let windowId;
    for (const [wid, groups] of Object.entries(mergedGroupsPerWindow)) {
      if (groups[groupId]) {
        windowId = parseInt(wid, 10);
        break;
      }
    }
    if (!windowId) {
      const allWindows = await browser.windows.getAll();
      for (const win of allWindows) {
        const tabs = await browser.tabs.query({ windowId: win.id });
        if (tabs.some(t => t.id === tabId)) {
          windowId = win.id;
          break;
        }
      }
      if (!windowId) return;
    }

    const mergedGroups = mergedGroupsPerWindow[windowId] || {};
    const group = mergedGroups[groupId];
    if (!group) {
      delete tabGroupMap[tabId];
      await saveTabGroupMap();
      return;
    }

    const allTabs = await browser.tabs.query({ windowId });
    const oldDomainTabsInGroup = allTabs.filter(t => {
      const h = getHostnameForTab(t);
      return h === oldHostname && t.id !== tabId && tabGroupMap[t.id] === groupId;
    });

    const oldIndex = group.domains.indexOf(oldHostname);

    if (oldDomainTabsInGroup.length === 0) {
      group.domains = group.domains.filter(d => d !== oldHostname);
    }

    if (!group.domains.includes(newHostname)) {
      if (oldIndex >= 0) {
        group.domains.splice(oldIndex, 0, newHostname);
      } else {
        group.domains.push(newHostname);
      }
    }

    tabGroupMap[tabId] = groupId;
    await saveMergedGroups();
    await saveTabGroupMap();
    console.log(`[DomainManager V26] Tab ${tabId} navigated, updated group ${groupId}`);
  },

  async handleTabRemoved(tabId) {
    if (tabGroupMap[tabId]) {
      const groupId = tabGroupMap[tabId];
      delete tabGroupMap[tabId];
      await saveTabGroupMap();
      console.log(`[DomainManager V26] Tab ${tabId} removed from tabGroupMap (group ${groupId})`);
      
      let windowId = null;
      for (const [wid, groups] of Object.entries(mergedGroupsPerWindow)) {
        if (groups[groupId]) {
          windowId = parseInt(wid, 10);
          break;
        }
      }
      if (windowId) {
        const tabsInGroup = Object.entries(tabGroupMap).filter(([_, gid]) => gid === groupId);
        if (tabsInGroup.length === 0) {
          console.log(`[DomainManager V26] Group ${groupId} is empty, removing permanently`);
          delete mergedGroupsPerWindow[windowId][groupId];
          if (domainOrderPerWindow[windowId]) {
            domainOrderPerWindow[windowId] = domainOrderPerWindow[windowId].filter(h => h !== groupId);
          }
          await saveMergedGroups();
          await saveDomainOrder();
        }
      }
    }
  },

  async getStateSnapshot() {
    console.log('[DomainManager V26] getStateSnapshot');
    const allWindows = await browser.windows.getAll({ populate: true });
    const newMap = new Map();

    const sortedWindows = [...allWindows]
      .filter(win => win.type !== 'devtools')
      .sort((a, b) => a.id - b.id);

    let index = 1;
    for (const win of sortedWindows) {
      this._windowIndexMap.set(win.id, index++);

      let tabs;
      try { tabs = await browser.tabs.query({ windowId: win.id }); } catch { tabs = []; }

      const filteredTabs = tabs.filter(t => !AboutPageManager.isPendingPlaceholder(t));

      const currentHostnames = new Set();
      for (const tab of filteredTabs) {
        const hostname = getHostnameForTab(tab);
        if (hostname) currentHostnames.add(hostname);
      }
      await ensureDomainOrderIncludesHostnames(win.id, [...currentHostnames]);

      const rawMap = new Map();
      for (const tab of filteredTabs) {
        const hostname = getHostnameForTab(tab);
        if (!hostname) continue;
        if (_isRecentlyRemoved(hostname)) continue;
        if (!rawMap.has(hostname)) {
          rawMap.set(hostname, {
            hostname,
            favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
            tabs: [],
            isSystemAbout: isSystemAboutTab(tab),
          });
        }
        const domain = rawMap.get(hostname);
        // V26: χρησιμοποιούμε createLightTab
        domain.tabs.push(createLightTab(tab));
        if (tab.favIconUrl) domain.favIconUrl = sanitizeFavIconUrl(tab.favIconUrl);
      }

      newMap.set(win.id, { rawMap, incognito: win.incognito, totalTabs: filteredTabs.length });
    }

    const windowGroups = [];
    for (const [windowId, winData] of newMap.entries()) {
      const mergedGroups = mergedGroupsPerWindow[windowId] || {};
      const domainOrder = domainOrderPerWindow[windowId] || [];
      const domainMap = buildWindowDomainMapOrdered(winData.rawMap, mergedGroups, domainOrder, tabGroupMap, windowId);

      const currentKeys = new Set(Object.keys(domainMap));
      if (cleanDomainOrder(windowId, currentKeys)) {
        saveDomainOrder().catch(() => {});
      }

      await resolveFaviconsInDomainMap(domainMap);

      const idx = this._windowIndexMap.get(windowId) || windowId;
      const title = browser.i18n.getMessage('windowTitle', idx.toString());

      windowGroups.push({ windowId, title, domainMap, incognito: winData.incognito });
    }

    const activeWindowId = await getActiveWindowId();
    const allTabs = await browser.tabs.query({});
    const enriched = await enrichWindowGroupsWithVisibility(windowGroups, allTabs);
    console.log('[DomainManager V26] getStateSnapshot complete, windows:', windowGroups.length);
    return { windowGroups: enriched, activeWindowId };
  },

  async updateWindowState(windowId, currentState) {
    console.log('[DomainManager V26] updateWindowState', windowId);
    try {
      let win;
      try { win = await browser.windows.get(windowId); } catch (e) {
        currentState.windowGroups = currentState.windowGroups.filter(wg => wg.windowId !== windowId);
        return;
      }
      if (win.type === 'devtools') {
        currentState.windowGroups = currentState.windowGroups.filter(wg => wg.windowId !== windowId);
        return;
      }

      let tabs;
      try { tabs = await browser.tabs.query({ windowId }); } catch { tabs = []; }

      const filteredTabs = tabs.filter(t => !AboutPageManager.isPendingPlaceholder(t));

      const currentHostnames = new Set();
      for (const tab of filteredTabs) {
        const hostname = getHostnameForTab(tab);
        if (hostname) currentHostnames.add(hostname);
      }
      await ensureDomainOrderIncludesHostnames(windowId, [...currentHostnames]);

      const rawMap = new Map();
      for (const tab of filteredTabs) {
        const hostname = getHostnameForTab(tab);
        if (!hostname) continue;
        if (_isRecentlyRemoved(hostname)) continue;
        if (!rawMap.has(hostname)) {
          rawMap.set(hostname, {
            hostname,
            favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
            tabs: [],
            isSystemAbout: isSystemAboutTab(tab),
          });
        }
        const domain = rawMap.get(hostname);
        domain.tabs.push(createLightTab(tab));
        if (tab.favIconUrl) domain.favIconUrl = sanitizeFavIconUrl(tab.favIconUrl);
      }

      const mergedGroups = mergedGroupsPerWindow[windowId] || {};
      const domainOrder = domainOrderPerWindow[windowId] || [];
      const domainMap = buildWindowDomainMapOrdered(rawMap, mergedGroups, domainOrder, tabGroupMap, windowId);

      const currentKeys = new Set(Object.keys(domainMap));
      if (cleanDomainOrder(windowId, currentKeys)) {
        saveDomainOrder().catch(() => {});
      }

      await resolveFaviconsInDomainMap(domainMap);

      if (!this._windowIndexMap.has(windowId)) {
        const allWindows = await browser.windows.getAll();
        const sortedIds = allWindows.filter(w => w.type !== 'devtools').map(w => w.id).sort((a,b)=>a-b);
        this._windowIndexMap.set(windowId, sortedIds.indexOf(windowId) + 1);
      }
      const idx = this._windowIndexMap.get(windowId) || 1;
      const title = browser.i18n.getMessage('windowTitle', idx.toString());

      let wg = currentState.windowGroups.find(w => w.windowId === windowId);
      if (wg) {
        wg.title = title;
        wg.domainMap = domainMap;
        wg.incognito = win.incognito;
      } else {
        currentState.windowGroups.push({ windowId, title, domainMap, incognito: win.incognito });
      }

      const allTabs = await browser.tabs.query({});
      currentState.windowGroups = await enrichWindowGroupsWithVisibility(currentState.windowGroups, allTabs);
      currentState.activeWindowId = await getActiveWindowId();
      console.log(`[DomainManager V26] updateWindowState done for window ${windowId}, domainMap keys:`, Object.keys(domainMap));
    } catch (e) {
      console.error('[DomainManager V26] updateWindowState error:', e);
    }
  },

  async updateWindowStateWithRealTabs(windowId, currentState, realTabs) {
    console.log(`[DomainManager V26] updateWindowStateWithRealTabs window=${windowId}, tabs=${realTabs.length}`);
    const win = await browser.windows.get(windowId).catch(() => null);
    if (!win || win.type === 'devtools') {
      currentState.windowGroups = currentState.windowGroups.filter(wg => wg.windowId !== windowId);
      console.log(`[DomainManager V26] Window ${windowId} removed or devtools, cleaned up`);
      return;
    }

    const realTabIds = new Set(realTabs.map(t => t.id));
    let cleaned = false;
    for (const tabIdStr of Object.keys(tabGroupMap)) {
      const tabId = parseInt(tabIdStr, 10);
      if (!realTabIds.has(tabId)) {
        delete tabGroupMap[tabId];
        cleaned = true;
        console.log(`[DomainManager V26] Cleaned stale tabGroupMap entry for tab ${tabId}`);
      }
    }
    if (cleaned) {
      await saveTabGroupMap();
    }

    const rawMap = new Map();
    for (const tab of realTabs) {
      if (AboutPageManager.isPendingPlaceholder(tab)) continue;
      const hostname = getHostnameForTab(tab);
      if (!hostname) continue;
      if (_isRecentlyRemoved(hostname)) continue;
      if (!rawMap.has(hostname)) {
        rawMap.set(hostname, {
          hostname,
          favIconUrl: sanitizeFavIconUrl(tab.favIconUrl),
          tabs: [],
          isSystemAbout: isSystemAboutTab(tab),
        });
      }
      const domain = rawMap.get(hostname);
      domain.tabs.push(createLightTab(tab));
      if (tab.favIconUrl) domain.favIconUrl = sanitizeFavIconUrl(tab.favIconUrl);
    }

    const mergedGroups = mergedGroupsPerWindow[windowId] || {};
    const domainOrder = domainOrderPerWindow[windowId] || [];
    const domainMap = buildWindowDomainMapOrdered(rawMap, mergedGroups, domainOrder, tabGroupMap, windowId);

    // Αναπλήρωση τυχόν missing domains (όπως πριν)
    const realHostnames = new Set(realTabs.map(t => getHostnameForTab(t)).filter(Boolean));
    for (const hostname of realHostnames) {
      let found = false;
      if (domainMap[hostname]) {
        found = true;
      } else {
        for (const [key, group] of Object.entries(domainMap)) {
          if (group.isMerged && group.hostGroups) {
            if (group.hostGroups.some(hg => hg.hostname === hostname)) {
              found = true;
              break;
            }
          }
        }
      }
      if (!found) {
        const tabsForHostname = realTabs.filter(t => getHostnameForTab(t) === hostname);
        domainMap[hostname] = {
          favIconUrl: sanitizeFavIconUrl(tabsForHostname[0]?.favIconUrl),
          tabs: tabsForHostname.map(t => createLightTab(t)),
          isMerged: false,
          isSystemAbout: isSystemAboutTab(tabsForHostname[0]),
        };
        console.log(`[DomainManager V26] Restored missing domain: ${hostname} (${tabsForHostname.length} tabs)`);
      }
    }

    const currentKeys = new Set(Object.keys(domainMap));
    if (cleanDomainOrder(windowId, currentKeys)) {
      saveDomainOrder().catch(() => {});
    }

    await resolveFaviconsInDomainMap(domainMap);

    if (!this._windowIndexMap.has(windowId)) {
      const allWindows = await browser.windows.getAll();
      const sortedIds = allWindows.filter(w => w.type !== 'devtools').map(w => w.id).sort((a,b)=>a-b);
      this._windowIndexMap.set(windowId, sortedIds.indexOf(windowId) + 1);
    }
    const idx = this._windowIndexMap.get(windowId) || 1;
    const title = browser.i18n.getMessage('windowTitle', idx.toString());

    let wg = currentState.windowGroups.find(w => w.windowId === windowId);
    if (wg) {
      wg.title = title;
      wg.domainMap = domainMap;
      wg.incognito = win.incognito;
    } else {
      currentState.windowGroups.push({ windowId, title, domainMap, incognito: win.incognito });
    }

    const allTabs = await browser.tabs.query({});
    currentState.windowGroups = await enrichWindowGroupsWithVisibility(currentState.windowGroups, allTabs);
    currentState.activeWindowId = await getActiveWindowId();
    console.log(`[DomainManager V26] updateWindowStateWithRealTabs done, domainMap keys:`, Object.keys(domainMap));
  },

  // Οι υπόλοιπες μέθοδοι (merge, unmerge, reorder, closeAllTabsInGroup, setDomainOrder, _setTabGroup, moveGroup, markHostnameAsRecentlyRemoved, clearRecentlyRemoved) παραμένουν ίδιες.
  // Δεν αλλάζουν γιατί δεν ασχολούνται με τα πεδία title/url των tabs.

  async mergeDomains(sourceHostname, targetHostname, windowId) {
    console.log('[DomainManager V26] mergeDomains:', { sourceHostname, targetHostname, windowId });
    // ... (κώδικας ίδιος με πριν, δεν επηρεάζεται)
    let mergedGroups = mergedGroupsPerWindow[windowId] || {};
    let sourceGroupId = null, targetGroupId = null;
    
    for (const [gid, g] of Object.entries(mergedGroups)) {
      if (g.domains.includes(sourceHostname)) sourceGroupId = gid;
      if (g.domains.includes(targetHostname)) targetGroupId = gid;
    }
    
    if (!targetGroupId && mergedGroups[targetHostname]) {
      targetGroupId = targetHostname;
    }
    
    if (sourceGroupId && sourceGroupId === targetGroupId) {
      console.log('[DomainManager V26] mergeDomains – already in same group, skipping');
      return;
    }

    let order = domainOrderPerWindow[windowId] || [];
    if (order.length === 0) {
      const allTabs = await browser.tabs.query({ windowId });
      const rawHosts = new Set();
      for (const tab of allTabs) {
        const h = getHostnameForTab(tab);
        if (h) rawHosts.add(h);
      }
      order = [...rawHosts];
    }

    let newGroupId = targetGroupId || crypto.randomUUID();
    let newGroupDomains = [];

    if (targetGroupId) {
      newGroupDomains = [...mergedGroups[targetGroupId].domains];
    } else {
      newGroupDomains = [targetHostname];
    }

    if (sourceGroupId) {
      const oldGroup = mergedGroups[sourceGroupId];
      oldGroup.domains = oldGroup.domains.filter(d => d !== sourceHostname);
      if (oldGroup.domains.length === 0) {
        delete mergedGroups[sourceGroupId];
        order = order.filter(h => h !== sourceGroupId);
      } else if (oldGroup.domains.length === 1) {
        const remaining = oldGroup.domains[0];
        delete mergedGroups[sourceGroupId];
        const idx = order.indexOf(sourceGroupId);
        if (idx !== -1) {
          order[idx] = remaining;
        } else {
          order.push(remaining);
        }
      }
    }

    if (!newGroupDomains.includes(sourceHostname)) {
      const targetIndex = newGroupDomains.indexOf(targetHostname);
      if (targetIndex >= 0) {
        newGroupDomains.splice(targetIndex + 1, 0, sourceHostname);
      } else {
        newGroupDomains.push(sourceHostname);
      }
    }

    mergedGroups[newGroupId] = { domains: newGroupDomains };
    if (targetGroupId && targetGroupId !== newGroupId) delete mergedGroups[targetGroupId];
    mergedGroupsPerWindow[windowId] = mergedGroups;

    const allTabs = await browser.tabs.query({ windowId });
    for (const tab of allTabs) {
      const h = getHostnameForTab(tab);
      if (h === sourceHostname || h === targetHostname || (targetGroupId && h === targetGroupId)) {
        tabGroupMap[tab.id] = newGroupId;
      }
    }

    let targetIndex = order.indexOf(targetGroupId || targetHostname);
    order = order.filter(h => h !== sourceHostname && h !== sourceGroupId && h !== targetGroupId && h !== targetHostname);
    if (targetIndex >= 0 && targetIndex <= order.length) {
      order.splice(targetIndex, 0, newGroupId);
    } else {
      order.push(newGroupId);
    }

    domainOrderPerWindow[windowId] = order;
    await saveDomainOrder();
    await saveMergedGroups();
    await saveTabGroupMap();
    console.log('[DomainManager V26] mergeDomains – success, new groupId:', newGroupId);
  },

  async unmergeDomain(hostname, windowId) {
    console.log('[DomainManager V26] unmergeDomain:', hostname);
    const mergedGroups = mergedGroupsPerWindow[windowId] || {};
    for (const [gid, group] of Object.entries(mergedGroups)) {
      if (group.domains.includes(hostname)) {
        group.domains = group.domains.filter(d => d !== hostname);

        const allTabs = await browser.tabs.query({ windowId });
        const affectedTabs = allTabs.filter(tab => getHostnameForTab(tab) === hostname && tabGroupMap[tab.id] === gid);
        for (const tab of affectedTabs) {
          delete tabGroupMap[tab.id];
        }

        let order = domainOrderPerWindow[windowId] || [];
        const groupIndex = order.indexOf(gid);

        if (group.domains.length === 0) {
          delete mergedGroups[gid];
          if (groupIndex !== -1) {
            order[groupIndex] = hostname;
          } else {
            order.push(hostname);
          }
        } else if (group.domains.length === 1) {
          const remaining = group.domains[0];
          delete mergedGroups[gid];
          if (groupIndex !== -1) {
            order[groupIndex] = remaining;
            order.splice(groupIndex + 1, 0, hostname);
          } else {
            order.push(remaining);
            order.push(hostname);
          }
        } else {
          order = order.filter(h => h !== hostname);
          if (groupIndex !== -1) {
            order.splice(groupIndex + 1, 0, hostname);
          } else {
            order.push(hostname);
          }
        }

        domainOrderPerWindow[windowId] = order;
        mergedGroupsPerWindow[windowId] = mergedGroups;
        await saveDomainOrder();
        await saveMergedGroups();
        await saveTabGroupMap();
        console.log('[DomainManager V26] unmergeDomain – success');
        break;
      }
    }
  },

  async reorderMergedGroup(groupId, sourceHostname, targetHostname, insertBefore, windowId) {
    console.log('[DomainManager V26] reorderMergedGroup:', groupId);
    const mergedGroups = mergedGroupsPerWindow[windowId] || {};
    const group = mergedGroups[groupId];
    if (group && group.domains.includes(sourceHostname) && group.domains.includes(targetHostname)) {
      group.domains = group.domains.filter(d => d !== sourceHostname);
      const targetIndex = group.domains.indexOf(targetHostname);
      const newIndex = insertBefore ? targetIndex : targetIndex + 1;
      group.domains.splice(newIndex, 0, sourceHostname);
      await saveMergedGroups();
      console.log('[DomainManager V26] reorderMergedGroup – success');
    }
  },

  async closeAllTabsInGroup(groupId, windowId) {
    console.log('[DomainManager V26] closeAllTabsInGroup:', groupId);
    const mergedGroups = mergedGroupsPerWindow[windowId] || {};
    if (mergedGroups[groupId]) {
      const domains = mergedGroups[groupId].domains;
      const allTabs = await browser.tabs.query({ windowId });
      const tabsToClose = allTabs.filter(tab => {
        if (tabGroupMap[tab.id] !== groupId) return false;
        const hostname = getHostnameForTab(tab);
        return hostname && domains.includes(hostname);
      });
      
      console.log(`[DomainManager V26] closeAllTabsInGroup – closing ${tabsToClose.length} tabs that belong to group ${groupId}`);
      
      for (const tab of tabsToClose) {
        try { await browser.tabs.remove(tab.id); } catch (e) {
          console.warn('[DomainManager V26] closeAllTabsInGroup – failed to close tab', tab.id, e.message);
        }
      }
      
      delete mergedGroups[groupId];
      if (domainOrderPerWindow[windowId]) {
        domainOrderPerWindow[windowId] = domainOrderPerWindow[windowId].filter(h => h !== groupId);
      }
      for (const tab of tabsToClose) {
        delete tabGroupMap[tab.id];
      }
      await saveMergedGroups();
      await saveDomainOrder();
      await saveTabGroupMap();
      console.log('[DomainManager V26] closeAllTabsInGroup – group deleted permanently');
    }
  },

  setDomainOrder(windowId, order) {
    domainOrderPerWindow[windowId] = order;
    saveDomainOrder().catch(() => {});
    console.log('[DomainManager V26] setDomainOrder for window', windowId, order);
  },

  _getMergedGroups(windowId) {
    return mergedGroupsPerWindow[windowId] || null;
  },

  _setTabGroup(tabId, groupId) {
    tabGroupMap[tabId] = groupId;
    saveTabGroupMap().catch(() => {});
    console.log(`[DomainManager V26] _setTabGroup: tab ${tabId} -> group ${groupId}`);
  },

  async moveGroup(groupId, targetWindowId, originalWindowId) {
    console.log('[DomainManager V26] moveGroup:', { groupId, targetWindowId, originalWindowId });
    const sourceGroups = mergedGroupsPerWindow[originalWindowId] || {};
    const group = sourceGroups[groupId];
    if (!group) throw new Error('Source group not found');

    const domains = group.domains;
    const allTabs = await browser.tabs.query({ windowId: originalWindowId });
    const tabsToMove = allTabs.filter(t => {
      const host = getHostnameForTab(t);
      return host && domains.includes(host) && tabGroupMap[t.id] === groupId;
    });

    for (const tab of tabsToMove) {
      await browser.tabs.move(tab.id, { windowId: targetWindowId, index: -1 });
    }

    const updatedDomains = domains.map(domain => {
      if (domain.startsWith('about:home::window-') || domain.startsWith('about:privatebrowsing::window-')) {
        const prefix = domain.startsWith('about:home::') ? 'about:home::' : 'about:privatebrowsing::';
        return prefix + 'window-' + targetWindowId;
      }
      return domain;
    });
    const uniqueDomains = [...new Set(updatedDomains)];
    group.domains = uniqueDomains;

    for (const tab of tabsToMove) {
      tabGroupMap[tab.id] = groupId;
    }

    if (!mergedGroupsPerWindow[targetWindowId]) mergedGroupsPerWindow[targetWindowId] = {};
    mergedGroupsPerWindow[targetWindowId][groupId] = group;
    delete mergedGroupsPerWindow[originalWindowId][groupId];

    if (domainOrderPerWindow[originalWindowId]) {
      domainOrderPerWindow[originalWindowId] = domainOrderPerWindow[originalWindowId].filter(h => h !== groupId);
    }
    if (!domainOrderPerWindow[targetWindowId]) domainOrderPerWindow[targetWindowId] = [];
    domainOrderPerWindow[targetWindowId] = domainOrderPerWindow[targetWindowId].filter(h => h !== groupId);
    domainOrderPerWindow[targetWindowId].push(groupId);

    await saveMergedGroups();
    await saveDomainOrder();
    await saveTabGroupMap();
    console.log('[DomainManager V26] moveGroup – success, tabs moved:', tabsToMove.length);
  },

  markHostnameAsRecentlyRemoved(hostname) {
    _markHostnameAsRecentlyRemoved(hostname);
  },

  clearRecentlyRemoved(hostname) {
    if (_recentlyRemovedHostnames.has(hostname)) {
      clearTimeout(_recentlyRemovedHostnames.get(hostname));
      _recentlyRemovedHostnames.delete(hostname);
      console.log(`[DomainManager V26] Cleared recently-removed for ${hostname}`);
    }
  },
};

// ================= buildWindowDomainMapOrdered (V26) =================
function buildWindowDomainMapOrdered(rawMap, mergedGroups, domainOrder, tabGroupMap, windowId) {
  const result = {};
  const remainingMap = new Map();
  
  for (const [hostname, domain] of rawMap.entries()) {
    if (_isRecentlyRemoved(hostname)) continue;
    // V26: τα tabs είναι ήδη ελαφριά (id, active, visible) – απλώς αντιγράφουμε
    remainingMap.set(hostname, { ...domain, tabs: [...domain.tabs] });
  }

  const mergedEntries = [];

  for (const [groupId, group] of Object.entries(mergedGroups)) {
    const hostGroupsData = [];
    let allGroupTabs = [];

    for (const hostname of group.domains) {
      if (!remainingMap.has(hostname)) continue;

      const allTabs = remainingMap.get(hostname).tabs;
      let groupTabs = allTabs.filter(tab => tabGroupMap[tab.id] === groupId);

      if (groupTabs.length === 0 && allTabs.length > 0) {
        groupTabs = [...allTabs];
      }

      if (groupTabs.length === 0) continue;

      const otherTabs = allTabs.filter(tab => !groupTabs.includes(tab));
      if (otherTabs.length > 0) {
        remainingMap.get(hostname).tabs = otherTabs;
      } else {
        remainingMap.delete(hostname);
      }

      hostGroupsData.push({
        hostname,
        tabs: groupTabs,
        favIconUrl: rawMap.get(hostname)?.favIconUrl,
        isSystemAbout: rawMap.get(hostname)?.isSystemAbout || false,
      });
      allGroupTabs.push(...groupTabs);
    }

    if (hostGroupsData.length >= 2) {
      const orderIndex = domainOrder.indexOf(groupId) >= 0 ? domainOrder.indexOf(groupId) : Infinity;
      mergedEntries.push({
        key: groupId,
        group: {
          favIconUrl: hostGroupsData[0]?.favIconUrl || null,
          tabs: allGroupTabs,
          hostGroups: hostGroupsData,
          isMerged: true,
          isSystemAbout: false,
        },
        orderIndex,
      });
    } else if (hostGroupsData.length === 1) {
      const single = hostGroupsData[0];
      console.log(`[DomainManager V26] Group ${groupId} has only 1 hostname (${single.hostname}), returning to simple domain`);
      if (!remainingMap.has(single.hostname)) {
        remainingMap.set(single.hostname, {
          hostname: single.hostname,
          favIconUrl: single.favIconUrl,
          tabs: single.tabs,
          isSystemAbout: single.isSystemAbout,
        });
      } else {
        const existing = remainingMap.get(single.hostname);
        for (const tab of single.tabs) {
          if (!existing.tabs.some(t => t.id === tab.id)) {
            existing.tabs.push(tab);
          }
        }
      }
    }
  }

  const simpleEntries = [];
  for (const [hostname, domain] of remainingMap.entries()) {
    if (domain.tabs.length > 0) {
      simpleEntries.push({
        key: hostname,
        group: { ...domain, isMerged: false },
        orderIndex: domainOrder.indexOf(hostname) >= 0 ? domainOrder.indexOf(hostname) : Infinity,
      });
    }
  }

  const allEntries = [...mergedEntries, ...simpleEntries].sort((a, b) => a.orderIndex - b.orderIndex);
  for (const entry of allEntries) result[entry.key] = entry.group;

  // V26: Προσθήκη about:home/private ΜΟΝΟ αν έχουν tabs εκτός group ή το παράθυρο είναι κενό
  for (const [hostname, domain] of rawMap.entries()) {
    if (isStableAboutKey(hostname) && !result[hostname]) {
      const tabsNotInGroup = (domain.tabs || []).filter(tab => !tabGroupMap[tab.id]);
      if (tabsNotInGroup.length > 0 || Object.keys(result).length === 0) {
        result[hostname] = {
          hostname,
          favIconUrl: domain.favIconUrl,
          tabs: tabsNotInGroup,
          isMerged: false,
          isSystemAbout: false,
        };
      }
    }
  }

  return result;
}

async function enrichWindowGroupsWithVisibility(windowGroups, allTabs) {
  const tabHiddenMap = new Map();
  for (const t of allTabs) tabHiddenMap.set(t.id, t.hidden);
  for (const wg of windowGroups) {
    for (const [key, group] of Object.entries(wg.domainMap)) {
      const enrich = (tabs) => tabs.map(tab => ({
        ...tab, visible: !(tabHiddenMap.get(tab.id) ?? false)
      }));
      if (group.isMerged && group.hostGroups) {
        for (const hg of group.hostGroups) hg.tabs = enrich(hg.tabs);
        group.tabs = enrich(group.tabs);
      } else {
        group.tabs = enrich(group.tabs);
      }
    }
  }
  return windowGroups;
}

self.DomainManager = DomainManager;
self._markHostnameAsRecentlyRemoved = _markHostnameAsRecentlyRemoved;
console.log('[DomainManager V26] Module loaded – light tabs, favicons preserved via lastKnownFaviconMap');