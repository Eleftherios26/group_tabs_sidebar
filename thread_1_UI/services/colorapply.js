// ColorApply V24 – Adaptive color analysis, μικρότερο canvas σε low tier
'use strict';
console.log('[ColorApply V24] Module loaded');

const colorPaletteCache = new Map();
const colorCacheOrder = [];
const MAX_COLOR_CACHE = 150;

let colorWorker = null;
let workerReady = false;
const pendingWorkerRequests = new Map();

function initColorWorker() {
  try {
    colorWorker = new Worker('../../thread_3_worker/color-worker.js');
    colorWorker.onmessage = (e) => {
      const { requestId, gradient, mainColor, mainRgb, topColors } = e.data;
      const entry = pendingWorkerRequests.get(requestId);
      if (!entry) return;
      pendingWorkerRequests.delete(requestId);
      if (entry.cancelled) return;
      clearTimeout(entry.timeoutId);
      entry.resolve(mainColor ? { gradient, mainColor, mainRgb, topColors } : null);
    };
    colorWorker.onerror = () => { workerReady = false; colorWorker = null; };
    workerReady = true;
    console.log('[ColorApply V24] Color Worker initialized');
  } catch (e) {
    console.warn('[ColorApply V24] Worker not available, using local analysis');
    workerReady = false;
    colorWorker = null;
  }
}
initColorWorker();

function addToColorCache(key, value) {
  if (colorPaletteCache.has(key)) {
    const idx = colorCacheOrder.indexOf(key);
    if (idx > -1) colorCacheOrder.splice(idx, 1);
  } else if (colorPaletteCache.size >= MAX_COLOR_CACHE) {
    const oldest = colorCacheOrder.shift();
    if (oldest) colorPaletteCache.delete(oldest);
  }
  colorPaletteCache.set(key, value);
  colorCacheOrder.push(key);
}

function isLightColor(r, g, b) {
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

function computePaletteFromData(data) {
  const buckets = {};
  for (let i = 0; i < data.length; i += 4) {
    const r = Math.floor(data[i] / 32) * 32,
          g = Math.floor(data[i + 1] / 32) * 32,
          b = Math.floor(data[i + 2] / 32) * 32;
    const key = `${r},${g},${b}`;
    if (!buckets[key]) buckets[key] = { r: data[i], g: data[i + 1], b: data[i + 2], count: 0 };
    buckets[key].count++;
  }
  const sorted = Object.values(buckets).sort((a, b) => b.count - a.count);
  const main = sorted[0] ? { r: sorted[0].r, g: sorted[0].g, b: sorted[0].b } : null;
  const colors = sorted.slice(0, 4).map(c => `rgba(${c.r},${c.g},${c.b},0.3)`);
  const gradient = colors.length === 1 ? colors[0] : `linear-gradient(135deg, ${colors.join(',')})`;
  const topColors = sorted.slice(0, 4).map(c => `rgb(${c.r},${c.g},${c.b})`);
  return main ? { gradient, mainColor: `rgb(${main.r},${main.g},${main.b})`, mainRgb: `${main.r}, ${main.g}, ${main.b}`, topColors } : null;
}

function analyzeViaWorker(pixelData, width, height) {
  return new Promise((resolve) => {
    if (!workerReady || !colorWorker) { resolve(null); return; }
    const requestId = crypto.randomUUID();
    const timeoutId = setTimeout(() => {
      const entry = pendingWorkerRequests.get(requestId);
      if (entry) { entry.cancelled = true; pendingWorkerRequests.delete(requestId); resolve(null); }
    }, 5000);
    pendingWorkerRequests.set(requestId, { resolve, timeoutId, cancelled: false });
    colorWorker.postMessage({ requestId, pixelData: pixelData.buffer, width, height }, [pixelData.buffer]);
  });
}

function loadImagePixelData(imageUrl, signal) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      if (signal?.aborted) { resolve(null); return; }
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        // V24: adaptive size – μικρότερο canvas για low tier, 16px αντί για 32px
        let size = 32;
        if (window.PerformanceTier?.isLow()) size = 16;
        else if (window.PerformanceTier?.isMediumOrLower()) size = 24;
        size = Math.min(img.width, img.height, size);
        canvas.width = canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);
        resolve(new Uint8ClampedArray(ctx.getImageData(0, 0, size, size).data));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

async function getColorPaletteFromImage(imageUrl, signal) {
  if (signal?.aborted) return null;
  if (colorPaletteCache.has(imageUrl)) return colorPaletteCache.get(imageUrl);

  try {
    const pixelData = await loadImagePixelData(imageUrl, signal);
    if (!pixelData || signal?.aborted) return null;

    let result = await analyzeViaWorker(pixelData, Math.sqrt(pixelData.length / 4), Math.sqrt(pixelData.length / 4));
    if (!result) result = computePaletteFromData(pixelData);
    if (result) addToColorCache(imageUrl, result);
    return result;
  } catch (e) { return null; }
}

async function applyColorsToDomainItem(item) {
  const signal = window._renderAbortSignal || null;
  if (signal?.aborted) return;

  const effectiveHostname = item.dataset.firstHostname || item.dataset.hostname;
  if (!effectiveHostname) return;

  console.log(`[ColorApply V24] Resolving colors for: ${effectiveHostname}`);

  if (effectiveHostname.startsWith('about:')) {
    const favUrl = item.dataset.favicon;
    if (favUrl && favUrl !== window.DEFAULT_FAVICON) {
      const palette = await getColorPaletteFromImage(favUrl, signal);
      if (palette) applyPaletteToItem(item, palette);
    }
    return;
  }

  if (item.dataset.colorsApplied === 'true' && 
      item.dataset.favicon === (item.querySelector('.domain-favicon')?.src || item.dataset.favicon)) {
    console.log(`[ColorApply V24] Colors already applied for ${effectiveHostname}, skipping`);
    return;
  }

  const faviconUrl = item.dataset.favicon;
  const img = item.querySelector('.domain-favicon');
  const isDefaultFavicon = !faviconUrl || faviconUrl === window.DEFAULT_FAVICON;
  const isPending = img && img.dataset.pending === 'true';

  let finalFaviconUrl = faviconUrl;
  if (isDefaultFavicon || isPending) {
    try {
      console.log(`[ColorApply V24] Fetching favicon from background for ${effectiveHostname}`);
      const resp = await browser.runtime.sendMessage({
        type: 'FETCH_FAVICON', source: 'sidebar', target: 'background',
        hostname: effectiveHostname, requestId: crypto.randomUUID(), timestamp: new Date().toISOString(),
      });
      if (resp?.dataUrl) {
        finalFaviconUrl = resp.dataUrl;
        item.dataset.favicon = resp.dataUrl;
        item.dataset.faviconLoaded = 'true';
        if (img) { img.src = resp.dataUrl; img.dataset.pending = 'false'; }
        console.log(`[ColorApply V24] Favicon loaded from background for ${effectiveHostname}`);
      }
    } catch (e) { /* συνεχίζουμε με ό,τι έχουμε */ }
  }

  if (finalFaviconUrl && finalFaviconUrl !== window.DEFAULT_FAVICON) {
    const palette = await getColorPaletteFromImage(finalFaviconUrl, signal);
    if (palette) {
      console.log(`[ColorApply V24] Palette computed for ${effectiveHostname}`);
      applyPaletteToItem(item, palette);
    }
  }

  item.dataset.colorsApplied = 'true';
}

function applyPaletteToItem(item, palette) {
  if (palette.mainColor) {
    item.style.setProperty('--domain-gradient', palette.gradient);
    item.style.setProperty('--domain-color', palette.mainColor);

    const glowColor = palette.mainColor.replace('rgb', 'rgba').replace(')', ', 0.4)');
    item.style.setProperty('--domain-glow', glowColor);

    item.style.setProperty('--domain-color-rgb', palette.mainRgb);
    if (palette.topColors?.length) item.style.setProperty('--domain-top-colors', palette.topColors.join(', '));
    if (palette.mainRgb) {
      const [r, g, b] = palette.mainRgb.split(',').map(Number);
      item.style.setProperty('--badge-text-color', isLightColor(r, g, b) ? '#222' : '#fff');
    }
    console.log(`[ColorApply V24] Applied palette to ${item.dataset.hostname || item.dataset.nodeId}`);
  }
}

window.applyColorsToDomainItem = applyColorsToDomainItem;
window.applyPaletteToItem = applyPaletteToItem;