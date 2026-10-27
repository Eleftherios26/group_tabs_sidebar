// preRender.js – V19 – Ενισχυμένο fade‑in με επιπλέον καθυστέρηση 10ms
'use strict';
console.log('[PreRender V19] Module loaded');

const PreRender = (() => {
  let hiddenContainer = null;
  let initialRenderComplete = false;

  function getHiddenContainer() {
    if (!hiddenContainer || !hiddenContainer.isConnected) {
      hiddenContainer = document.createElement('div');
      hiddenContainer.id = 'pre-render-hidden';
      hiddenContainer.style.cssText =
        'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden;';
      document.body.appendChild(hiddenContainer);
    }
    return hiddenContainer;
  }

  function finalizeFadeIn(item) {
    if (!item || !item.classList.contains('fade-in-item')) return;

    // V19: μικρή καθυστέρηση 10ms για να ολοκληρωθεί η φόρτωση εικόνων
    setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          item.offsetHeight; // trigger reflow
          item.classList.remove('fade-in-item');
          item.style.opacity = '1';

          requestAnimationFrame(() => {
            item.style.opacity = '1';
          });

          item.addEventListener('transitionend', function handler() {
            item.style.transition = '';
            item.removeEventListener('transitionend', handler);
          });
          console.log(`[PreRender V19] Fade‑in activated for ${item.dataset.hostname || item.dataset.nodeId}`);
        });
      });
    }, 10);
  }

  function setInitialRenderComplete() {
    initialRenderComplete = true;
    console.log('[PreRender V19] Initial render complete – fade‑in enabled');
  }

  return {
    getHiddenContainer,
    finalizeFadeIn,
    setInitialRenderComplete,
    get _initialRenderComplete() {
      return initialRenderComplete;
    }
  };
})();

window.PreRender = PreRender;