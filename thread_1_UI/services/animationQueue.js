// animationQueue.js – V24
// Σειριακή ουρά ασύγχρονων DOM animations (fade‑out / fade‑in / updates)
// V24: Σέβεται το performance tier – στο low tier οι ενέργειες εκτελούνται άμεσα χωρίς animation.
'use strict';
console.log('[AnimationQueue V24] Module loaded');

const AnimationQueue = (() => {
  const queue = [];
  let running = false;

  async function _runNext() {
    if (queue.length === 0) {
      running = false;
      return;
    }
    running = true;
    const task = queue.shift();
    try {
      await task.fn();
    } catch (e) {
      console.error('[AnimationQueue V24] Task error:', e);
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    _runNext();
  }

  function _enqueue(fn, priority = 0) {
    return new Promise((resolve, reject) => {
      const task = {
        fn: async () => {
          try {
            const result = await fn();
            resolve(result);
          } catch (e) {
            reject(e);
          }
        },
        priority,
      };
      let inserted = false;
      for (let i = 0; i < queue.length; i++) {
        if (task.priority > queue[i].priority) {
          queue.splice(i, 0, task);
          inserted = true;
          break;
        }
      }
      if (!inserted) queue.push(task);
      if (!running) _runNext();
    });
  }

  function waitForTransitionEnd(element, timeoutMs = 2000) {
    return new Promise((resolve) => {
      if (!element) { resolve(); return; }
      let resolved = false;
      const onEnd = () => {
        if (resolved) return;
        resolved = true;
        element.removeEventListener('transitionend', onEnd);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(onEnd, timeoutMs);
      element.addEventListener('transitionend', onEnd, { once: true });
      const style = getComputedStyle(element);
      if (!style.transitionDuration || style.transitionDuration === '0s') {
        onEnd();
      }
    });
  }

  // ── Δημόσιες μέθοδοι ──

  // V24: fadeOut – άμεση αφαίρεση αν low tier ή _initialRender
  async function fadeOut(element, duration = 400) {
    return _enqueue(async () => {
      if (!element || !element.parentNode) return;

      // V24: Παράκαμψη animation για low tier ή αρχικό render
      if (window._initialRender || (window.PerformanceTier && window.PerformanceTier.isLow())) {
        if (element.parentNode) {
          element.remove();
        }
        return;
      }

      if (element._aboutFadeTimer) {
        clearTimeout(element._aboutFadeTimer);
        delete element._aboutFadeTimer;
        console.log('[AnimationQueue V24] Cancelled pending about: fade-in');
      }

      const key = element.dataset.hostname || element.dataset.nodeId;
      console.log(`[AnimationQueue V24] fadeOut start: ${key}`);

      const group = element.closest('.window-group');
      if (group) {
        group.classList.remove('no-transition');
        group.offsetHeight;
        console.log(`[AnimationQueue V24] Removed no-transition from window-group for ${key}`);
      }

      element.style.transition = `opacity ${duration}ms ease, transform ${duration}ms ease`;
      element.style.opacity = '0';
      element.style.transform = 'scale(0.95)';
      await waitForTransitionEnd(element, duration + 100);
      if (element.parentNode) {
        element.remove();
      }
      console.log(`[AnimationQueue V24] fadeOut end: ${key}`);
    }, 10);
  }

  // V24: fadeIn – άμεση εμφάνιση αν low tier ή _initialRender
  async function fadeIn(element, duration = 250) {
    return _enqueue(async () => {
      if (!element) return;

      if (window._initialRender || (window.PerformanceTier && window.PerformanceTier.isLow())) {
        element.style.opacity = '1';
        element.classList.remove('fade-in-item');
        element.style.transition = '';
        return;
      }

      const key = element.dataset.hostname || element.dataset.nodeId;
      console.log(`[AnimationQueue V24] fadeIn start: ${key}`);
      element.style.transition = `opacity ${duration}ms ease`;
      element.style.opacity = '0';
      element.offsetHeight;
      element.style.opacity = '1';
      await waitForTransitionEnd(element, duration + 100);
      element.style.transition = '';
      console.log(`[AnimationQueue V24] fadeIn end: ${key}`);
    }, 5);
  }

  async function fadeOutAll(elements, duration = 400) {
    return Promise.all(elements.map(el => fadeOut(el, duration)));
  }

  async function fadeInAll(elements, duration = 250) {
    if (!elements.length) return;
    await new Promise(resolve => requestAnimationFrame(resolve));
    for (const el of elements) {
      if (!el) continue;
      el.style.transition = `opacity ${duration}ms ease`;
      el.style.opacity = '1';
    }
    await new Promise(resolve => setTimeout(resolve, duration + 50));
  }

  async function update(fn) {
    return _enqueue(async () => {
      await fn();
    }, 0);
  }

  async function batchUpdate(tasks) {
    return _enqueue(async () => {
      for (const task of tasks) {
        await task();
      }
    }, 0);
  }

  return {
    fadeOut,
    fadeIn,
    fadeOutAll,
    fadeInAll,
    update,
    batchUpdate,
  };
})();

window.AnimationQueue = AnimationQueue;