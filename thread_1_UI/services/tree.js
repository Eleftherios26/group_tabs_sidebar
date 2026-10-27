// Tree Manager (V17) – delegated listener, τοπική οπτική λειτουργία (collapsed/expanded)
// V17: Το toggle παραμένει άμεσο (αλλαγή display/chevron) γιατί είναι καθαρά οπτική
//      προτίμηση που δεν επηρεάζει το state. Ο DOMPatcher σέβεται το collapsed state
//      κατά τη δημιουργία νέων tree elements. Καμία αλληλεπίδραση με τον patcher.
const TreeState = {
  collapsedGroups: new Set(),

  async load() {
    console.log('[Tree V17] Loading collapsed groups from storage');
    const { collapsed } = await browser.storage.local.get('collapsed');
    this.collapsedGroups = collapsed ? new Set(collapsed) : new Set();
    console.log('[Tree V17] Loaded collapsed groups:', [...this.collapsedGroups]);
  },

  async save() {
    console.log('[Tree V17] Saving collapsed groups:', [...this.collapsedGroups]);
    await browser.storage.local.set({ collapsed: [...this.collapsedGroups] });
  }
};

let treeDelegatedHandler = null;
let treeAbortController = null;

function attachTreeListeners(signal) {
  console.log('[Tree V17] Attaching tree listeners (delegated)');

  if (treeDelegatedHandler) {
    document.removeEventListener('click', treeDelegatedHandler, true);
    treeDelegatedHandler = null;
  }
  if (treeAbortController) {
    treeAbortController.abort();
    treeAbortController = null;
  }

  treeAbortController = new AbortController();
  if (signal) {
    signal.addEventListener('abort', () => treeAbortController.abort());
  }

  treeDelegatedHandler = function(e) {
    if (e.target.closest('button')) return;

    const parent = e.target.closest('.tree-parent');
    if (!parent) return;

    e.preventDefault();
    e.stopPropagation();

    const groupId = parent.dataset.groupId;
    if (!groupId) {
      console.warn('[Tree V17] Missing groupId on tree parent');
      return;
    }

    const wrapper = parent.nextElementSibling;
    if (!wrapper || !wrapper.classList.contains('tree-children-wrapper')) {
      console.warn('[Tree V17] Missing wrapper for group:', groupId);
      return;
    }

    const chevron = parent.querySelector('.tree-chevron');
    const glassPane = document.getElementById('glass-pane');
    const savedScrollTop = glassPane ? glassPane.scrollTop : 0;

    const isHidden = wrapper.style.display === 'none';
    console.log('[Tree V17] Toggling group:', groupId, '->', isHidden ? 'expanding' : 'collapsing');
    wrapper.style.display = isHidden ? '' : 'none';

    if (isHidden) {
      TreeState.collapsedGroups.delete(groupId);
      if (chevron) {
        chevron.textContent = '−';
        chevron.style.color = '#c62828'; // κόκκινο – ανοιχτό
        chevron.title = 'Σύμπτυξη δέντρου';
      }
    } else {
      TreeState.collapsedGroups.add(groupId);
      if (chevron) {
        chevron.textContent = '+';
        chevron.style.color = '#2e7d32'; // πράσινο – κλειστό
        chevron.title = 'Ανάπτυξη δέντρου';
      }
    }
    TreeState.save();

    if (glassPane) {
      requestAnimationFrame(() => {
        setTimeout(() => { glassPane.scrollTop = savedScrollTop; }, 0);
      });
    }
  };

  document.addEventListener('click', treeDelegatedHandler, { signal: treeAbortController.signal, capture: true });
  console.log('[Tree V17] Delegated listener attached');
}

window.TreeState = TreeState;
window.attachTreeListeners = attachTreeListeners;