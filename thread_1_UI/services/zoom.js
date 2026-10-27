// Zoom Controller (V17) – καμία αλλαγή, ανεξάρτητο από τον DOMPatcher
let currentZoom = 1.0;
const ZOOM_STEP = 0.1;
const MIN_ZOOM = 0.5;
const MIN_CONTENT_WIDTH = 200;
let zoomInitialized = false;

function applyZoom(zoom) {
  const glassPane = document.getElementById('glass-pane');
  if (!glassPane) return;
  const glassWidth = glassPane.clientWidth;
  const maxZoom = Math.max(1.0, glassWidth / MIN_CONTENT_WIDTH);
  currentZoom = Math.min(maxZoom, Math.max(MIN_ZOOM, zoom));
  const wrapper = document.getElementById('content-wrapper');
  if (wrapper) {
    wrapper.style.transform = `scale(${currentZoom})`;
    wrapper.style.transformOrigin = 'top left';
    wrapper.style.width = (100 / currentZoom) + '%';
  }
  const levelEl = document.getElementById('zoom-level');
  if (levelEl) levelEl.textContent = Math.round(currentZoom * 100) + '%';
}

function saveZoomToStorage() {
  browser.storage.local.set({ sidebarZoom: currentZoom });
}

function initZoom() {
  if (zoomInitialized) {
    const levelEl = document.getElementById('zoom-level');
    if (levelEl) levelEl.textContent = Math.round(currentZoom * 100) + '%';
    return;
  }
  zoomInitialized = true;

  document.getElementById('zoom-in-btn').addEventListener('click', () => {
    applyZoom(currentZoom + ZOOM_STEP);
    saveZoomToStorage();
  });
  document.getElementById('zoom-out-btn').addEventListener('click', () => {
    applyZoom(currentZoom - ZOOM_STEP);
    saveZoomToStorage();
  });
  document.getElementById('reset-appearance-btn').addEventListener('click', () => {
    applyZoom(1.0);
    saveZoomToStorage();
  });

  const glassPane = document.getElementById('glass-pane');
  if (glassPane) {
    glassPane.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        applyZoom(currentZoom + delta);
        saveZoomToStorage();
      }
    }, { passive: false });
  }

  browser.storage.local.get('sidebarZoom').then(({ sidebarZoom }) => {
    if (sidebarZoom && typeof sidebarZoom === 'number') {
      if (currentZoom !== sidebarZoom) {
        applyZoom(sidebarZoom);
      }
    }
    const levelEl = document.getElementById('zoom-level');
    if (levelEl) levelEl.textContent = Math.round(currentZoom * 100) + '%';
  });
}

window.initZoom = initZoom;
window.applyZoom = applyZoom;