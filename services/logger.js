const fs = require('fs');
const path = require('path');

let logFile = null;

function initialize(userDataDir) {
  try {
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    logFile = path.join(userDataDir, 'topside.log');
    // Clear the log file on each startup
    fs.writeFileSync(logFile, '');
  } catch (err) {
    console.error('[LOGGER] Failed to initialize:', err.message);
  }
}

function log(tag, ...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] [${tag}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  console.log(message);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, message + '\n');
    } catch (_) {}
  }
}

module.exports = { initialize, log };
