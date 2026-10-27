// Toolbar Badge Controller (V17) – Ανεξάρτητη διαχείριση του toolbar badge
// Παρακολουθεί ποια παράθυρα έχουν ενεργό sidebar και ενημερώνει το badge
// με βάση το εστιασμένο παράθυρο, άμεσα και αξιόπιστα.
// V17.1: Αύξηση heartbeat timeout στα 40s για αποφυγή flickering.
//        Αποφυγή περιττών εγγραφών scsStats (γίνεται πλέον στον coordinator).
console.log('[ToolbarBadgeController V17] Module loaded');

const ToolbarBadgeController = {
  // Map: windowId -> timestamp τελευταίου heartbeat
  _activeSidebarWindows: new Map(),
  _focusedWindowId: null,
  _updateAvailable: false,
  _errors: 0,
  _warnings: 0,
  _cleanupTimer: null,
  _heartbeatTimeout: 40000, // 40 δευτερόλεπτα – αρκετό για να μην flickάρει

  init() {
    console.log('[ToolbarBadgeController V17] Initializing...');
    
        // Ακρόαση αλλαγής εστιασμένου παραθύρου
    let focusLossTimer = null;
    browser.windows.onFocusChanged.addListener((windowId) => {
      // Αν πρόκειται για απώλεια εστίασης (windowId = -1)
      if (windowId === browser.windows.WINDOW_ID_NONE) {
        // Περιμένουμε 2 δευτερόλεπτα πριν ενημερώσουμε το badge
        if (focusLossTimer) clearTimeout(focusLossTimer);
        focusLossTimer = setTimeout(() => {
          this._focusedWindowId = windowId;
          console.log(`[ToolbarBadgeController V17] Focus lost, updating badge`);
          this._updateBadge();
          focusLossTimer = null;
        }, 2000);
      } else {
        // Καθαρίζουμε οποιοδήποτε timer απώλειας εστίασης
        if (focusLossTimer) {
          clearTimeout(focusLossTimer);
          focusLossTimer = null;
        }
        this._focusedWindowId = windowId;
        console.log(`[ToolbarBadgeController V17] Focus changed to window ${windowId}`);
        this._updateBadge();
      }
    });

    // Ακρόαση κλεισίματος παραθύρου (για cleanup)
    browser.windows.onRemoved.addListener((windowId) => {
      this._activeSidebarWindows.delete(windowId);
      console.log(`[ToolbarBadgeController V17] Window ${windowId} removed, cleaned up`);
      if (this._focusedWindowId === windowId) {
        this._focusedWindowId = null;
      }
      this._updateBadge();
    });

    // Ακρόαση μηνυμάτων από το sidebar
    browser.runtime.onMessage.addListener((message, sender) => {
      if (message.type === 'SIDEBAR_HEARTBEAT' && message.windowId) {
        console.log(`[ToolbarBadgeController V17] Heartbeat received from window ${message.windowId}`);
        this._handleHeartbeat(message.windowId);
      } else if (message.type === 'SIDEBAR_READY' && message.windowId) {
        console.log(`[ToolbarBadgeController V17] Sidebar ready in window ${message.windowId}`);
        this._handleHeartbeat(message.windowId);
      }
    });

    // Ξεκινάμε τον περιοδικό έλεγχο για stale sidebars
    this._startCleanupTimer();

    // Αρχική ανάγνωση εστιασμένου παραθύρου
    browser.windows.getLastFocused().then(win => {
      if (win && win.id) {
        this._focusedWindowId = win.id;
        console.log(`[ToolbarBadgeController V17] Initial focused window: ${win.id}`);
        this._updateBadge();
      }
    }).catch(() => {});

    // Λήψη αρχικών stats από storage
    browser.storage.local.get(['scsStats', 'sidebarUpdateAvailable']).then(data => {
      if (data.scsStats) {
        this._errors = data.scsStats.errors || 0;
        this._warnings = data.scsStats.warnings || 0;
        console.log(`[ToolbarBadgeController V17] Initial stats: errors=${this._errors}, warnings=${this._warnings}`);
      }
      this._updateAvailable = data.sidebarUpdateAvailable === true;
      if (this._updateAvailable) {
        console.log('[ToolbarBadgeController V17] Update available');
      }
      this._updateBadge();
    });

    // Παρακολούθηση αλλαγών στα stats
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes.scsStats) {
        this._errors = changes.scsStats.newValue?.errors || 0;
        this._warnings = changes.scsStats.newValue?.warnings || 0;
        console.log(`[ToolbarBadgeController V17] Stats changed: errors=${this._errors}, warnings=${this._warnings}`);
        this._updateBadge();
      }
      if (changes.sidebarUpdateAvailable) {
        this._updateAvailable = changes.sidebarUpdateAvailable.newValue === true;
        console.log(`[ToolbarBadgeController V17] Update available changed: ${this._updateAvailable}`);
        this._updateBadge();
      }
    });

    // Αρχική ενημέρωση badge
    this._updateBadge();

    console.log('[ToolbarBadgeController V17] Initialized');
  },

  _handleHeartbeat(windowId) {
    this._activeSidebarWindows.set(windowId, Date.now());
    console.log(`[ToolbarBadgeController V17] Heartbeat from window ${windowId}`);
    
    // Αν αυτό είναι το εστιασμένο παράθυρο, ενημέρωσε το badge άμεσα
    if (windowId === this._focusedWindowId) {
      this._updateBadge();
    }
  },

  _startCleanupTimer() {
    // Κάθε 10 δευτερόλεπτα ελέγχουμε για παράθυρα που έχουν χάσει το heartbeat
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [windowId, timestamp] of this._activeSidebarWindows.entries()) {
        if (now - timestamp > this._heartbeatTimeout) {
          console.log(`[ToolbarBadgeController V17] Window ${windowId} heartbeat timeout, marking inactive`);
          this._activeSidebarWindows.delete(windowId);
          changed = true;
        }
      }
      if (changed) {
        this._updateBadge();
      }
    }, 10000);
  },

  _updateBadge() {
    try {
      if (typeof browser === 'undefined' || !browser.action) return;

      // Προτεραιότητα 1: Ενημέρωση διαθέσιμη
      if (this._updateAvailable) {
        browser.action.setBadgeText({ text: '↑' }).catch(() => {});
        browser.action.setBadgeBackgroundColor({ color: '#2ecc71' }).catch(() => {});
        console.log(`[ToolbarBadgeController V17] Badge set to '↑' (update available)`);
        return;
      }

      // Προτεραιότητα 2: Σφάλματα
      if (this._errors > 0) {
        browser.action.setBadgeText({ text: '!' }).catch(() => {});
        browser.action.setBadgeBackgroundColor({ color: '#e74c3c' }).catch(() => {});
        console.log(`[ToolbarBadgeController V17] Badge set to '!' (errors=${this._errors})`);
        return;
      }

      // Προτεραιότητα 3: Κατάσταση sidebar στο εστιασμένο παράθυρο
      const isSidebarActive = this._focusedWindowId 
        ? this._activeSidebarWindows.has(this._focusedWindowId) 
        : this._activeSidebarWindows.size > 0;

      if (!isSidebarActive || this._warnings > 0) {
        browser.action.setBadgeText({ text: '!' }).catch(() => {});
        browser.action.setBadgeBackgroundColor({ color: '#f39c12' }).catch(() => {});
        console.log(`[ToolbarBadgeController V17] Badge set to '!' (sidebar inactive in window ${this._focusedWindowId} or warnings=${this._warnings})`);
        return;
      }

      // Όλα καλά – καθαρό badge
      browser.action.setBadgeText({ text: '' }).catch(() => {});
      console.log(`[ToolbarBadgeController V17] Badge cleared (sidebar active in window ${this._focusedWindowId})`);
    } catch (e) {
      console.error('[ToolbarBadgeController V17] Error updating badge:', e);
    }
  },

  // Δημόσια μέθοδος για ενημέρωση από τον coordinator (π.χ. όταν αλλάζει το updateAvailable)
  notifyUpdateAvailable(available) {
    this._updateAvailable = available;
    console.log(`[ToolbarBadgeController V17] notifyUpdateAvailable: ${available}`);
    this._updateBadge();
  },

  // Δημόσια μέθοδος για έλεγχο αν το sidebar είναι ενεργό σε συγκεκριμένο παράθυρο
  isSidebarActiveInWindow(windowId) {
    if (!windowId) return this._activeSidebarWindows.size > 0;
    return this._activeSidebarWindows.has(windowId);
  }
};

// Αυτόματη εκκίνηση
ToolbarBadgeController.init();