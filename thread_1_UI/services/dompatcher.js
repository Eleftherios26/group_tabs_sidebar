// ============================================================
// DOMPatcher – V26.01 – Διόρθωση ενημέρωσης badges σε trees
// Εξασφαλίζει ότι τα badges (γονικού και παιδιών) ενημερώνονται σωστά
// κατά το merge/unmerge ή οποιαδήποτε αλλαγή στη σύνθεση του δέντρου.
// ============================================================
'use strict';
console.log('[DOMPatcher V26.01] Module loaded – light state, dynamic popup data, badge fix for trees');

const DOMPatcher = (() => {
  const WINDOW_COLORS = [
    'rgba(255, 99, 71, 0.55)', 'rgba(255, 140, 0, 0.55)', 'rgba(255, 215, 0, 0.55)',
    'rgba(50, 205, 50, 0.55)', 'rgba(0, 191, 255, 0.55)', 'rgba(65, 105, 225, 0.55)',
    'rgba(138, 43, 226, 0.55)', 'rgba(218, 112, 214, 0.55)', 'rgba(255, 105, 180, 0.55)',
    'rgba(0, 206, 209, 0.55)', 'rgba(127, 255, 0, 0.55)', 'rgba(255, 69, 0, 0.55)',
  ];

  const DEFAULT_FAVICON = window.DEFAULT_FAVICON || browser.runtime.getURL('icons/globe.gif');

  const perWindowSnapshots = new Map();
  let lastAppliedRevision = -1;

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object' || a === null || b === null) return false;
    const keysA = Object.keys(a), keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => deepEqual(a[k], b[k]));
  }
  function arraysEqual(arr1, arr2) {
    if (!arr1 && !arr2) return true;
    if (!arr1 || !arr2) return false;
    if (arr1.length !== arr2.length) return false;
    return arr1.every((val, idx) => deepEqual(val, arr2[idx]));
  }
  function tabListsEqual(tabs1, tabs2) {
    if (!tabs1 && !tabs2) return true;
    if (!tabs1 || !tabs2) return false;
    if (tabs1.length !== tabs2.length) return false;
    const ids1 = tabs1.map(t => t.id).sort((a,b)=>a-b);
    const ids2 = tabs2.map(t => t.id).sort((a,b)=>a-b);
    if (!arraysEqual(ids1, ids2)) return false;
    const active1 = tabs1.find(t => t.active);
    const active2 = tabs2.find(t => t.active);
    if ((active1?.id ?? null) !== (active2?.id ?? null)) return false;
    // V26: Σύγκριση μόνο id/active/visible – όχι title/url
    for (const id of ids1) {
      const tab1 = tabs1.find(t => t.id === id);
      const tab2 = tabs2.find(t => t.id === id);
      const vis1 = tab1?.visible !== undefined ? tab1.visible : (tab1?.hidden !== undefined ? !tab1.hidden : undefined);
      const vis2 = tab2?.visible !== undefined ? tab2.visible : (tab2?.hidden !== undefined ? !tab2.hidden : undefined);
      if (vis1 !== vis2) return false;
    }
    return true;
  }
  function domainGroupsEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.isMerged !== b.isMerged) return false;
    if (a.isMerged && b.isMerged) {
      const hostsA = a.hostGroups ? a.hostGroups.map(hg => hg.hostname) : [];
      const hostsB = b.hostGroups ? b.hostGroups.map(hg => hg.hostname) : [];
      if (!arraysEqual(hostsA, hostsB)) return false;
    }
    return tabListsEqual(a.tabs, b.tabs) && a.favIconUrl === b.favIconUrl && a.isSystemAbout === b.isSystemAbout;
  }

  function safeRemove(element, force = false) {
    if (!element) return;
    if (force) {
      element.style.transition = 'none';
      element.style.opacity = '';
      element.style.transform = '';
      if (element.parentNode) element.remove();
      return;
    }
    element.remove();
  }
  
  function updateBadgeIfChanged(item, group) {
    const badge = item.querySelector('.badge');
    if (!badge) return;
    const realCount = group.tabs.length;
    const currentText = parseInt(badge.textContent, 10);
    if (currentText !== realCount) {
      badge.textContent = realCount;
      console.log(`[DOMPatcher V26.01] Badge updated: ${item.dataset.hostname || item.dataset.firstHostname} → ${realCount}`);
      const hostname = item.dataset.firstHostname || item.dataset.hostname;
      if (hostname) window.DomainBadge?.clearPending(hostname);
    }
    item.dataset.count = realCount;
  }

  async function preloadAndApplyFavicon(img, newFavicon) {
    if (!img || img.src === newFavicon) return;
    try {
      const preload = new Image();
      preload.src = newFavicon;
      await preload.decode();
      img.src = newFavicon;
    } catch (e) { img.src = newFavicon; }
  }

  async function patchDomainItem(item, group, isActiveWindow) {
    const hasActive = group.tabs.some(t => t.active) && isActiveWindow;
    item.classList.toggle('active-domain', hasActive);
    item.classList.toggle('single-tab', group.tabs.length === 1);

    const img = item.querySelector('.domain-favicon');
    if (img) {
      const displayHostname = item.dataset.firstHostname || item.dataset.hostname;
      const isIncognito = item.closest('.incognito-window') !== null;
      const newFavicon = window.getFaviconURL(group, displayHostname, isIncognito);
      if (img.src !== newFavicon) {
        await preloadAndApplyFavicon(img, newFavicon);
        item.dataset.favicon = newFavicon;
        item.dataset.faviconLoaded = (newFavicon !== DEFAULT_FAVICON) ? 'true' : 'false';
        if (newFavicon === DEFAULT_FAVICON) img.dataset.pending = 'true'; else img.dataset.pending = 'false';
        const popup = item.querySelector('.domain-popup');
        if (popup && !popup.classList.contains('single-hidden')) {
          popup.querySelectorAll('.card-favicon').forEach(cardImg => { cardImg.src = newFavicon; cardImg.dataset.pending = img.dataset.pending; });
        }
      }
    }
    if (typeof window.storeOriginalFaviconUrl === 'function') window.storeOriginalFaviconUrl(item, group);

    const newTabIds = group.tabs.map(t => t.id);
    const currentTabIds = JSON.stringify(newTabIds);
    if (item.dataset.tabIds !== currentTabIds) {
      item.dataset.tabIds = currentTabIds;
      const oldPopup = item.querySelector('.domain-popup');
      const wasOpen = item.classList.contains('show-popup');
      if (oldPopup) {
        const newPopup = window.buildPopupElement(group);
        oldPopup.replaceWith(newPopup);
        if (wasOpen && typeof openPopup === 'function') {
          setTimeout(() => {
            if (typeof syncPopupFavicons === 'function') syncPopupFavicons(item, newPopup);
            openPopup(item);
            if (typeof window.fetchAndFillPopupTabs === 'function') {
              window.fetchAndFillPopupTabs(item, newPopup, group);
            }
          }, 10);
        }
      }
    } else {
      const popup = item.querySelector('.domain-popup');
      if (popup && !popup.classList.contains('single-hidden')) {
        const activeTabId = group.tabs.find(t => t.active)?.id;
        popup.querySelectorAll('.popup-tab-card').forEach(card => {
          const cardTabId = parseInt(card.dataset.tabId, 10);
          const tabData = group.tabs.find(t => t.id === cardTabId);
          const visBtn = card.querySelector('.visibility-btn');
          if (visBtn && tabData) {
            visBtn.disabled = (cardTabId === activeTabId);
            visBtn.textContent = tabData.visible ? '👁🟢' : '👁🔴';
            visBtn.title = visBtn.disabled
              ? (browser.i18n.getMessage('cannotHideActive') || 'Cannot hide active tab')
              : (tabData.visible
                  ? (browser.i18n.getMessage('hideTab') || 'Hide tab')
                  : (browser.i18n.getMessage('showTab') || 'Show tab'));
          }
          card.classList.toggle('active-tab', cardTabId === activeTabId);
        });
      }
    }

    const sysBadge = item.querySelector('.domain-tab-system-badge');
    if (group.isSystemAbout) {
      if (!sysBadge) {
        const newBadge = document.createElement('span');
        newBadge.className = 'domain-tab-system-badge';
        newBadge.textContent = browser.i18n.getMessage('tabSystem') || 'tab system';
        item.appendChild(newBadge);
      }
    } else { if (sysBadge) sysBadge.remove(); }

    item.dataset.count = group.tabs.length;

    if (typeof window.applyColorsToDomainItem === 'function') {
      await window.applyColorsToDomainItem(item);
    }
  }

  async function patchState(state, signal, getActiveWindowId) {
    console.log('[DOMPatcher V26.01] patchState – revision:', state.stateRevision);
    if (state.stateRevision <= lastAppliedRevision) {
      console.log('[DOMPatcher V26.01] Revision already applied or older, skipping');
      return;
    }
    lastAppliedRevision = state.stateRevision;
    document.querySelectorAll('.window-group').forEach(g => g.classList.add('no-transition'));

    try {
      const activeWindowId = state.activeWindowId;
      const domainList = document.getElementById('domain-list');
      if (!domainList) { console.warn('[DOMPatcher V26.01] No domain-list element'); return; }
      if (typeof StateObserver !== 'undefined' && StateObserver._setActiveWindowId) StateObserver._setActiveWindowId(activeWindowId);

      const incognitoWatermark = document.getElementById('incognito-watermark');
      const normalIndicator = document.getElementById('normal-window-indicator');
      if (incognitoWatermark && normalIndicator) {
        if (activeWindowId && state.windowGroups) {
          const currentWin = state.windowGroups.find(wg => wg.windowId === activeWindowId);
          incognitoWatermark.style.display = (currentWin && currentWin.incognito) ? 'block' : 'none';
          normalIndicator.style.display = (currentWin && !currentWin.incognito) ? 'block' : 'none';
        }
      }

      const desiredWindowIds = new Set(state.windowGroups ? state.windowGroups.map(wg => wg.windowId) : []);
      
      document.querySelectorAll('.window-group').forEach(group => {
        const winId = parseInt(group.dataset.windowId, 10);
        if (!desiredWindowIds.has(winId)) {
          console.log('[DOMPatcher V26.01] Removing stale window-group:', winId);
          safeRemove(group, true);
          perWindowSnapshots.delete(winId);
        }
      });
      
      document.querySelectorAll('.tree-children-wrapper').forEach(w => {
        const prev = w.previousElementSibling;
        if (!prev || !prev.classList.contains('tree-parent')) safeRemove(w, true);
      });

      if (!state.windowGroups || state.windowGroups.length === 0) {
        domainList.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'no-tabs-message'; msg.style.padding = '16px'; msg.style.color = '#888';
        msg.textContent = browser.i18n.getMessage('noTabs') || 'No open tabs';
        domainList.appendChild(msg);
        perWindowSnapshots.clear();
        return;
      }

      const noTabsMsg = domainList.querySelector('.no-tabs-message');
      if (noTabsMsg) noTabsMsg.remove();

      if (state.windowGroups.length === 1) {
        const wg = state.windowGroups[0];
        const isActive = wg.windowId === activeWindowId;
        let inner = domainList.querySelector('.domain-list-inner');
        if (!inner) {
          domainList.innerHTML = '';
          inner = document.createElement('div');
          inner.className = 'domain-list-inner';
          inner.style.display = 'flex'; inner.style.flexDirection = 'column';
          inner.style.gap = '20px'; inner.style.padding = '12px 10px'; inner.style.paddingTop = '50px';
          domainList.appendChild(inner);
        }
        await syncDomainsForWindow(inner, wg, isActive, signal);
      } else {
        const inner = domainList.querySelector('.domain-list-inner');
        if (inner) inner.remove();
        await syncWindowGroups(domainList, state.windowGroups, signal, activeWindowId);
      }

      console.log('[DOMPatcher V26.01] patchState complete');
    } finally {
      document.querySelectorAll('.window-group.no-transition').forEach(g => g.classList.remove('no-transition'));
    }
  }

  async function syncWindowGroups(container, windowGroups, signal, activeWindowId) {
    const existingMap = new Map();
    container.querySelectorAll(':scope > .window-group').forEach(group => {
      const winId = parseInt(group.dataset.windowId, 10);
      if (!isNaN(winId)) existingMap.set(winId, group);
    });
    const desiredOrder = windowGroups.map(wg => wg.windowId);
    let previousSibling = null;

    for (const [idx, wg] of windowGroups.entries()) {
      if (signal.aborted) return;
      const color = WINDOW_COLORS[idx % WINDOW_COLORS.length];
      const isActive = wg.windowId === activeWindowId;
      const wd = { title: wg.title, color, windowId: wg.windowId, incognito: wg.incognito };
      let winEl = existingMap.get(wg.windowId);
      if (winEl) {
        updateWindowGroupElement(winEl, wd, isActive);
      } else {
        winEl = window.createWindowGroupElement(wd, isActive);
        console.log('[DOMPatcher V26.01] Created new window-group:', wg.windowId);
      }
      if (previousSibling && previousSibling.nextSibling !== winEl) container.insertBefore(winEl, previousSibling.nextSibling);
      else if (!previousSibling && container.firstChild !== winEl) container.insertBefore(winEl, container.firstChild);
      previousSibling = winEl;

      const domainsContainer = winEl.querySelector('.window-domains');
      if (domainsContainer) {
        await syncDomainsForWindow(domainsContainer, wg, isActive, signal);
      }
    }
    
    for (const [winId, el] of existingMap.entries()) {
      if (!desiredOrder.includes(winId)) {
        safeRemove(el, true);
        perWindowSnapshots.delete(winId);
      }
    }
  }

  async function syncDomainsForWindow(container, wg, isActiveWindow, signal) {
    const windowId = wg.windowId;
    const newDomainMap = wg.domainMap || {};
    const isIncognitoWindow = wg.incognito;
    
    const prevSnapshot = perWindowSnapshots.get(windowId);
    const previousGlobalKeys = new Set(prevSnapshot ? Object.keys(prevSnapshot.domainMap || {}) : []);
    
    perWindowSnapshots.set(windowId, {
      domainMap: JSON.parse(JSON.stringify(newDomainMap)),
      windowMeta: { title: wg.title, incognito: wg.incognito, windowId }
    });

    const existingNodes = new Map();
    container.querySelectorAll(':scope > .tree-parent').forEach(parent => {
      const key = parent.dataset.hostname || parent.dataset.nodeId;
      if (!key || parent.dataset.fadingOut === 'true') return;
      const wrapper = parent.nextElementSibling;
      if (wrapper && wrapper.classList.contains('tree-children-wrapper')) existingNodes.set(key, { type: 'tree', parent, wrapper });
      else existingNodes.set(key, { type: 'simple', parent });
    });
    container.querySelectorAll(':scope > .domain-item:not(.tree-parent)').forEach(item => {
      const key = item.dataset.hostname || item.dataset.nodeId;
      if (key && item.dataset.fadingOut !== 'true' && !existingNodes.has(key)) existingNodes.set(key, { type: 'simple', parent: item });
    });

    for (const [key, entry] of existingNodes.entries()) {
      if (entry.parent.parentNode !== container) {
        existingNodes.delete(key);
      }
    }

    const desiredKeys = Object.keys(newDomainMap);
    const newKeys = desiredKeys.filter(k => !previousGlobalKeys.has(k));
    console.log(`[DOMPatcher V26.01] Window ${windowId} – New domains:`, newKeys);

    // 1. Αφαίρεση παλιών
    const toRemove = [];
    for (const [key, entry] of existingNodes.entries()) {
      if (!desiredKeys.includes(key) && entry.parent.dataset.fadingOut !== 'true') {
        toRemove.push({ key, entry });
      }
    }

    if (toRemove.length > 0) {
      console.log(`[DOMPatcher V26.01] Fading out ${toRemove.length} domains in window ${windowId}`);
      await Promise.all(toRemove.map(({ entry }) => {
        if (entry.type === 'simple') {
          return AnimationQueue.fadeOut(entry.parent);
        } else {
          safeRemove(entry.parent, true);
          if (entry.wrapper) safeRemove(entry.wrapper, true);
          return Promise.resolve();
        }
      }));
    }

    // 2. Προετοιμασία νέων (απλών & trees)
    const preparePromises = [];

    for (const key of desiredKeys) {
      if (signal.aborted) return;
      const group = newDomainMap[key];
      if (!group || group.tabs.length === 0) continue;

      const isMerged = !!(group.isMerged && group.hostGroups && group.hostGroups.length > 1);
      const existing = existingNodes.get(key);

      if (existing && existing.parent.dataset.fadingOut !== 'true') {
        if (isMerged) {
          if (existing.type === 'tree' && existing.wrapper) {
            console.log(`[DOMPatcher V26.01] Updating existing tree: ${key}`);
            updateTreeParentElement(existing.parent, key, group, isActiveWindow);
            await syncSubDomainItems(existing.wrapper, group.hostGroups, isActiveWindow, isIncognitoWindow, signal);
          } else {
            if (existing) {
              console.log(`[DOMPatcher V26.01] Replacing domain with tree: ${key}`);
              safeRemove(existing.parent, true);
              if (existing.wrapper) safeRemove(existing.wrapper, true);
            }
            console.log(`[DOMPatcher V26.01] Creating new tree: ${key}`);
            const { parent, wrapper } = window.createTreeElement(key, group, isActiveWindow, isIncognitoWindow);
            existingNodes.set(key, { type: 'tree', parent, wrapper });
          }
        } else {
          if (existing.type === 'simple') {
            const prevGroup = prevSnapshot?.domainMap?.[key];
            if (!prevGroup || !domainGroupsEqual(prevGroup, group) || 
                existing.parent.dataset.colorsApplied !== 'true') {
              console.log(`[DOMPatcher V26.01] Updating existing domain: ${key}`);
              await patchDomainItem(existing.parent, group, isActiveWindow);
            } else {
              console.log(`[DOMPatcher V26.01] Skipping unchanged domain: ${key}`);
            }
            updateBadgeIfChanged(existing.parent, group);
          } else {
            safeRemove(existing.parent, true);
            if (existing.wrapper) safeRemove(existing.wrapper, true);
            existingNodes.delete(key);
          }
        }
      } else {
        if (isMerged) {
          preparePromises.push(
            (async () => {
              const { parent, wrapper } = window.createTreeElement(key, group, isActiveWindow, isIncognitoWindow);
              return { key, type: 'tree', parent, wrapper };
            })()
          );
        } else {
          preparePromises.push(
            (async () => {
              try {
                const item = await window.BSF.prepareDomainItem(key, group, isActiveWindow, isIncognitoWindow, signal);
                return { key, type: 'simple', parent: item };
              } catch (e) {
                if (e.name === 'AbortError') throw e;
                console.warn(`[DOMPatcher V26.01] ${key}: BSF prep failed, fallback`, e);
                const item = window.buildDomainItem(key, group, isActiveWindow, false, isIncognitoWindow);
                return { key, type: 'simple', parent: item };
              }
            })()
          );
        }
      }
    }

    const preparedItems = await Promise.all(preparePromises);

    // 3. Μαζική εισαγωγή & fade‑in
    if (preparedItems.length > 0) {
      const fragment = document.createDocumentFragment();
      const fadeInElements = [];

      for (const item of preparedItems) {
        if (item.type === 'tree') {
          fragment.appendChild(item.parent);
          fragment.appendChild(item.wrapper);
          existingNodes.set(item.key, { type: 'tree', parent: item.parent, wrapper: item.wrapper });
        } else {
          const domainItem = item.parent;
          if (window._initialRender) {
            domainItem.style.opacity = '1';
            fragment.appendChild(domainItem);
            existingNodes.set(item.key, { type: 'simple', parent: domainItem });
          } else {
            domainItem.style.opacity = '0';
            domainItem.classList.add('fade-in-item');
            fragment.appendChild(domainItem);
            existingNodes.set(item.key, { type: 'simple', parent: domainItem });
            fadeInElements.push({ key: item.key, element: domainItem });
          }
        }
      }

      container.appendChild(fragment);
      container.offsetHeight;

      if (!window._initialRender) {
        for (const { element } of fadeInElements) {
          AnimationQueue.fadeIn(element, 250).then(() => {
            element.classList.remove('fade-in-item');
          });
        }
      }
    }

    // 4. Αναδιάταξη
    let previousSibling = null;
    for (const key of desiredKeys) {
      const entry = existingNodes.get(key);
      if (!entry || !entry.parent || entry.parent.dataset.fadingOut === 'true') continue;
      const nodesToInsert = entry.type === 'tree' ? [entry.parent, entry.wrapper] : [entry.parent];
      for (const node of nodesToInsert) {
        if (previousSibling && previousSibling.nextSibling !== node) {
          container.insertBefore(node, previousSibling.nextSibling);
        } else if (!previousSibling && container.firstChild !== node) {
          container.insertBefore(node, container.firstChild);
        }
        previousSibling = node;
      }
    }

    container.querySelectorAll(':scope > .tree-children-wrapper').forEach(w => {
      const prev = w.previousElementSibling;
      if (!prev || !prev.classList.contains('tree-parent')) safeRemove(w, true);
    });
  }

  async function syncSubDomainItems(wrapper, hostGroups, isActiveWindow, isIncognitoWindow, signal) {
    const existingMap = new Map();
    wrapper.querySelectorAll(':scope > .domain-item.sub-domain-item').forEach(item => {
      const host = item.dataset.hostname;
      if (host) existingMap.set(host, item);
    });
    const desiredHosts = hostGroups.map(hg => hg.hostname);
    let previousSibling = null;
    for (const hg of hostGroups) {
      if (signal.aborted) return;
      let item = existingMap.get(hg.hostname);
      if (item) {
        await patchDomainItem(item, hg, isActiveWindow);
        updateBadgeIfChanged(item, hg);
        delete item.dataset.colorsApplied;
      } else {
        item = window.buildDomainItem(hg.hostname, hg, isActiveWindow, true, isIncognitoWindow);
        delete item.dataset.colorsApplied;
        // V26.01: Ενημέρωση badge ακόμα και για νέο υπο-στοιχείο
        updateBadgeIfChanged(item, hg);
        if (typeof window.applyColorsToDomainItem === 'function') await window.applyColorsToDomainItem(item);
      }
      if (previousSibling && previousSibling.nextSibling !== item) wrapper.insertBefore(item, previousSibling.nextSibling);
      else if (!previousSibling && wrapper.firstChild !== item) wrapper.insertBefore(item, wrapper.firstChild);
      previousSibling = item;
    }
    for (const host of existingMap.keys()) {
      if (!desiredHosts.includes(host)) {
        const el = existingMap.get(host);
        if (el) AnimationQueue.fadeOut(el);
      }
    }

    // V26.01: Ενημέρωση badge γονικού δέντρου μετά από τυχόν αλλαγές
    const treeParent = wrapper.previousElementSibling;
    if (treeParent && treeParent.classList.contains('tree-parent')) {
      const allTabs = hostGroups.flatMap(hg => hg.tabs);
      updateBadgeIfChanged(treeParent, { tabs: allTabs });
    }
  }

  function updateWindowGroupElement(container, wd, isActiveWindow) {
    container.classList.toggle('incognito-window', !!wd.incognito);
    container.classList.toggle('active-window', isActiveWindow);
    container.style.setProperty('--window-bg', wd.color);
    container.style.backgroundColor = wd.color;
    container.dataset.nodeId = `window-${wd.windowId}`;

    const titleBar = container.querySelector('.window-title');
    if (!titleBar) return;
    titleBar.querySelectorAll('.active-group-tick, .window-status-icon').forEach(el => el.remove());

    let titleTextNode = null;
    for (const child of titleBar.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { titleTextNode = child; break; }
    }
    if (titleTextNode) titleTextNode.textContent = wd.title;
    else titleBar.insertBefore(document.createTextNode(wd.title), titleBar.firstChild);

    if (isActiveWindow) {
      const tick = document.createElement('span');
      tick.className = 'active-group-tick'; tick.textContent = '✓';
      titleBar.appendChild(tick);
    }
    const statusIcon = document.createElement('img');
    statusIcon.className = 'window-status-icon';
    statusIcon.src = wd.incognito ? 'icons/private-mask.ico' : 'icons/about-home.ico';
    statusIcon.alt = wd.incognito ? 'Private' : 'Normal';
    statusIcon.title = wd.incognito ? 'Ιδιωτικό παράθυρο' : 'Κανονικό παράθυρο';
    titleBar.appendChild(statusIcon);
  }

  function updateTreeParentElement(parentEl, key, group, isActiveWindow) {
    const hasActive = group.tabs.some(t => t.active) && isActiveWindow;
    parentEl.classList.toggle('active-domain', hasActive);
    parentEl.dataset.hostname = key;
    parentEl.dataset.nodeId = key;
    parentEl.dataset.groupId = key;
    parentEl.dataset.subHostnames = JSON.stringify(group.hostGroups.map(hg => hg.hostname));
    if (group.hostGroups && group.hostGroups.length > 0) parentEl.dataset.firstHostname = group.hostGroups[0].hostname;
    const img = parentEl.querySelector('.domain-favicon');
    if (img) {
      let newFavicon = null;
      const isIncognito = parentEl.closest('.incognito-window') !== null;
      if (group.hostGroups && group.hostGroups.length > 0) {
        const firstChild = group.hostGroups[0];
        newFavicon = window.getFaviconURL(firstChild, firstChild.hostname, isIncognito);
      }
      if (!newFavicon) newFavicon = window.getFaviconURL(group, key, isIncognito);
      if (img.src !== newFavicon) { img.src = newFavicon; parentEl.dataset.favicon = newFavicon; }
    }
    parentEl.dataset.count = group.tabs.length;
  }

  return {
    patchState,
    patchDomainItem,
    safeRemove,
    _perWindowSnapshots: () => perWindowSnapshots,
  };
})();

window.DOMPatcher = DOMPatcher;
window.patchDomainItem = DOMPatcher.patchDomainItem;