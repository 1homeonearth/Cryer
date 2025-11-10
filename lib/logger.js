import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.env.CRYER_DATA_DIR || './data');
const LOG_PATH = path.resolve(process.env.CRYER_LOG_PATH || path.join(DATA_DIR, 'cryer.log'));

function append(line) {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
}

export function logLine(obj) {
    const rec = { ts: new Date().toISOString(), ...obj };
    append(JSON.stringify(rec));
}

export const log = {
    info:  (type, payload = {}) => logLine({ level: 'info',  type, ...payload }),
    warn:  (type, payload = {}) => logLine({ level: 'warn',  type, ...payload }),
    error: (type, payload = {}) => logLine({ level: 'error', type, ...payload }),
    path:  () => LOG_PATH
};

// Provide a default export too, in case of differing import styles.
export default log;
