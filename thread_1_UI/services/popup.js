// Sidebar Popup Manager (V26) – Δυναμική φόρτωση tabs κατά το hover
// V26: Το popup καλεί fetchAndFillPopupTabs για να πάρει τίτλους/URL
//      επειδή το κύριο state δεν τα περιέχει πλέον.
let openDomainItem = null;
let popupCloseTimer = null;
const POPUP_DEBOUNCE = 150;

console.log('[SidebarPopup V26] Module loaded – dynamic popup data');

// ── ΜΟΝΙΜΟΣ MOUSEMOVE LISTENER (εγκαθίσταται μία φορά) ──
(function installPersistentMouseMove() {
  let installed = false;
  function ensureInstalled() {
    if (installed) return;
    document.addEventListener('mousemove', persistentMouseMove);
    installed = true;
    console.log('[SidebarPopup V26] Persistent mousemove listener installed');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureInstalled);
  } else {
    ensureInstalled();
  }
})();

function persistentMouseMove(e) {
  if (!openDomainItem) return;
  const popup = openDomainItem.querySelector('.domain-popup');
  if (!popup) return;

  const overItem = openDomainItem.contains(e.target);
  const overPopup = popup.contains(e.target);

  if (overItem || overPopup) {
    if (popupCloseTimer) {
      clearTimeout(popupCloseTimer);
      popupCloseTimer = null;
    }
  } else {
    if (!popupCloseTimer) {
      popupCloseTimer = setTimeout(() => {
        if (openDomainItem) {
          const p = openDomainItem.querySelector('.domain-popup');
          if (p) closePopupDirectly(openDomainItem, p);
        }
        popupCloseTimer = null;
      }, POPUP_DEBOUNCE);
    }
  }
}

// ── ΤΟΠΟΘΕΤΗΣΗ ΜΕ ΟΜΑΔΟΠΟΙΗΜΕΝΑ READS/WRITES ──
function positionPopup(popup, item) {
  const PADDING = 8;
  const glassPane = document.getElementById('glass-pane');
  if (!glassPane) return;

  const glassRect = glassPane.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();

  popup.classList.remove('popup-left', 'popup-top');
  popup.style.left = '0';
  popup.style.right = 'auto';
  popup.style.maxWidth = 'none';
  popup.style.maxHeight = 'none';

  requestAnimationFrame(() => {
    const carousel = popup.querySelector('.popup-carousel');
    const naturalWidth = carousel
      ? carousel.getBoundingClientRect().width
      : popup.scrollWidth;

    const availableWidth = glassRect.width - PADDING * 2;
    let targetWidth = Math.min(naturalWidth, availableWidth);

    const itemLeft = itemRect.left - glassRect.left;
    const maxRight = glassRect.width - PADDING;

    let needsPopupLeft = false;
    if (itemLeft + targetWidth > maxRight) {
      const altLeft = itemLeft + itemRect.width - targetWidth;
      if (altLeft >= 0) {
        needsPopupLeft = true;
      } else {
        targetWidth = Math.max(100, maxRight - itemLeft);
      }
    }

    const spaceBelow = glassRect.bottom - itemRect.bottom - PADDING;
    const spaceAbove = itemRect.top - glassRect.top - PADDING;

    popup.style.maxHeight = 'none';
    const naturalHeight = popup.scrollHeight;

    let needsPopupTop = false;
    let maxHeight;

    if (naturalHeight <= spaceBelow || spaceBelow >= spaceAbove) {
      needsPopupTop = false;
      maxHeight = spaceBelow;
    } else {
      needsPopupTop = true;
      maxHeight = spaceAbove;
    }

    popup.style.maxWidth = targetWidth + 'px';
    popup.style.maxHeight = maxHeight + 'px';

    if (needsPopupLeft) {
      popup.classList.add('popup-left');
    }

    if (needsPopupTop) {
      popup.classList.add('popup-top');
    }

    if (carousel) {
      carousel.style.maxHeight = (maxHeight - PADDING) + 'px';
      carousel.style.overflowY = 'auto';
    }
  });
}

// ── ΣΥΓΧΡΟΝΙΣΜΟΣ FAVICON ΚΑΡΤΩΝ (καλείται από τον DOMPatcher) ──
function syncPopupFavicons(domainItem, popup) {
  const mainFavicon = domainItem.querySelector('.domain-favicon');
  if (!mainFavicon || !mainFavicon.src) return;
  
  const currentSrc = mainFavicon.src;
  if (currentSrc === (window.DEFAULT_FAVICON || '') || mainFavicon.dataset.pending === 'true') return;
  
  const cards = popup.querySelectorAll('.popup-tab-card .card-favicon');
  cards.forEach(cardImg => {
    if (cardImg.src !== currentSrc) {
      cardImg.src = currentSrc;
      cardImg.onerror = () => {
        cardImg.src = window.DEFAULT_FAVICON || '../../icons/default-favicon.svg';
        cardImg.onerror = null;
      };
    }
  });
}

// ── ΑΝΟΙΓΜΑ POPUP (καλείται από τον coordinator ή τον DOMPatcher) ──
function openPopup(domainItem) {
  const popup = domainItem.querySelector('.domain-popup');
  if (!popup || popup.classList.contains('single-hidden')) {
    return;
  }
  
  if (domainItem.classList.contains('show-popup')) {
    syncPopupFavicons(domainItem, popup);
    const activeCard = popup.querySelector('.popup-tab-card.active-tab');
    if (activeCard) {
      activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    // V26: Φόρτωση πλήρων tabs ακόμα κι αν είναι ήδη ανοιχτό (π.χ. ανανέωση)
    if (typeof window.fetchAndFillPopupTabs === 'function') {
      window.fetchAndFillPopupTabs(domainItem, popup, null);
    }
    return;
  }

  closeAllPopups();

  syncPopupFavicons(domainItem, popup);

  popup.classList.remove('popup-top', 'popup-left');
  domainItem.classList.add('show-popup');
  openDomainItem = domainItem;

  const windowGroup = domainItem.closest('.window-group');
  if (windowGroup) windowGroup.style.zIndex = '9999';

  positionPopup(popup, domainItem);

  // V26: Δυναμική φόρτωση τίτλων/URL για τις κάρτες
  if (typeof window.fetchAndFillPopupTabs === 'function') {
    window.fetchAndFillPopupTabs(domainItem, popup, null);
  }

  const activeCard = popup.querySelector('.popup-tab-card.active-tab');
  if (activeCard) {
    setTimeout(() => {
      activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 50);
  }
}

// ── ΚΛΕΙΣΙΜΟ POPUP ──
function closePopupDirectly(domainItem, popup) {
  if (!domainItem || !popup) return;

  popup.style.transition = 'none';
  domainItem.classList.remove('show-popup');
  openDomainItem = null;

  if (popupCloseTimer) {
    clearTimeout(popupCloseTimer);
    popupCloseTimer = null;
  }

  const windowGroup = domainItem.closest('.window-group');
  if (windowGroup) windowGroup.style.zIndex = '';

  requestAnimationFrame(() => {
    popup.style.transition = '';
    popup.style.maxHeight = '';
    const carousel = popup.querySelector('.popup-carousel');
    if (carousel) {
      carousel.style.maxHeight = '';
      carousel.style.overflowY = '';
    }
  });
}

function closeAllPopups() {
  document.querySelectorAll('.domain-item.show-popup').forEach(item => {
    const popup = item.querySelector('.domain-popup');
    if (popup) closePopupDirectly(item, popup);
  });
}

// ── CLICK / KEY HANDLERS (για χρήση από τον coordinator) ──
function globalClickHandler(e) {
  if (!openDomainItem) return;
  const target = e.target;
  if (target.closest('.domain-item') === openDomainItem ||
      target.closest('.domain-popup') === openDomainItem.querySelector('.domain-popup')) {
    return;
  }
  const popup = openDomainItem.querySelector('.domain-popup');
  if (popup) closePopupDirectly(openDomainItem, popup);
}

function globalKeyHandler(e) {
  if (e.key === 'Escape') closeAllPopups();
}

// ── ΣΥΝΔΕΣΗ LISTENERS (καλείται μία φορά από τον coordinator) ──
function attachPopupListeners(signal) {
  console.log('[SidebarPopup V26] Attaching popup listeners');
  document.removeEventListener('click', globalClickHandler);
  document.addEventListener('click', globalClickHandler, { signal });
  document.removeEventListener('keydown', globalKeyHandler);
  document.addEventListener('keydown', globalKeyHandler, { signal });
}

// ── ΔΗΜΟΣΙΑ API ──
window.openPopup = openPopup;
window.closePopupDirectly = closePopupDirectly;
window.closeAllPopups = closeAllPopups;
window.attachPopupListeners = attachPopupListeners;
window.syncPopupFavicons = syncPopupFavicons;