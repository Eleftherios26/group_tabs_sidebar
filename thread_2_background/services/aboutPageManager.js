// aboutPageManager.js – V26 – Ενισχυμένη προστασία κατά τη δημιουργία tabs
// Διορθώθηκε: Αφαίρεση από το _tabsBeingCreated όταν λήγει το placeholder timeout
// ή όταν το tab απελευθερώνεται, ώστε να μην παραμένει μόνιμα κρυφό.
'use strict';
console.log('[AboutPageManager V26] Module loaded – centralized pending tab manager with creation guard');

const AboutPageManager = (() => {
  // ----- Ιδιωτικά πεδία -----
  // Map: tabId -> { windowId, addedAt, hasDestination, timeoutId? }
  const _pendingTabs = new Map();

  // Set: tabIds που μόλις δημιουργήθηκαν και περιμένουν σήμανση
  const _tabsBeingCreated = new Set();

  // Χρονικό όριο (ms) για tabs χωρίς προορισμό (placeholders).
  const PLACEHOLDER_TIMEOUT_MS = 2000;

  // Έσχατο χρονικό όριο (ms) για οποιοδήποτε pending tab – αποφυγή διαρροών μνήμης.
  const STALE_TIMEOUT_MS = 60000;

  // Callback που καλείται όταν αλλάζει η κατάσταση των pending tabs.
  let _onChangeCallback = null;

  // ----- Εσωτερικές βοηθητικές -----

  /**
   * Αφαιρεί ένα tab από τον εσωτερικό χάρτη και από το _tabsBeingCreated,
   * ακυρώνει τυχόν timeout του.
   * @param {number} tabId
   * @returns {object|null} Η entry που αφαιρέθηκε, ή null αν δεν υπήρχε.
   */
  function _removePendingTab(tabId) {
    const entry = _pendingTabs.get(tabId);
    if (!entry) {
      // Ακόμα κι αν δεν είναι pending, φροντίζουμε να φύγει από το _tabsBeingCreated
      _tabsBeingCreated.delete(tabId);
      return null;
    }
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
      console.log(`[AboutPageManager V26] Cleared placeholder timeout for tab ${tabId}`);
    }
    _pendingTabs.delete(tabId);
    _tabsBeingCreated.delete(tabId); // Αφαίρεση από το Set
    console.log(`[AboutPageManager V26] Tab ${tabId} removed from pending and creation guard`);
    return entry;
  }

  /**
   * Εκκαθαρίζει tabs που έχουν παραμείνει pending για υπερβολικά μεγάλο διάστημα.
   */
  function _cleanupStaleTabs() {
    const now = Date.now();
    for (const [tabId, entry] of _pendingTabs.entries()) {
      if (now - entry.addedAt > STALE_TIMEOUT_MS) {
        console.log(`[AboutPageManager V26] Tab ${tabId} removed from pending (stale >${STALE_TIMEOUT_MS}ms)`);
        const removedEntry = _removePendingTab(tabId);
        if (removedEntry) _notifyChange(removedEntry.windowId);
      }
    }
    // Επιπλέον καθαρισμός του _tabsBeingCreated από τυχόν ορφανά IDs
    for (const tabId of _tabsBeingCreated) {
      if (!_pendingTabs.has(tabId)) {
        _tabsBeingCreated.delete(tabId);
        console.log(`[AboutPageManager V26] Removed orphan creation guard for tab ${tabId}`);
      }
    }
  }

  /**
   * Ειδοποιεί τον coordinator για αλλαγή.
   */
  function _notifyChange(windowId) {
    if (typeof _onChangeCallback === 'function') {
      try {
        _onChangeCallback(windowId);
      } catch (e) {
        console.error('[AboutPageManager V26] onChangeCallback error:', e);
      }
    }
  }

  // ----- Δημόσιες μέθοδοι -----

  function setOnChangeCallback(callback) {
    _onChangeCallback = callback;
    console.log('[AboutPageManager V26] onChangeCallback registered');
  }

  /**
   * Σημειώνει ένα tab ως pending με συγκεκριμένο προορισμό.
   */
  function markTabWithDestination(tabId, windowId) {
    if (_pendingTabs.has(tabId)) {
      console.log(`[AboutPageManager V26] Tab ${tabId} already pending, upgrading to destination`);
      const entry = _pendingTabs.get(tabId);
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
        entry.timeoutId = null;
      }
      entry.hasDestination = true;
      entry.addedAt = Date.now();
      _tabsBeingCreated.add(tabId); // Παραμένει υπό δημιουργία μέχρι release
      console.log(`[AboutPageManager V26] Tab ${tabId} upgraded to destination (no timeout)`);
      return;
    }

    _pendingTabs.set(tabId, {
      windowId,
      addedAt: Date.now(),
      hasDestination: true,
      timeoutId: null
    });
    _tabsBeingCreated.add(tabId);
    console.log(`[AboutPageManager V26] Tab ${tabId} marked as destination (no timeout)`);
    _notifyChange(windowId);
  }

  /**
   * Σημειώνει ένα tab ως προσωρινό placeholder.
   * Αν μετά από PLACEHOLDER_TIMEOUT_MS το tab είναι ακόμα about:*,
   * θα απελευθερωθεί αυτόματα και θα εμφανιστεί στο UI.
   */
  function markTabPlaceholder(tabId, windowId) {
    if (_pendingTabs.has(tabId)) {
      console.log(`[AboutPageManager V26] Tab ${tabId} already pending, skipping placeholder`);
      return;
    }

    const timeoutId = setTimeout(() => {
      console.log(`[AboutPageManager V26] Placeholder timeout for tab ${tabId} – releasing`);
      const removedEntry = _removePendingTab(tabId);
      if (removedEntry) _notifyChange(removedEntry.windowId);
    }, PLACEHOLDER_TIMEOUT_MS);

    _pendingTabs.set(tabId, {
      windowId,
      addedAt: Date.now(),
      hasDestination: false,
      timeoutId
    });
    _tabsBeingCreated.add(tabId);
    console.log(`[AboutPageManager V26] Tab ${tabId} marked as placeholder (timeout ${PLACEHOLDER_TIMEOUT_MS}ms)`);
    _notifyChange(windowId);
  }

  /**
   * Απελευθερώνει (αφαιρεί από το pending) ένα tab.
   */
  function releaseTab(tabId) {
    const removedEntry = _removePendingTab(tabId);
    if (removedEntry) {
      console.log(`[AboutPageManager V26] Tab ${tabId} released from pending`);
      _notifyChange(removedEntry.windowId);
      return true;
    }
    return false;
  }

  function isPending(tabId) {
    return _pendingTabs.has(tabId);
  }

  /**
   * Ελέγχει αν το tab πρέπει να αποκλειστεί από το state.
   * Επιστρέφει true αν:
   *  - το tab είναι σε φάση δημιουργίας (ακόμα κι αν δεν έχει μαρκαριστεί)
   *  - ή αν είναι pending με about: URL
   */
  function isPendingPlaceholder(tab) {
    if (!tab || !tab.id) return false;
    // Αποκλείουμε το tab αν μόλις δημιουργήθηκε
    if (_tabsBeingCreated.has(tab.id)) return true;
    if (!_pendingTabs.has(tab.id)) return false;
    const url = tab.url || '';
    return (
      url === 'about:blank' ||
      url === 'about:newtab' ||
      url === 'about:privatebrowsing' ||
      url === 'about:home'
    );
  }

  function getPendingCount() {
    return _pendingTabs.size;
  }

  function cleanupStaleTabs() {
    _cleanupStaleTabs();
  }

  console.log('[AboutPageManager V26] Ready – placeholder timeout: ' + PLACEHOLDER_TIMEOUT_MS + 'ms, stale timeout: ' + STALE_TIMEOUT_MS + 'ms');

  return {
    setOnChangeCallback,
    markTabWithDestination,
    markTabPlaceholder,
    releaseTab,
    isPending,
    isPendingPlaceholder,
    getPendingCount,
    cleanupStaleTabs
  };
})();

self.AboutPageManager = AboutPageManager;