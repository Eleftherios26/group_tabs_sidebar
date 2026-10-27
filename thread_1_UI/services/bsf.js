// BSF – Backup Synchronization Firefox (V25.1)
// V25.1: Διόρθωση – το onFaviconReady ενημερώνει πάντα το εικονίδιο αν το data URL είναι διαφορετικό,
//        όχι μόνο όταν το τρέχον είναι η υδρόγειος. Έτσι αποκαθίσταται ακόμα και αν είχε οριστεί
//        παλιότερο HTTP favicon που έληξε.
// V24: Σέβεται το performance tier – παρακάμπτει το forced repaint σε medium/low tier
'use strict';
console.log('[BSF V25.1] Module loaded – AbortSignal-aware preparation, adaptive repaint, favicon fix');

const BSF = (() => {
  async function prepareDomainItem(key, group, isActiveWindow, isIncognitoWindow, signal) {
    if (signal?.aborted) {
      console.log(`[BSF V25.1] Aborted before start: ${key}`);
      throw new DOMException('Aborted', 'AbortError');
    }

    console.log(`[BSF V25.1] Preparing domain: ${key}`);

    // 1. Δημιουργία του DOM στοιχείου
    const item = window.buildDomainItem(key, group, isActiveWindow, false, isIncognitoWindow);
    const container = window.PreRender.getHiddenContainer();
    container.appendChild(item);

    // 2. Φόρτωση favicon
    const img = item.querySelector('.domain-favicon');
    if (img) {
      const needsLoad = !img.complete || img.dataset.pending === 'true' || img.src === window.DEFAULT_FAVICON;
      if (needsLoad) {
        const displayHostname = item.dataset.firstHostname || item.dataset.hostname;
        const isIncognito = item.closest('.incognito-window') !== null;
        const preferredFavicon = window.getFaviconURL(group, displayHostname, isIncognito);

        if (preferredFavicon !== window.DEFAULT_FAVICON) {
          img.src = preferredFavicon;
          img.dataset.pending = 'false';
          item.dataset.faviconLoaded = 'true';
        } else {
          try {
            const resp = await browser.runtime.sendMessage({
              type: 'FETCH_FAVICON',
              source: 'sidebar', target: 'background',
              hostname: displayHostname,
              requestId: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
            });
            if (resp?.dataUrl) {
              img.src = resp.dataUrl;
              img.dataset.pending = 'false';
              item.dataset.faviconLoaded = 'true';
            }
          } catch (e) {
            // αγνοούμε
          }
        }

        if (signal?.aborted) {
          if (item.parentNode) item.remove();
          throw new DOMException('Aborted', 'AbortError');
        }

        // Αναμονή φόρτωσης εικόνας
        if (!img.complete) {
          try {
            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = () => reject(new Error('Image load error'));
            });
          } catch (e) {
            if (img.src !== window.DEFAULT_FAVICON) {
              img.src = window.DEFAULT_FAVICON;
              img.dataset.pending = 'true';
              item.dataset.faviconLoaded = 'false';
            }
          }
          if (signal?.aborted) {
            if (item.parentNode) item.remove();
            throw new DOMException('Aborted', 'AbortError');
          }
        }

        // V24: Αναγκαστικό repaint μόνο για high tier (παρακάμπτεται σε medium/low για ομαλότητα)
        if (!window.PerformanceTier?.isMediumOrLower() && img && img.src && img.src !== window.DEFAULT_FAVICON) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (signal?.aborted) {
            if (item.parentNode) item.remove();
            throw new DOMException('Aborted', 'AbortError');
          }
          try {
            if (img.decode) await img.decode();
            img.style.display = 'none';
            img.offsetHeight;
            img.style.display = '';
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (signal?.aborted) {
              if (item.parentNode) item.remove();
              throw new DOMException('Aborted', 'AbortError');
            }
            img.style.display = 'none';
            img.offsetHeight;
            img.style.display = '';
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (signal?.aborted) {
              if (item.parentNode) item.remove();
              throw new DOMException('Aborted', 'AbortError');
            }
            img.style.willChange = 'transform';
            img.offsetHeight;
            img.style.willChange = '';
          } catch (e) {
            // αγνοούμε
          }
        }
      }
    }

    // 3. Ανάλυση χρωμάτων
    if (typeof window.applyColorsToDomainItem === 'function') {
      try {
        await window.applyColorsToDomainItem(item);
      } catch (e) {
        console.error(`[BSF V25.1] ColorApply failed for ${key}`, e);
      }
    }
    if (signal?.aborted) {
      if (item.parentNode) item.remove();
      throw new DOMException('Aborted', 'AbortError');
    }

    // 4. Αφαίρεση από το κρυφό container
    if (item.parentNode) item.remove();

    console.log(`[BSF V25.1] Domain ready: ${key}`);
    return item;
  }

  function onFaviconReady(hostname) {
    console.log(`[BSF V25.1] onFaviconReady: updating favicons for ${hostname}`);
    const items = document.querySelectorAll(
      `.domain-item[data-hostname="${hostname}"], .domain-item[data-first-hostname="${hostname}"]`
    );
    items.forEach(async (item) => {
      try {
        const resp = await browser.runtime.sendMessage({
          type: 'FETCH_FAVICON', source: 'sidebar', target: 'background',
          hostname, requestId: crypto.randomUUID(), timestamp: new Date().toISOString(),
        });
        if (resp?.dataUrl) {
          const img = item.querySelector('.domain-favicon');
          // V25.1: Ενημέρωσε το εικονίδιο αν το data URL είναι διαφορετικό από το τρέχον,
          //        ανεξάρτητα από το αν είναι η υδρόγειος ή όχι.
          if (img && img.src !== resp.dataUrl) {
            img.src = resp.dataUrl;
            img.dataset.pending = 'false';
            item.dataset.faviconLoaded = 'true';
            console.log(`[BSF V25.1] Updated favicon for ${hostname} to data URL`);

            // V24: repaint μόνο για high tier
            if (!window.PerformanceTier?.isMediumOrLower()) {
              await new Promise(resolve => requestAnimationFrame(resolve));
              try {
                if (img.decode) await img.decode();
                img.style.display = 'none';
                img.offsetHeight;
                img.style.display = '';
                await new Promise(resolve => requestAnimationFrame(resolve));
                img.style.display = 'none';
                img.offsetHeight;
                img.style.display = '';
                await new Promise(resolve => requestAnimationFrame(resolve));
                img.style.willChange = 'transform';
                img.offsetHeight;
                img.style.willChange = '';
              } catch (e) {}
            }

            delete item.dataset.colorsApplied;
            if (typeof window.applyColorsToDomainItem === 'function') {
              window.applyColorsToDomainItem(item).catch(e =>
                console.warn(`[BSF V25.1] Color re-apply failed for ${hostname}`, e)
              );
            }
          }
        }
      } catch (e) {
        console.warn(`[BSF V25.1] Failed to update favicon for ${hostname}`, e);
      }
    });
  }

  return { prepareDomainItem, onFaviconReady };
})();

window.BSF = BSF;