// Drag & Drop (V23) – Απλοποιημένο, χωρίς φίλτρο about:home (τα IDs είναι πλέον σταθερά)
let draggedItem = null;
let draggedWindowId = null;
let draggedWindowIncognito = null;
let draggedIsTree = false;
let draggedGroupId = null;
let currentTransferTarget = null;
let forbiddenOverlay = null;

let cachedPositions = null;
let cachedContainer = null;

let activeIndicator = null;
let activeIndicatorTarget = null;

console.log('[DragDrop V23] Module loaded – stable IDs, no about filter needed');

function getWindowIdFromElement(el) {
  const group = el.closest('.window-group');
  if (group) return parseInt(group.dataset.windowId, 10);
  return (typeof activeWindowId !== 'undefined') ? activeWindowId : null;
}

function applyTransferHighlight(group) {
  if (group) {
    group.classList.add('transfer-target');
  }
}

function removeTransferHighlight(group) {
  if (group) {
    group.classList.remove('transfer-target');
  }
}

function showForbiddenOverlay(targetElement) {
  if (!forbiddenOverlay) {
    forbiddenOverlay = document.createElement('div');
    forbiddenOverlay.className = 'forbidden-overlay';
    forbiddenOverlay.textContent = '🚫';
    document.body.appendChild(forbiddenOverlay);
  }
  const rect = targetElement.getBoundingClientRect();
  forbiddenOverlay.style.left = rect.left + rect.width / 2 - 20 + 'px';
  forbiddenOverlay.style.top = rect.top + rect.height / 2 - 20 + 'px';
  forbiddenOverlay.style.display = 'block';
}

function hideForbiddenOverlay() {
  if (forbiddenOverlay) {
    forbiddenOverlay.style.display = 'none';
  }
}

function clearInsertIndicator() {
  if (activeIndicatorTarget) {
    activeIndicatorTarget.classList.remove('drag-insert-before', 'drag-insert-after');
    activeIndicatorTarget = null;
  }
  activeIndicator = null;
}

function setInsertIndicator(target, position) {
  clearInsertIndicator();
  if (!target) return;
  if (position === 'before') {
    target.classList.add('drag-insert-before');
  } else if (position === 'after') {
    target.classList.add('drag-insert-after');
  }
  activeIndicatorTarget = target;
}

function finishDrag() {
  if (draggedItem) draggedItem.classList.remove('dragging');
  draggedItem = null;
  draggedWindowId = null;
  draggedWindowIncognito = null;
  draggedIsTree = false;
  draggedGroupId = null;
  window.isDragging = false;

  if (currentTransferTarget) {
    removeTransferHighlight(currentTransferTarget);
    currentTransferTarget = null;
  }

  document.querySelectorAll('.domain-item').forEach(item => {
    item.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
  });
  clearInsertIndicator();

  hideForbiddenOverlay();
  cachedPositions = null;
  cachedContainer = null;
  console.log('[DragDrop V23] Drag finished');
}

function attachDragDrop() {
  document.removeEventListener('dragstart', onDragStart, true);
  document.removeEventListener('dragover', onDragOver, true);
  document.removeEventListener('dragleave', onDragLeave, true);
  document.removeEventListener('drop', onDrop, true);
  document.removeEventListener('dragend', onDragEnd, true);

  document.addEventListener('dragstart', onDragStart, true);
  document.addEventListener('dragover', onDragOver, true);
  document.addEventListener('dragleave', onDragLeave, true);
  document.addEventListener('drop', onDrop, true);
  document.addEventListener('dragend', onDragEnd, true);
  console.log('[DragDrop V23] Listeners attached');
}

function resetDragListeners() {
  document.removeEventListener('dragstart', onDragStart, true);
  document.removeEventListener('dragover', onDragOver, true);
  document.removeEventListener('dragleave', onDragLeave, true);
  document.removeEventListener('drop', onDrop, true);
  document.removeEventListener('dragend', onDragEnd, true);
}

function cacheDomainPositions(container) {
  const positions = [];
  container.querySelectorAll('.domain-item:not(.sub-domain-item)').forEach(item => {
    if (item !== draggedItem) {
      positions.push({
        element: item,
        rect: item.getBoundingClientRect()
      });
    }
  });
  return positions;
}

function onDragStart(e) {
  const item = e.target.closest('.domain-item');
  if (!item) return;
  if (e.target.closest('button')) return;

  draggedItem = item;
  draggedWindowId = getWindowIdFromElement(item);
  const sourceGroup = item.closest('.window-group');
  draggedWindowIncognito = sourceGroup ? sourceGroup.classList.contains('incognito-window') : false;
  window.isDragging = true;
  item.classList.add('dragging');

  draggedIsTree = item.classList.contains('tree-parent');
  draggedGroupId = draggedIsTree ? (item.dataset.groupId || null) : null;

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', item.dataset.firstHostname || item.dataset.hostname || '');
  e.dataTransfer.setData('application/tab-transfer', JSON.stringify({
    hostname: item.dataset.firstHostname || item.dataset.hostname,
    originalWindowId: draggedWindowId,
    isTree: draggedIsTree,
    groupId: draggedGroupId
  }));

  cachedContainer = item.parentNode;
  cachedPositions = cacheDomainPositions(cachedContainer);
  console.log(`[DragDrop V23] Drag started: ${draggedGroupId || item.dataset.hostname}, isTree=${draggedIsTree}, window=${draggedWindowId}`);
}

function onDragOver(e) {
  if (!draggedItem) return;
  e.preventDefault();
  e.stopPropagation();

  const targetDomain = e.target.closest('.domain-item');
  const targetGroup = e.target.closest('.window-group');

  if (targetDomain === draggedItem) return;

  if (targetGroup && draggedWindowIncognito !== null) {
    const targetIncognito = targetGroup.classList.contains('incognito-window');
    if (targetIncognito !== draggedWindowIncognito) {
      e.dataTransfer.dropEffect = 'none';
      showForbiddenOverlay(targetGroup);
      return;
    }
  }

  const targetWin = targetGroup ? parseInt(targetGroup.dataset.windowId, 10) : null;
  if (targetWin !== null && targetWin !== draggedWindowId) {
    hideForbiddenOverlay();
    e.dataTransfer.dropEffect = 'move';
    if (currentTransferTarget !== targetGroup) {
      if (currentTransferTarget) removeTransferHighlight(currentTransferTarget);
      if (targetGroup) applyTransferHighlight(targetGroup);
      currentTransferTarget = targetGroup;
    }
    document.querySelectorAll('.domain-item').forEach(item => {
      item.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
    });
    clearInsertIndicator();
    return;
  }

  if (currentTransferTarget) {
    removeTransferHighlight(currentTransferTarget);
    currentTransferTarget = null;
  }

  hideForbiddenOverlay();
  e.dataTransfer.dropEffect = 'move';

  document.querySelectorAll('.domain-item').forEach(item => {
    item.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
  });
  clearInsertIndicator();

  if (!targetDomain) return;

  if (draggedIsTree && targetDomain && targetDomain.classList.contains('tree-parent')) {
    e.dataTransfer.dropEffect = 'none';
    showForbiddenOverlay(targetDomain);
    return;
  }

  const isDraggedSub = draggedItem.classList.contains('sub-domain-item');
  const isTargetSub = targetDomain.classList.contains('sub-domain-item');

  let targetRect;
  if (cachedPositions) {
    const cached = cachedPositions.find(p => p.element === targetDomain);
    targetRect = cached ? cached.rect : targetDomain.getBoundingClientRect();
  } else {
    targetRect = targetDomain.getBoundingClientRect();
  }
  const relativeY = (e.clientY - targetRect.top) / targetRect.height;

  if (isDraggedSub && isTargetSub) {
    if (e.clientY < targetRect.top + targetRect.height / 2) {
      setInsertIndicator(targetDomain, 'before');
    } else {
      setInsertIndicator(targetDomain, 'after');
    }
    return;
  }

  if (targetDomain.classList.contains('tree-parent') && !draggedIsTree && !isDraggedSub) {
    targetDomain.classList.add('drag-over');
    return;
  }

  if (!isDraggedSub && !isTargetSub && !draggedIsTree && !targetDomain.classList.contains('tree-parent')) {
    if (relativeY >= 0.3 && relativeY <= 0.7) {
      targetDomain.classList.add('drag-over');
    } else {
      if (relativeY < 0.3) setInsertIndicator(targetDomain, 'before');
      else setInsertIndicator(targetDomain, 'after');
    }
    return;
  }

  if (draggedIsTree && !isTargetSub && !targetDomain.classList.contains('tree-parent')) {
    if (relativeY >= 0.25 && relativeY <= 0.75) {
      targetDomain.classList.add('drag-over');
    } else if (relativeY < 0.25) {
      setInsertIndicator(targetDomain, 'before');
    } else {
      setInsertIndicator(targetDomain, 'after');
    }
    return;
  }

  if (!isDraggedSub && !isTargetSub && !draggedIsTree) {
    if (relativeY >= 0.25 && relativeY <= 0.75) {
      targetDomain.classList.add('drag-over');
    } else if (relativeY < 0.25) {
      setInsertIndicator(targetDomain, 'before');
    } else {
      setInsertIndicator(targetDomain, 'after');
    }
  }
}

function onDragLeave(e) {
  // Καμία ενέργεια
}

async function onDrop(e) {
  if (!draggedItem) return;
  e.preventDefault();
  e.stopPropagation();

  let targetDomain = e.target.closest('.domain-item');
  const targetGroup = e.target.closest('.window-group');

  if (!targetDomain) {
    const elementsAtDrop = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of elementsAtDrop) {
      targetDomain = el.closest('.domain-item');
      if (targetDomain) break;
    }
  }

  console.log(`[DragDrop V23] Drop: target=${targetDomain?.dataset.hostname}, targetGroup=${targetGroup?.dataset.windowId}, currentTransferTarget=${currentTransferTarget?.dataset.windowId}`);

  if (draggedIsTree && targetDomain && targetDomain.classList.contains('tree-parent')) {
    console.log('[DragDrop V23] Drop cancelled – tree merge forbidden');
    finishDrag();
    return;
  }

  if (targetGroup && draggedWindowIncognito !== null) {
    const targetIncognito = targetGroup.classList.contains('incognito-window');
    if (targetIncognito !== draggedWindowIncognito) {
      console.log('[DragDrop V23] Drop cancelled – incognito mismatch');
      finishDrag();
      return;
    }
  }

  try {
    let sourceWindowId = draggedWindowId;
    if (!sourceWindowId) sourceWindowId = getWindowIdFromElement(draggedItem);
    if (!sourceWindowId && typeof activeWindowId !== 'undefined') sourceWindowId = activeWindowId;

    const targetWindowId = currentTransferTarget
      ? parseInt(currentTransferTarget.dataset.windowId, 10)
      : (targetDomain ? getWindowIdFromElement(targetDomain) : null);

    const isTransfer = targetWindowId !== null && targetWindowId !== sourceWindowId;

    if (isTransfer && targetWindowId) {
      if (draggedIsTree && draggedGroupId) {
        console.log(`[DragDrop V23] Moving tree ${draggedGroupId} to window ${targetWindowId}`);
        await window.sendAction('REQUEST_MOVE_GROUP', { groupId: draggedGroupId, targetWindowId, originalWindowId: sourceWindowId });
      } else if (draggedItem.classList.contains('tree-parent')) {
        const subHostnames = JSON.parse(draggedItem.dataset.subHostnames || '[]');
        for (const hostname of subHostnames) {
          await window.sendAction('REQUEST_MOVE_TAB', { hostname, targetWindowId, originalWindowId: sourceWindowId });
        }
      } else {
        const hostname = draggedItem.dataset.hostname;
        console.log(`[DragDrop V23] Moving tab(s) ${hostname} to window ${targetWindowId}`);
        await window.sendAction('REQUEST_MOVE_TAB', { hostname, targetWindowId, originalWindowId: sourceWindowId });
      }
      finishDrag();
      return;
    }

    if (targetDomain && !isTransfer) {
      let windowId = getWindowIdFromElement(targetDomain);
      if (!windowId) windowId = getWindowIdFromElement(draggedItem);
      if (!windowId) { finishDrag(); return; }

      const srcHost = draggedItem.dataset.hostname;
      const tgtHost = targetDomain.dataset.hostname;
      if (srcHost === tgtHost) { finishDrag(); return; }

      const isDraggedSub = draggedItem.classList.contains('sub-domain-item');
      const isTargetSub = targetDomain.classList.contains('sub-domain-item');

      if (isDraggedSub && isTargetSub) {
        const treeWrapper = targetDomain.closest('.tree-children-wrapper');
        const treeParent = treeWrapper?.previousElementSibling;
        const groupId = treeParent?.dataset?.groupId || treeWrapper?.dataset?.groupId;
        const insertBefore = targetDomain.classList.contains('drag-insert-before');
        if (groupId && windowId) {
          await window.sendAction('REQUEST_REORDER_MERGED_GROUP', { groupId, sourceHostname: srcHost, targetHostname: tgtHost, insertBefore, windowId });
        }
        finishDrag();
        return;
      }

      if (!isDraggedSub && !isTargetSub) {
        if (targetDomain.classList.contains('drag-over') && !draggedIsTree) {
          console.log(`[DragDrop V23] Merging ${srcHost} into ${tgtHost}`);
          await window.sendAction('REQUEST_MERGE_DOMAINS', { sourceHostname: srcHost, targetHostname: tgtHost, windowId });
          finishDrag();
          return;
        }

        const hasInsertBefore = targetDomain.classList.contains('drag-insert-before');
        const hasInsertAfter = targetDomain.classList.contains('drag-insert-after');

        if (hasInsertBefore || hasInsertAfter) {
          const container = targetDomain.parentNode;
          const allItems = [...container.querySelectorAll(':scope > .domain-item:not(.sub-domain-item)')];
          const allHosts = allItems.map(el => el.dataset.hostname);
          const finalHosts = allHosts.filter(h => h !== srcHost);
          const targetIdxInFinal = finalHosts.indexOf(tgtHost);
          if (targetIdxInFinal !== -1) {
            const insertIdx = hasInsertBefore ? targetIdxInFinal : targetIdxInFinal + 1;
            finalHosts.splice(insertIdx, 0, srcHost);
            await window.sendAction('REQUEST_UPDATE_DOMAIN_ORDER', { windowId, order: finalHosts });
          }
        } else if (draggedIsTree) {
          const container = targetDomain.parentNode;
          const allItems = [...container.querySelectorAll(':scope > .domain-item:not(.sub-domain-item)')];
          const allHosts = allItems.map(el => el.dataset.hostname || el.dataset.groupId);
          const draggedKey = draggedItem.dataset.hostname || draggedGroupId;
          const targetKey = targetDomain.dataset.hostname || targetDomain.dataset.groupId;
          const finalHosts = allHosts.filter(h => h !== draggedKey);
          const targetIdxInFinal = finalHosts.indexOf(targetKey);
          if (targetIdxInFinal !== -1) {
            finalHosts.splice(targetIdxInFinal + 1, 0, draggedKey);
            await window.sendAction('REQUEST_UPDATE_DOMAIN_ORDER', { windowId, order: finalHosts });
          }
        } else {
          const container = targetDomain.parentNode;
          const allItems = [...container.querySelectorAll(':scope > .domain-item:not(.sub-domain-item)')];
          const allHosts = allItems.map(el => el.dataset.hostname);
          const finalHosts = allHosts.filter(h => h !== srcHost);
          const targetIdxInFinal = finalHosts.indexOf(tgtHost);
          if (targetIdxInFinal !== -1) {
            finalHosts.splice(targetIdxInFinal, 0, srcHost);
            await window.sendAction('REQUEST_UPDATE_DOMAIN_ORDER', { windowId, order: finalHosts });
          }
        }
      }
    }
  } finally {
    finishDrag();
  }
}

function onDragEnd(e) {
  finishDrag();
}

window.attachDragDrop = attachDragDrop;
window.resetDragListeners = resetDragListeners;