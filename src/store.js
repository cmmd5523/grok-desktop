const fs = require('fs');
const path = require('path');

/**
 * Minimal JSON persistence: reads the file once, keeps an in-memory copy,
 * writes atomically on save.
 */
function createStore(filePath, defaults) {
  let data = { ...defaults };
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') data = { ...defaults, ...parsed };
    }
  } catch (err) {
    console.error(`Failed to load store ${filePath}:`, err.message);
  }

  return {
    get: () => ({ ...data }),
    set(patch) {
      data = { ...data, ...patch };
      this.save();
      return this.get();
    },
    save() {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, filePath);
      } catch (err) {
        console.error(`Failed to save store ${filePath}:`, err.message);
      }
    },
  };
}

module.exports = { createStore };
