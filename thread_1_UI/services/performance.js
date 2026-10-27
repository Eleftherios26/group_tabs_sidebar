// performance.js – V24 Adaptive performance tier detection & forced override
'use strict';
console.log('[PerformanceTier V24] Module loaded');

const PerformanceTier = (() => {
  let tier = 'high'; // 'low', 'medium', 'high'

  function detect() {
    const memory = navigator.deviceMemory; // GB (προαιρετικό)
    const cores = navigator.hardwareConcurrency || 4;
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);
    
    if (memory !== undefined && memory < 4) {
      tier = 'low';
    } else if (cores <= 2 || isMobile) {
      tier = 'medium';
    } else {
      tier = 'high';
    }

    document.body.classList.add(`perf-${tier}`);
    console.log(`[PerformanceTier V24] Detected tier: ${tier} (memory: ${memory}, cores: ${cores})`);
    return tier;
  }

  function forceTier(forced) {
    if (!['high', 'medium', 'low'].includes(forced)) {
      console.warn(`[PerformanceTier V24] Invalid forced tier: ${forced}, keeping ${tier}`);
      return tier;
    }
    // Αφαίρεση προηγούμενων perf-* κλάσεων
    document.body.classList.remove('perf-high', 'perf-medium', 'perf-low');
    tier = forced;
    document.body.classList.add(`perf-${tier}`);
    console.log(`[PerformanceTier V24] Forced tier: ${tier}`);
    return tier;
  }

  function getTier() { return tier; }
  function isLow() { return tier === 'low'; }
  function isMediumOrLower() { return tier === 'low' || tier === 'medium'; }

  return { detect, forceTier, getTier, isLow, isMediumOrLower };
})();

window.PerformanceTier = PerformanceTier;