// Live Reporter (V16) – Συλλογή και αναφορά live διαγνωστικών δεδομένων
// V16: Μετονομασία MAX_REPORTS σε MAX_LIVE_REPORTS για αποφυγή σύγκρουσης με το headcontrol.js
console.log('[LiveReporter V16] Module loaded');

const MAX_LIVE_REPORTS = 20;
const STORAGE_KEY_REPORTS = 'scs_live_reports';

const LiveReporter = {
  reports: [],
  _centralLogger: null,
  init(centralLogger) {
    this._centralLogger = centralLogger;
    browser.storage.local.get(STORAGE_KEY_REPORTS).then(({ [STORAGE_KEY_REPORTS]: stored }) => {
      if (stored && Array.isArray(stored)) this.reports = stored.slice(-MAX_LIVE_REPORTS);
      console.log('[LiveReporter V16] Loaded', this.reports.length, 'existing reports');
    });
  },
  report(category, data) {
    const entry = { category, data, time: new Date().toISOString() };
    this.reports.push(entry);
    if (this.reports.length > MAX_LIVE_REPORTS) this.reports = this.reports.slice(-MAX_LIVE_REPORTS);
    if (this._centralLogger) this._centralLogger.log('diagnostics', category, JSON.stringify(data).slice(0, 200), 'info');
    this._persist();
  },
  getAll() { return [...this.reports]; },
  async _persist() {
    try { await browser.storage.local.set({ [STORAGE_KEY_REPORTS]: this.reports }); } catch (e) {}
  }
};
self.LiveReporter = LiveReporter;