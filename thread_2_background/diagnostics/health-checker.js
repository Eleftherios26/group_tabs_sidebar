// Health Checker (V15.2) – Περιοδικός έλεγχος υγείας του background script
// V15.2: Αντικατάσταση setInterval με browser.alarms για αξιοπιστία σε Event Page
const CHECK_ALARM_NAME = 'health-checker-run';
const CHECK_INTERVAL_MINUTES = 1; // 1 λεπτό (ήταν 60s setInterval)

const HealthChecker = {
  interval: null,
  _stats: {},
  _alarmInited: false,

  async init() {
    console.log('[HealthChecker V15.2] Initializing...');
    
    // V15.2: Δημιουργία alarm αντί για setInterval
    await this._ensureAlarm();
    
    // Ακρόαση των alarms
    if (!this._alarmListenerAdded) {
      browser.alarms.onAlarm.addListener(this._handleAlarm.bind(this));
      this._alarmListenerAdded = true;
    }
    
    // Πρώτος έλεγχος μετά από 5 δευτερόλεπτα
    setTimeout(() => this.run(), 5000);
    
    console.log('[HealthChecker V15.2] Initialized with alarm every', CHECK_INTERVAL_MINUTES, 'min');
  },

  async _ensureAlarm() {
    if (this._alarmInited) return;
    try {
      const existing = await browser.alarms.get(CHECK_ALARM_NAME);
      if (!existing) {
        await browser.alarms.create(CHECK_ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
        console.log('[HealthChecker V15.2] Created health check alarm');
      }
      this._alarmInited = true;
    } catch (e) {
      console.error('[HealthChecker V15.2] Failed to create health check alarm:', e);
    }
  },

  _handleAlarm(alarm) {
    if (alarm.name === CHECK_ALARM_NAME) {
      this.run().catch(e => console.error('[HealthChecker V15.2] Alarm run error:', e));
    }
  },

  async run() {
    console.log('[HealthChecker V15.2] Running health check...');
    const stats = {
      timestamp: new Date().toISOString(),
      memory: await this._getMemory(),
      stateSize: await this._getStateSize(),
      eventBufferSize: await this._getEventBufferSize(),
      executionStoreSize: await this._getExecutionStoreSize(),
    };
    this._stats = stats;
    if (typeof LiveReporter !== 'undefined' && LiveReporter.report) {
      LiveReporter.report('health', stats);
    }
  },

  async _getMemory() {
    if (typeof performance !== 'undefined' && performance.memory) {
      return {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
      };
    }
    return null;
  },

  async _getStateSize() {
    try {
      const data = await browser.storage.local.get('v10_state_snapshot');
      const state = data.v10_state_snapshot;
      return state ? JSON.stringify(state).length : 0;
    } catch (e) { return 0; }
  },

  async _getEventBufferSize() {
    const data = await browser.storage.local.get('v10_event_buffer');
    return data.v10_event_buffer ? data.v10_event_buffer.length : 0;
  },

  async _getExecutionStoreSize() {
    const data = await browser.storage.local.get('v10_execution_store');
    return data.v10_execution_store ? data.v10_execution_store.length : 0;
  },

  getStats() { return { ...this._stats }; }
};
self.HealthChecker = HealthChecker;