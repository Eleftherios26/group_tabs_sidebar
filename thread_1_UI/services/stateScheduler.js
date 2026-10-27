// StateScheduler V24 – Ουρά & συγχώνευση state updates με απόρριψη διπλότυπων revisions
'use strict';
console.log('[StateScheduler V24] Module loaded – duplicate revision rejection');

const StateScheduler = (() => {
  const queue = new Map();
  const pendingRevisions = new Set(); // V24: Παρακολούθηση revisions που είναι ήδη στην ουρά
  let idleCallbackId = null;
  let isProcessing = false;
  let lastProcessTime = 0;

  function getDebounceMs() {
    if (window.PerformanceTier && window.PerformanceTier.isLow()) return 200;
    if (window.PerformanceTier && window.PerformanceTier.isMediumOrLower()) return 150;
    return 100;
  }

  const IDLE_TIMEOUT = 300;

  function enqueue(state, windowId) {
    if (!windowId) {
      windowId = state.activeWindowId || '__global__';
    }

    // V24: Απόρριψη αν το ίδιο revision είναι ήδη στην ουρά
    if (pendingRevisions.has(state.stateRevision)) {
      console.log(`[StateScheduler V24] Skipping duplicate revision: ${state.stateRevision}`);
      return;
    }

    pendingRevisions.add(state.stateRevision);
    console.log(`[StateScheduler V24] Enqueue state rev=${state.stateRevision} for window ${windowId}`);
    queue.set(windowId, state);
    scheduleProcess();
  }

  function scheduleProcess() {
    const DEBOUNCE_MS = getDebounceMs();
    const now = Date.now();
    const timeSinceLastProcess = now - lastProcessTime;

    if (timeSinceLastProcess < DEBOUNCE_MS) {
      if (idleCallbackId !== null) {
        clearTimeout(idleCallbackId);
        cancelIdleCallback(idleCallbackId);
        idleCallbackId = null;
      }
      const remaining = DEBOUNCE_MS - timeSinceLastProcess;
      console.log(`[StateScheduler V24] Debouncing – waiting ${remaining}ms more (tier: ${window.PerformanceTier?.getTier()})`);
      if (typeof requestIdleCallback !== 'undefined') {
        idleCallbackId = requestIdleCallback(processQueue, { timeout: remaining + IDLE_TIMEOUT });
      } else {
        idleCallbackId = setTimeout(processQueue, remaining);
      }
      return;
    }

    if (idleCallbackId !== null || isProcessing) {
      console.log('[StateScheduler V24] Already scheduled or processing');
      return;
    }

    if (typeof requestIdleCallback !== 'undefined') {
      idleCallbackId = requestIdleCallback(processQueue, { timeout: IDLE_TIMEOUT });
    } else {
      idleCallbackId = setTimeout(processQueue, IDLE_TIMEOUT);
    }
    console.log('[StateScheduler V24] Scheduled process');
  }

  async function processQueue(deadline) {
    idleCallbackId = null;
    if (isProcessing) {
      console.log('[StateScheduler V24] Already processing, skipping duplicate');
      return;
    }
    isProcessing = true;
    lastProcessTime = Date.now();

    console.log(`[StateScheduler V24] Processing queue – ${queue.size} window(s) pending`);
    const states = Array.from(queue.values());
    queue.clear();

    // V24: Καθάρισε όλα τα revisions που μόλις επεξεργάστηκες
    for (const s of states) {
      pendingRevisions.delete(s.stateRevision);
    }

    let latestState = states[0];
    for (const s of states) {
      if (s.stateRevision > latestState.stateRevision) latestState = s;
    }

    try {
      if (typeof window._applyStateNow === 'function') {
        await window._applyStateNow(latestState);
      }
    } catch (e) {
      console.error('[StateScheduler V24] Error applying state:', e);
    } finally {
      isProcessing = false;
      if (queue.size > 0) {
        console.log('[StateScheduler V24] New states arrived during processing, scheduling again');
        lastProcessTime = 0;
        scheduleProcess();
      }
    }
  }

  function getPendingCount() {
    return queue.size;
  }

  return { enqueue, getPendingCount };
})();

window.StateScheduler = StateScheduler;