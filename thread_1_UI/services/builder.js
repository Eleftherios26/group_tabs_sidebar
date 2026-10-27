// Builder Service V26 – Δυναμική φόρτωση τίτλων/URL για popup, ελαφρύ state
console.log('[Builder V26] Module loaded – dynamic popup data, light tabs');

const DEFAULT_FAVICON = browser.runtime.getURL('icons/globe.gif');

const ABOUT_ICONS = {
  'about:addons': browser.runtime.getURL('icons/about-addons.ico'),
  'about:debugging': browser.runtime.getURL('icons/about-debugging.ico'),
  'about:home': browser.runtime.getURL('icons/about-home.ico'),
  'about:privatebrowsing': browser.runtime.getURL('icons/about-private.ico'),
  default: browser.runtime.getURL('icons/about-default.ico'),
};

// Cache για πλήρη tabs ανά domain/window (για γρήγορα hover)
const popupTabsCache = new Map();
const CACHE_TTL_MS = 8000; // 8 δευτερόλεπτα

function getOriginalAboutHostname(hostname) {
  if (!hostname) return hostname;
  if (hostname.startsWith('about:home::')) return 'about:home';
  if (hostname.startsWith('about:privatebrowsing::')) return 'about:privatebrowsing';
  return hostname;
}

function getAboutIcon(hostname, tabs) {
  const originalHostname = getOriginalAboutHostname(hostname);
  if (originalHostname === 'about:home') {
    const allPrivate = tabs.every(t => t.url && t.url.startsWith('about:privatebrowsing'));
    return allPrivate ? ABOUT_ICONS['about:privatebrowsing'] : ABOUT_ICONS['about:home'];
  }
  return ABOUT_ICONS[originalHostname] || ABOUT_ICONS.default;
}

function getFaviconURL(group, hostname, isIncognito = false) {
  const effectiveHostname = getOriginalAboutHostname(hostname) || hostname;
  
  if (effectiveHostname && effectiveHostname.startsWith('about:')) {
    if (isIncognito && (effectiveHostname === 'about:home' || effectiveHostname === 'about:privatebrowsing')) {
      return ABOUT_ICONS['about:privatebrowsing'];
    }
    return getAboutIcon(effectiveHostname, group.tabs || []);
  }
  if (group.favIconUrl) {
    if (group.favIconUrl.startsWith('data:') || group.favIconUrl.startsWith('moz-extension:')) {
      return group.favIconUrl;
    }
  }
  return DEFAULT_FAVICON;
}

function getWindowId(el) {
  const group = el.closest('.window-group');
  if (group) return parseInt(group.dataset.windowId, 10);
  if (typeof StateObserver !== 'undefined' && StateObserver.getActiveWindowId) {
    return StateObserver.getActiveWindowId();
  }
  return null;
}

// Βοηθητική συνάρτηση για δυναμική φόρτωση πλήρων tabs για ένα domain
async function fetchAndFillPopupTabs(domainItem, popup, group) {
  if (!domainItem || !popup) return;

  const hostname = domainItem.dataset.firstHostname || domainItem.dataset.hostname;
  const windowId = getWindowId(domainItem);
  if (!hostname || windowId === null) return;

  const cacheKey = `${windowId}:${hostname}`;
  const now = Date.now();

  // Έλεγχος cache
  if (popupTabsCache.has(cacheKey)) {
    const cached = popupTabsCache.get(cacheKey);
    if (now - cached.timestamp < CACHE_TTL_MS) {
      applyPopupTabs(popup, cached.tabs);
      return;
    } else {
      popupTabsCache.delete(cacheKey);
    }
  }

  try {
    const resp = await browser.runtime.sendMessage({
      type: 'FETCH_TAB_DETAILS',
      source: 'sidebar',
      target: 'background',
      hostname,
      windowId,
      requestId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });

    if (resp && resp.success && Array.isArray(resp.tabs)) {
      popupTabsCache.set(cacheKey, { tabs: resp.tabs, timestamp: Date.now() });
      applyPopupTabs(popup, resp.tabs);
    }
  } catch (e) {
    console.warn('[Builder V26] fetchAndFillPopupTabs failed:', e);
  }
}

// Ενημερώνει τα cards με πλήρη δεδομένα (τίτλος, URL)
function applyPopupTabs(popup, fullTabs) {
  if (!popup) return;
  const cards = popup.querySelectorAll('.popup-tab-card');
  cards.forEach(card => {
    const tabId = parseInt(card.dataset.tabId, 10);
    const data = fullTabs.find(t => t.id === tabId);
    if (!data) return;

    const titleEl = card.querySelector('.card-title');
    const urlEl = card.querySelector('.card-url');
    if (titleEl) titleEl.textContent = data.title || 'No title';
    if (urlEl) {
      try {
        const u = new URL(data.url);
        urlEl.textContent = u.hostname + u.pathname;
        urlEl.title = data.url;
      } catch {
        urlEl.textContent = data.url || '';
        urlEl.title = data.url || '';
      }
    }

    // Ενημέρωση status icons αν χρειάζεται (audible, hidden κ.λπ.)
    const statusIcons = card.querySelector('.card-status-icons');
    if (statusIcons) {
      statusIcons.innerHTML = '';
      if (data.audible) statusIcons.appendChild(createStatusIcon(data.mutedInfo?.muted ? '🔇' : '🔊', 'Sound'));
      if (data.hidden) statusIcons.appendChild(createStatusIcon('🚫', 'Hidden'));
    }
  });
}

function buildDomainItem(hostname, group, isActiveWindow, isSubItem = false, isIncognitoWindow = false) {
  const effectiveHostname = getOriginalAboutHostname(hostname) || hostname;
  const finalFavicon = getFaviconURL(group, hostname, isIncognitoWindow);
  const hasActive = group.tabs.some(t => t.active) && isActiveWindow;

  const item = document.createElement('div');
  item.className = 'domain-item';
  item.classList.toggle('active-domain', hasActive);
  item.classList.toggle('single-tab', group.tabs.length === 1);
  item.classList.toggle('sub-domain-item', isSubItem);
  item.dataset.hostname = hostname;
  if (effectiveHostname === 'about:home' || effectiveHostname === 'about:privatebrowsing') {
    item.dataset.about = 'true';
  }
  item.dataset.favicon = finalFavicon;
  item.dataset.faviconLoaded = (finalFavicon !== DEFAULT_FAVICON) ? 'true' : 'false';
  item.dataset.nodeId = hostname;
  item.dataset.tabIds = JSON.stringify(group.tabs.map(t => t.id));
  const activeTab = group.tabs.find(t => t.active);
  item.dataset.activeTabId = activeTab ? activeTab.id : '';
  item.dataset.count = group.tabs.length;
  item.draggable = true;

  storeOriginalFaviconUrl(item, group);

  const iconWrapper = document.createElement('div');
  iconWrapper.className = 'domain-icon-wrapper';
  const img = document.createElement('img');
  img.className = 'domain-favicon';
  img.src = finalFavicon;
  img.draggable = false;
  if (finalFavicon === DEFAULT_FAVICON) img.dataset.pending = 'true';
  img.onerror = () => { if (img.src !== DEFAULT_FAVICON) { img.src = DEFAULT_FAVICON; img.onerror = null; } };
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = group.tabs.length;
  iconWrapper.appendChild(img);
  iconWrapper.appendChild(badge);
  item.appendChild(iconWrapper);

  if (!isSubItem) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-domain-btn';
    closeBtn.textContent = '×';
    closeBtn.title = browser.i18n.getMessage('closeDomain') || 'Close all tabs in domain';
    item.appendChild(closeBtn);
  }

  if (isSubItem) {
    const unmergeBtn = document.createElement('button');
    unmergeBtn.className = 'unmerge-sub-btn';
    unmergeBtn.textContent = '–';
    unmergeBtn.title = browser.i18n.getMessage('unmergeDomain') || 'Remove from tree';
    unmergeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const host = item.dataset.hostname;
      const wId = getWindowId(item);
      if (host) window.sendAction('REQUEST_UNMERGE_DOMAIN', { hostname: host, windowId: wId });
    });
    item.appendChild(unmergeBtn);
  }

  if (group.isSystemAbout) {
    const sysBadge = document.createElement('span');
    sysBadge.className = 'domain-tab-system-badge';
    sysBadge.textContent = browser.i18n.getMessage('tabSystem') || 'tab system';
    item.appendChild(sysBadge);
  }

  const popup = buildPopupElement(group);
  item.appendChild(popup);
  
  return item;
}

const MAX_VISIBLE_TABS_IN_POPUP = 20;

function buildPopupElement(group) {
  const popup = document.createElement('div');
  popup.className = 'domain-popup';
  const carousel = document.createElement('div');
  carousel.className = 'popup-carousel';
  
  const sortedTabs = [...group.tabs].sort((a, b) => a.id - b.id);
  const tabsToShow = sortedTabs.slice(0, MAX_VISIBLE_TABS_IN_POPUP);
  
  tabsToShow.forEach((tab, index) => carousel.appendChild(buildPopupTabCard(tab, index, tabsToShow.length)));
  
  if (group.tabs.length > MAX_VISIBLE_TABS_IN_POPUP) {
    const moreDiv = document.createElement('div');
    moreDiv.className = 'popup-more-tabs';
    moreDiv.textContent = `+${group.tabs.length - MAX_VISIBLE_TABS_IN_POPUP} more...`;
    moreDiv.style.padding = '8px';
    moreDiv.style.textAlign = 'center';
    moreDiv.style.fontSize = '11px';
    moreDiv.style.opacity = '0.7';
    carousel.appendChild(moreDiv);
  }
  
  popup.appendChild(carousel);
  if (group.tabs.length <= 1) {
    popup.classList.add('single-hidden');
    popup.style.display = 'none';
  }
  
  return popup;
}

function buildPopupTabCard(tab, index, totalTabs) {
  const card = document.createElement('div');
  card.className = 'popup-tab-card' + (tab.active ? ' active-tab' : '');
  card.dataset.tabId = tab.id;
  card.dataset.nodeId = `tab-${tab.id}`;
  card.style.zIndex = totalTabs - index;

  const indexBadge = document.createElement('span');
  indexBadge.className = 'card-index';
  indexBadge.textContent = index + 1;
  card.appendChild(indexBadge);

  const favImg = document.createElement('img');
  favImg.className = 'card-favicon';
  function normalizeAboutHostname(url) {
    if (!url || !url.startsWith('about:')) return null;
    const lower = url.toLowerCase();
    if (['about:home', 'about:newtab', 'about:blank', 'about:privatebrowsing'].some(p => lower.startsWith(p))) return 'about:home';
    const match = lower.match(/^(about:[a-z]+)/i);
    return match ? match[1] : lower;
  }
  const tabHostname = (() => {
    if (!tab.url) return '';
    if (tab.url.startsWith('about:')) return normalizeAboutHostname(tab.url) || tab.url.toLowerCase();
    try { return new URL(tab.url).hostname; } catch { return ''; }
  })();
  favImg.src = getFaviconURL({ tabs: [tab], favIconUrl: tab.favIconUrl }, tabHostname);
  favImg.draggable = false;
  favImg.onerror = () => { favImg.src = DEFAULT_FAVICON; favImg.onerror = null; };
  card.appendChild(favImg);

  const titleSpan = document.createElement('div');
  titleSpan.className = 'card-title';
  titleSpan.textContent = tab.title || 'Loading...';
  card.appendChild(titleSpan);

  if (tab.url) {
    const urlEl = document.createElement('div');
    urlEl.className = 'card-url';
    try { const u = new URL(tab.url); urlEl.textContent = u.hostname + u.pathname; } catch { urlEl.textContent = tab.url; }
    urlEl.title = tab.url;
    card.appendChild(urlEl);
  } else {
    const urlEl = document.createElement('div');
    urlEl.className = 'card-url';
    urlEl.textContent = '...';
    urlEl.title = '';
    card.appendChild(urlEl);
  }

  const statusIcons = document.createElement('div');
  statusIcons.className = 'card-status-icons';
  if (tab.audible) statusIcons.appendChild(createStatusIcon(tab.mutedInfo?.muted ? '🔇' : '🔊', 'Sound'));
  if (tab.hidden) statusIcons.appendChild(createStatusIcon('🚫', 'Hidden'));
  card.appendChild(statusIcons);

  const visBtn = document.createElement('button');
  visBtn.className = 'tab-btn visibility-btn' + (tab.active ? ' disabled' : '');
  visBtn.disabled = tab.active;
  const tabIsVisible = tab.visible !== undefined ? tab.visible : (tab.hidden !== undefined ? !tab.hidden : true);
  visBtn.textContent = tabIsVisible ? '👁🟢' : '👁🔴';
  visBtn.title = tab.active ? (browser.i18n.getMessage('cannotHideActive') || 'Cannot hide active tab') : (tabIsVisible ? (browser.i18n.getMessage('hideTab') || 'Hide tab') : (browser.i18n.getMessage('showTab') || 'Show tab'));
  visBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.sendAction('REQUEST_TOGGLE_TAB_VISIBILITY', { tabId: tab.id });
  });
  card.appendChild(visBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-btn close-btn';
  closeBtn.textContent = '×';
  closeBtn.title = browser.i18n.getMessage('closeTab') || 'Close tab';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.sendAction('REQUEST_CLOSE_TAB', { tabId: tab.id });
  });
  card.appendChild(closeBtn);

  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    e.stopPropagation();
    const tabId = parseInt(card.dataset.tabId);
    if (!isNaN(tabId)) {
      window.sendAction('REQUEST_ACTIVATE_TAB', { tabId });
      const domainItem = card.closest('.domain-item');
      const popup = domainItem?.querySelector('.domain-popup');
      if (domainItem && popup && typeof closePopupDirectly === 'function') closePopupDirectly(domainItem, popup);
    }
  });

  return card;
}

function createStatusIcon(emoji, title) {
  const span = document.createElement('span');
  span.textContent = emoji;
  span.title = title;
  return span;
}

function createTreeElement(key, group, isActiveWindow, isIncognitoWindow = false) {
  const firstHostname = group.hostGroups?.[0]?.hostname || '';
  const parentFavicon = firstHostname ? getFaviconURL(group.hostGroups[0], firstHostname, isIncognitoWindow) : getFaviconURL(group, key, isIncognitoWindow);
  const hasActive = group.tabs.some(t => t.active) && isActiveWindow;

  const parentItem = document.createElement('div');
  parentItem.className = 'domain-item tree-parent no-popup' + (hasActive ? ' active-domain' : '');
  parentItem.dataset.hostname = key;
  parentItem.dataset.nodeId = key;
  parentItem.dataset.groupId = key;
  parentItem.dataset.firstHostname = firstHostname;
  parentItem.draggable = true;
  parentItem.dataset.subHostnames = JSON.stringify(group.hostGroups.map(hg => hg.hostname));
  parentItem.dataset.favicon = parentFavicon;
  parentItem.dataset.faviconLoaded = (parentFavicon !== DEFAULT_FAVICON) ? 'true' : 'false';
  parentItem.dataset.count = group.tabs.length;

  storeOriginalFaviconUrl(parentItem, group);

  const iconWrapper = document.createElement('div');
  iconWrapper.className = 'domain-icon-wrapper';

  const img = document.createElement('img');
  img.className = 'domain-favicon';
  img.draggable = false;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = group.tabs.length;
  iconWrapper.appendChild(img);
  iconWrapper.appendChild(badge);

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  iconWrapper.appendChild(chevron);

  parentItem.appendChild(iconWrapper);

  const closeTreeBtn = document.createElement('button');
  closeTreeBtn.className = 'close-tree-btn';
  closeTreeBtn.textContent = '×';
  closeTreeBtn.title = browser.i18n.getMessage('closeTree') || 'Close all tabs in tree';
  parentItem.appendChild(closeTreeBtn);

  if (group.hostGroups?.length) {
    const firstChild = group.hostGroups[0];
    img.src = getFaviconURL(firstChild, firstChild.hostname, isIncognitoWindow);
    storeOriginalFaviconUrl(parentItem, firstChild);
  } else {
    img.src = parentFavicon;
  }
  if (img.src === DEFAULT_FAVICON) img.dataset.pending = 'true';
  img.onerror = () => { if (img.src !== DEFAULT_FAVICON) { img.src = DEFAULT_FAVICON; img.onerror = null; } };

  const childrenWrapper = document.createElement('div');
  childrenWrapper.className = 'tree-children-wrapper';
  childrenWrapper.dataset.nodeId = key + '-children';
  childrenWrapper.dataset.groupId = key;
  for (const hg of group.hostGroups) {
    childrenWrapper.appendChild(buildDomainItem(hg.hostname, hg, isActiveWindow, true, isIncognitoWindow));
  }

  if (typeof applyColorsToDomainItem === 'function') {
    applyColorsToDomainItem(parentItem).catch(() => {});
  }

  if (typeof TreeState !== 'undefined' && TreeState.collapsedGroups?.has(key)) {
    childrenWrapper.style.display = 'none';
    chevron.textContent = '+';
    chevron.style.color = '#2e7d32';
    chevron.title = 'Ανάπτυξη δέντρου';
  } else {
    chevron.textContent = '−';
    chevron.style.color = '#c62828';
    chevron.title = 'Σύμπτυξη δέντρου';
  }

  return { parent: parentItem, wrapper: childrenWrapper };
}

function createWindowGroupElement(wd, isActiveWindow) {
  const container = document.createElement('div');
  container.className = 'window-group' + (wd.incognito ? ' incognito-window' : '') + (isActiveWindow ? ' active-window' : '');
  container.style.setProperty('--window-bg', wd.color);
  container.style.backgroundColor = wd.color;
  container.dataset.windowId = wd.windowId;
  container.dataset.nodeId = `window-${wd.windowId}`;
  const titleBar = document.createElement('div');
  titleBar.className = 'window-title';
  titleBar.appendChild(document.createTextNode(wd.title));
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
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-group-btn'; closeBtn.textContent = '×';
  closeBtn.title = browser.i18n.getMessage('closeWindow') || 'Close all tabs in window';
  closeBtn.addEventListener('click', e => {
    e.stopPropagation();
    window.sendAction('REQUEST_CLOSE_ALL_TABS_IN_WINDOW', { windowId: wd.windowId });
  });
  titleBar.appendChild(closeBtn);
  container.appendChild(titleBar);
  const domainsContainer = document.createElement('div');
  domainsContainer.className = 'window-domains';
  container.appendChild(domainsContainer);
  return container;
}

function storeOriginalFaviconUrl(item, group) {
  const fav = group.favIconUrl;
  if (fav && (fav.startsWith('data:') || fav.startsWith('moz-extension:'))) {
    item.dataset.originalFaviconUrl = fav;
  }
}

window.buildDomainItem = buildDomainItem;
window.createTreeElement = createTreeElement;
window.DEFAULT_FAVICON = DEFAULT_FAVICON;
window.getFaviconURL = getFaviconURL;
window.getWindowId = getWindowId;
window.createWindowGroupElement = createWindowGroupElement;
window.buildPopupElement = buildPopupElement;
window.storeOriginalFaviconUrl = storeOriginalFaviconUrl;
window.fetchAndFillPopupTabs = fetchAndFillPopupTabs;