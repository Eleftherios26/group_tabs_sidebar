const MAX_ERRORS = 50;
const STORAGE_KEY_ERRORS = 'scs_error_buffer';

const ErrorCollector = {
  errors: [],
  init() {
    browser.storage.local.get(STORAGE_KEY_ERRORS).then(({ [STORAGE_KEY_ERRORS]: stored }) => {
      if (stored && Array.isArray(stored)) this.errors = stored.slice(-MAX_ERRORS);
    });
  },
  record(source, message, stack = null) {
    this.errors.push({ source, message, stack, time: new Date().toISOString() });
    if (this.errors.length > MAX_ERRORS) this.errors = this.errors.slice(-MAX_ERRORS);
    this._persist();
  },
  getAll() { return [...this.errors]; },
  clear() { this.errors = []; this._persist(); },
  async _persist() {
    try { await browser.storage.local.set({ [STORAGE_KEY_ERRORS]: this.errors }); } catch (e) {}
  }
};
self.ErrorCollector = ErrorCollector;