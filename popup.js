// ===================== Toolbar Popup Logic (V24) – Adaptive performance tier UI =====================
// V24: Προσθήκη ενότητας "⚡ Απόδοση" με dropdown επιλογής Auto/Υψηλή/Μεσαία/Χαμηλή
//      και εμφάνιση της τρέχουσας κατάστασης.
(function() {
  'use strict';

  const fallbackEl = document.getElementById('fallback-message');
  if (fallbackEl) fallbackEl.style.display = 'none';

  try {
    const statusEl = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const badgeIcon = document.getElementById('badgeIcon');
    const actionBtn = document.getElementById('actionBtn');
    const scsToggle = document.getElementById('scs-toggle');
    const scsStatusEl = document.getElementById('scs-status');
    const scsIcon = document.getElementById('scsIcon');
    const scsText = document.getElementById('scsText');
    const scsLogsContainer = document.getElementById('scs-logs-container');
    const scsLogsList = document.getElementById('scs-logs-list');

    const updateSection = document.getElementById('update-section');
    const updateStatusText = document.getElementById('update-status-text');
    const restartBtn = document.getElementById('restart-btn');

    const exportBtn = document.getElementById('export-logs-btn');

    // V24: Performance elements
    const perfStatusEl = document.getElementById('performance-status');
    const perfIconEl = document.getElementById('perfIcon');
    const perfTextEl = document.getElementById('perfText');
    const perfSelect = document.getElementById('perf-select');

    if (!statusText || !scsText || !updateStatusText) {
      console.error('[ToolbarPopup V24] Missing DOM elements');
      if (fallbackEl) fallbackEl.style.display = 'block';
      return;
    }

    let currentWindowId = null;
    let lastSidebarStatusFromBackground = null;
    let currentSessionId = null;

    function safeSendMessage(msg) {
      return new Promise((resolve) => {
        try {
          browser.runtime.sendMessage(msg).then(resolve).catch(() => resolve(null));
        } catch (e) {
          console.error('[ToolbarPopup V24] sendMessage error:', e);
          resolve(null);
        }
      });
    }

    function applySidebarActive(active) {
      try {
        if (active === true) {
          badgeIcon.textContent = '✓';
          statusText.textContent = browser.i18n.getMessage('sidebarActive') || 'Το sidebar είναι ενεργό σε αυτό το παράθυρο.';
          statusEl.className = 'status active';
          actionBtn.style.display = 'none';
        } else {
          badgeIcon.textContent = '⚠';
          statusText.textContent = browser.i18n.getMessage('sidebarNotActive') || 'Το sidebar δεν είναι ανοιχτό σε αυτό το παράθυρο.';
          statusEl.className = 'status closed';
          actionBtn.style.display = 'block';
          actionBtn.textContent = browser.i18n.getMessage('openSidebar') || '📂 Άνοιγμα Sidebar';
          actionBtn.className = 'warning-btn';
          actionBtn.onclick = async () => {
            await browser.sidebarAction.open();
            window.close();
          };
        }
      } catch (err) {
        console.error('[ToolbarPopup V24] applySidebarActive error:', err);
      }
    }

    function applyScsStats(stats) {
      try {
        if (!stats) return;
        const { errors, warnings } = stats;
        if (errors > 0) {
          scsStatusEl.className = 'status private';
          scsIcon.textContent = '🔴';
          scsText.textContent = `SCS: ${errors} ${browser.i18n.getMessage('scsErrors') || 'σφάλμα(τα)'}`;
        } else if (warnings > 0) {
          scsStatusEl.className = 'status closed';
          scsIcon.textContent = '🟡';
          scsText.textContent = `SCS: ${warnings} ${browser.i18n.getMessage('scsWarnings') || 'προειδοποιήσεις'}`;
        } else {
          scsStatusEl.className = 'status active';
          scsIcon.textContent = '✅';
          scsText.textContent = `SCS: ${browser.i18n.getMessage('scsNoErrors') || 'Κανένα σφάλμα'}`;
        }
      } catch (err) {
        console.error('[ToolbarPopup V24] applyScsStats error:', err);
      }
    }

    function setupUpdateUI() {
      browser.storage.local.get('sidebarUpdateAvailable').then(({ sidebarUpdateAvailable }) => {
        if (sidebarUpdateAvailable) {
          updateStatusText.textContent = '⬆️ Νέα έκδοση διαθέσιμη!';
          updateStatusText.style.color = '#2e7d32';
          restartBtn.style.display = 'block';
          restartBtn.onclick = () => {
            browser.runtime.reload();
          };
        } else {
          updateStatusText.textContent = '✅ Η επέκταση είναι ενημερωμένη';
          updateStatusText.style.color = '#0d5722';
          restartBtn.style.display = 'none';
        }
      });
    }

    // V24: Ανάγνωση και εμφάνιση κατάστασης απόδοσης
    async function updatePerformanceUI() {
      try {
        const data = await browser.storage.local.get(['performanceTierOverride', 'performanceEffectiveTier']);
        const override = data.performanceTierOverride || 'auto';
        const effective = data.performanceEffectiveTier || 'high';

        perfSelect.value = override;

        let tierLabel = '';
        switch (effective) {
          case 'high': tierLabel = 'Υψηλή'; break;
          case 'medium': tierLabel = 'Μεσαία'; break;
          case 'low': tierLabel = 'Χαμηλή'; break;
          default: tierLabel = effective;
        }

        let source = override === 'auto' ? 'Αυτόματη' : 'Χειροκίνητα';
        perfIconEl.textContent = effective === 'low' ? '🐌' : (effective === 'medium' ? '⚡' : '🚀');
        perfTextEl.textContent = `${source} (${tierLabel})`;

        perfStatusEl.className = 'status active';
        if (effective === 'low') perfStatusEl.style.background = 'rgba(255,193,7,0.1)';
        else if (effective === 'medium') perfStatusEl.style.background = 'rgba(0,150,255,0.08)';
        else perfStatusEl.style.background = 'rgba(0,200,83,0.1)';

        console.log(`[ToolbarPopup V24] Performance UI updated: override=${override}, effective=${effective}`);
      } catch (e) {
        console.error('[ToolbarPopup V24] updatePerformanceUI error:', e);
      }
    }

    async function loadInitialState() {
      try {
        if (currentWindowId === null) {
          const currentWin = await browser.windows.getCurrent();
          currentWindowId = currentWin.id;
        }
      } catch (e) {
        console.warn('[ToolbarPopup V24] Could not get current window, fallback to storage');
        try {
          const data = await browser.storage.local.get('sidebarActive');
          lastSidebarStatusFromBackground = data.sidebarActive === true;
          applySidebarActive(data.sidebarActive === true);
        } catch (e2) {
          applySidebarActive(false);
        }
      }

      try {
        if (currentWindowId) {
          const isOpen = await browser.sidebarAction.isOpen({ windowId: currentWindowId });
          lastSidebarStatusFromBackground = isOpen;
          applySidebarActive(isOpen);
        } else {
          const data = await browser.storage.local.get('sidebarActive');
          lastSidebarStatusFromBackground = data.sidebarActive === true;
          applySidebarActive(data.sidebarActive === true);
        }
      } catch (e) {
        console.warn('[ToolbarPopup V24] isOpen failed, trying storage');
        try {
          if (currentWindowId) {
            const data = await browser.storage.local.get('sidebarActive');
            lastSidebarStatusFromBackground = data.sidebarActive === true;
            applySidebarActive(data.sidebarActive === true);
          } else {
            applySidebarActive(false);
          }
        } catch (e2) {
          applySidebarActive(false);
        }
      }

      try {
        const data = await browser.storage.local.get('scsStats');
        applyScsStats(data.scsStats);
      } catch (e) {
        applyScsStats(null);
      }
      try {
        const resp = await safeSendMessage({ type: 'GET_SCS_STATS', source: 'popup' });
        if (resp && resp.success) {
          applyScsStats({ errors: resp.errors, warnings: resp.warnings });
        }
      } catch (e) { /* αγνοούμε */ }

      safeSendMessage({ type: 'CLEAR_SCS_COUNTERS', source: 'popup' }).catch(() => {});

      await loadSessionIdFromBackground();
      
      // V24: Φόρτωση κατάστασης απόδοσης
      await updatePerformanceUI();
    }

    async function loadSessionIdFromBackground() {
      try {
        const resp = await safeSendMessage({ type: 'GET_SESSION_ID', source: 'popup' });
        if (resp && resp.success && resp.sessionId) {
          currentSessionId = resp.sessionId;
          console.log('[ToolbarPopup V24] Session ID from background:', currentSessionId);
        } else {
          console.warn('[ToolbarPopup V24] Could not get session ID from background');
          try {
            const data = await browser.storage.session.get('currentSessionId');
            currentSessionId = data.currentSessionId || null;
          } catch (e) {
            currentSessionId = null;
          }
        }
      } catch (e) {
        console.error('[ToolbarPopup V24] Failed to get session ID:', e);
        currentSessionId = null;
      }
    }

    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      try {
        if (changes.sidebarActive) {
          const storageValue = changes.sidebarActive.newValue === true;
          if (lastSidebarStatusFromBackground !== null && lastSidebarStatusFromBackground !== storageValue) {
            return;
          }
          applySidebarActive(storageValue);
        }
        if (changes.scsStats) {
          applyScsStats(changes.scsStats.newValue);
        }
        if (changes.sidebarUpdateAvailable) {
          setupUpdateUI();
        }
        // V24: Ανίχνευση αλλαγών στις ρυθμίσεις απόδοσης
        if (changes.performanceTierOverride || changes.performanceEffectiveTier) {
          updatePerformanceUI();
        }
      } catch (err) {
        console.error('[ToolbarPopup V24] storage.onChanged error:', err);
      }
    });

    // V24: Αλλαγή από τον χρήστη στο dropdown
    perfSelect.addEventListener('change', async () => {
      const newOverride = perfSelect.value;
      await browser.storage.local.set({ performanceTierOverride: newOverride });
      
      if (newOverride !== 'auto') {
        perfIconEl.textContent = newOverride === 'low' ? '🐌' : (newOverride === 'medium' ? '⚡' : '🚀');
        perfTextEl.textContent = `Χειροκίνητα (${newOverride === 'low' ? 'Χαμηλή' : newOverride === 'medium' ? 'Μεσαία' : 'Υψηλή'})`;
        // Άμεση ειδοποίηση της sidebar
        browser.runtime.sendMessage({ type: 'PERFORMANCE_TIER_CHANGED', source: 'popup' }).catch(() => {});
      } else {
        perfIconEl.textContent = '⏳';
        perfTextEl.textContent = 'Αυτόματη (θα ανανεωθεί)';
        browser.runtime.sendMessage({ type: 'PERFORMANCE_TIER_CHANGED', source: 'popup' }).catch(() => {});
      }
      console.log(`[ToolbarPopup V24] Performance tier changed to: ${newOverride}`);
    });

    function getLogColor(type) {
      switch (type) {
        case 'error': return '#e74c3c';
        case 'warn':  return '#f39c12';
        default:      return 'inherit';
      }
    }

    async function readAllLogsFromBackground() {
      try {
        const resp = await safeSendMessage({ type: 'GET_LOGS', source: 'popup' });
        if (resp && resp.success && Array.isArray(resp.logs)) {
          console.log('[ToolbarPopup V24] Got', resp.logs.length, 'logs from background');
          return resp.logs;
        }
        return [];
      } catch (e) {
        console.error('[ToolbarPopup V24] Failed to get logs from background:', e);
        return [];
      }
    }

    async function readCurrentSessionLogs() {
      const allLogs = await readAllLogsFromBackground();
      if (!currentSessionId) {
        return allLogs.slice(-20);
      }
      return allLogs.filter(log => log.sessionId === currentSessionId).slice(-20);
    }

    let scsExpanded = false;
    scsToggle.addEventListener('click', async () => {
      scsExpanded = !scsExpanded;
      scsLogsContainer.style.display = scsExpanded ? 'block' : 'none';
      scsToggle.textContent = scsExpanded ? '🛡️ Sidebar Control Services ▴' : '🛡️ Sidebar Control Services ▾';
      if (scsExpanded) {
        try {
          const logs = await readCurrentSessionLogs();
          scsLogsList.innerHTML = '';
          const recent = logs.reverse();
          for (const log of recent) {
            const li = document.createElement('li');
            li.style.padding = '4px 2px';
            li.style.fontSize = '11px';
            li.style.color = getLogColor(log.type);
            li.textContent = `[${log.type.toUpperCase()}] ${log.time ? new Date(log.time).toLocaleTimeString() : ''} [${log.source || log.service || 'unknown'}] ${log.message || '(χωρίς μήνυμα)'}`;
            scsLogsList.appendChild(li);
          }
        } catch (e) {
          console.error('[ToolbarPopup V24] loadLogs error:', e);
        }
      }
    });

    exportBtn.addEventListener('click', async () => {
      try {
        const allLogs = await readAllLogsFromBackground();

        if (allLogs.length === 0) {
          alert(browser.i18n.getMessage('noHistoryEntries'));
          return;
        }

        allLogs.sort((a, b) => {
          const timeA = a.time ? new Date(a.time).getTime() : 0;
          const timeB = b.time ? new Date(b.time).getTime() : 0;
          return timeA - timeB;
        });

        const sessions = new Map();
        for (const log of allLogs) {
          const sid = log.sessionId || 'unknown';
          if (!sessions.has(sid)) {
            sessions.set(sid, []);
          }
          sessions.get(sid).push(log);
        }

        let text = '=== Group Tabs Sidebar V26.1.1 – Ιστορικό συμβάντων ===\n\n';
        let sessionIndex = 1;

        const sortedSessions = Array.from(sessions.entries()).sort((a, b) => {
          const firstA = a[1][0]?.time ? new Date(a[1][0].time).getTime() : 0;
          const firstB = b[1][0]?.time ? new Date(b[1][0].time).getTime() : 0;
          return firstA - firstB;
        });

        for (const [sessionId, logs] of sortedSessions) {
          const firstLog = logs[0];
          const lastLog = logs[logs.length - 1];
          const startDate = new Date(firstLog.time);
          const endDate = new Date(lastLog.time);
          
          const dateStr = startDate.toLocaleDateString('el-GR', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          });
          const startTimeStr = startDate.toLocaleTimeString('el-GR', {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
          });
          const endTimeStr = endDate.toLocaleTimeString('el-GR', {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
          });

          text += `${'═'.repeat(60)}\n`;
          text += `── ΣΥΝΕΔΡΙΑ ${sessionIndex} ──\n`;
          text += `── Session ID: ${sessionId} ──\n`;
          text += `── Έναρξη: ${dateStr} στις ${startTimeStr} ──\n`;
          text += `── Λήξη:   ${dateStr} στις ${endTimeStr} ──\n`;
          text += `── Πλήθος καταγραφών: ${logs.length} ──\n`;
          text += `${'═'.repeat(60)}\n\n`;

          logs.forEach((log, idx) => {
            const time = log.time ? new Date(log.time).toLocaleString('el-GR') : 'Άγνωστη ώρα';
            const type = (log.type || 'info').toUpperCase();
            const source = log.source || log.service || 'unknown';
            const message = log.message || '(χωρίς μήνυμα)';
            text += `[${idx + 1}] ${time} [${type}] [${source}] ${message}\n`;
          });
          text += '\n';
          sessionIndex++;
        }

        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sidebar-history-${new Date().toISOString().slice(0, 10)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('[ToolbarPopup V24] Export completed, entries:', allLogs.length);
      } catch (e) {
        console.error('[ToolbarPopup V24] Export failed:', e);
        alert(browser.i18n.getMessage('exportError'));
      }
    });

    setupUpdateUI();
    loadInitialState().catch(e => console.error('[ToolbarPopup V24] Initial load failed:', e));
    setInterval(loadInitialState, 30000);
    console.log('[ToolbarPopup V24] Initialization complete');

  } catch (e) {
    console.error('[ToolbarPopup V24] Fatal error:', e);
    const fallbackEl = document.getElementById('fallback-message');
    if (fallbackEl) fallbackEl.style.display = 'block';
  }
})();
