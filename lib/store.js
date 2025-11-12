import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ---------- JSON helpers ----------
export function readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}
export function writeJSON(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function slugifyName(name) {
    return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'server';
}

// ---------- Server registry ----------
export function serversIndexPath(dataDir) {
    return path.join(dataDir, 'servers.json');
}

// Normalize legacy shapes ({id, name}) to ({key, name})
export function listServers(dataDir) {
    const raw = readJSON(serversIndexPath(dataDir), []);
    return raw.map(s => {
        const key = s.key || s.id || slugifyName(s.name || '');
        const name = s.name || s.id || s.key || key;
        return { key, name };
    });
}

export function saveServers(dataDir, list) {
    writeJSON(serversIndexPath(dataDir), list);
}

export function getServerPaths(dataDir, serverKey) {
    if (!serverKey || typeof serverKey !== 'string') {
        throw new Error('getServerPaths: serverKey must be a non-empty string');
    }
    const serverDir   = path.join(dataDir, 'servers', serverKey);
    const subsPath    = path.join(serverDir, 'subreddits.json');
    const queuePath   = path.join(serverDir, 'queue.json');
    const cooldownPath= path.join(serverDir, 'cooldowns.json');
    const serverCfgPath = path.join(serverDir, 'server.json');
    const postedPath  = path.join(serverDir, 'posted.json');
    return { serverDir, subsPath, queuePath, cooldownPath, serverCfgPath, postedPath };
}

export function defaultServerConfig(serverKey, name = serverKey) {
    return {
        key: serverKey,
        name,
        lastAdAt: 0, // epoch ms of last non-dry successful session with at least one post
        defaults: {
            title: "",
            invite: "",
            body: ""
        }
    };
}

export async function ensureServerScaffold(dataDir, serverKey, name = serverKey) {
    const list = listServers(dataDir);
    if (!list.find(s => s.key === serverKey)) {
        list.push({ key: serverKey, name });
        saveServers(dataDir, list);
    }
    const { serverDir, subsPath, queuePath, cooldownPath, serverCfgPath, postedPath } = getServerPaths(dataDir, serverKey);
    fs.mkdirSync(serverDir, { recursive: true });
    if (!fs.existsSync(subsPath)) writeJSON(subsPath, []);
    if (!fs.existsSync(queuePath)) writeJSON(queuePath, []);
    if (!fs.existsSync(cooldownPath)) writeJSON(cooldownPath, {});
    if (!fs.existsSync(serverCfgPath)) writeJSON(serverCfgPath, defaultServerConfig(serverKey, name));
    if (!fs.existsSync(postedPath)) writeJSON(postedPath, []);
}

export function readServerConfig(dataDir, serverKey) {
    const { serverCfgPath } = getServerPaths(dataDir, serverKey);
    // Merge in defaults to avoid missing keys from older files
    const cfg = readJSON(serverCfgPath, defaultServerConfig(serverKey));
    return { ...defaultServerConfig(serverKey, cfg.name), ...cfg };
}
export function writeServerConfig(dataDir, serverKey, cfg) {
    const { serverCfgPath } = getServerPaths(dataDir, serverKey);
    writeJSON(serverCfgPath, cfg);
}
export function updateServerLastAdAt(dataDir, serverKey, whenMs = Date.now()) {
    const cfg = readServerConfig(dataDir, serverKey);
    cfg.lastAdAt = whenMs;
    writeServerConfig(dataDir, serverKey, cfg);
}

export function deleteServer(dataDir, serverKey) {
    const list = listServers(dataDir).filter(s => s.key !== serverKey);
    saveServers(dataDir, list);
    const { serverDir } = getServerPaths(dataDir, serverKey);
    fs.rmSync(serverDir, { recursive: true, force: true });
}

// ---------- Subreddit list (live) ----------
export function listSubreddits(dataDir, serverKey) {
    const { subsPath } = getServerPaths(dataDir, serverKey);
    return readJSON(subsPath, []);
}
export function upsertSubreddit(dataDir, serverKey, entry) {
    const { subsPath } = getServerPaths(dataDir, serverKey);
    const list = readJSON(subsPath, []);
    const key = entry.key || entry.subreddit;
    const ix = list.findIndex(e => (e.key || e.subreddit) === key);
    if (ix >= 0) list[ix] = entry; else list.push(entry);
    writeJSON(subsPath, list);
}
export function deleteSubreddit(dataDir, serverKey, keyOrSubreddit) {
    const { subsPath } = getServerPaths(dataDir, serverKey);
    const list = readJSON(subsPath, []);
    const next = list.filter(e => (e.key || e.subreddit) !== keyOrSubreddit);
    writeJSON(subsPath, next);
}

// ---------- Queue (staging/templates) ----------
export function listQueue(dataDir, serverKey) {
    const { queuePath } = getServerPaths(dataDir, serverKey);
    return readJSON(queuePath, []);
}
export function enqueueTemplate(dataDir, serverKey, entry) {
    const { queuePath } = getServerPaths(dataDir, serverKey);
    const list = readJSON(queuePath, []);
    const key = entry.key || entry.subreddit;
    const ix = list.findIndex(e => (e.key || e.subreddit) === key);
    if (ix >= 0) list[ix] = entry; else list.push(entry);
    writeJSON(queuePath, list);
}
export function dequeueTemplate(dataDir, serverKey, keyOrSubreddit) {
    const { queuePath } = getServerPaths(dataDir, serverKey);
    const list = readJSON(queuePath, []);
    const [item] = list.filter(e => (e.key || e.subreddit) === keyOrSubreddit);
    const next = list.filter(e => (e.key || e.subreddit) !== keyOrSubreddit);
    writeJSON(queuePath, next);
    return item || null;
}

// ---------- Discovery helpers ----------
export function findServersWithSubreddit(dataDir, subreddit, excludeServerKey) {
    const servers = listServers(dataDir);
    const hits = [];
    for (const s of servers) {
        if (s.key === excludeServerKey) continue;
        const list = listSubreddits(dataDir, s.key);
        if (list.some(e => e.subreddit === subreddit)) hits.push(s.key);
    }
    return hits;
}
export function getSubredditFromServer(dataDir, serverKey, subreddit) {
    const list = listSubreddits(dataDir, serverKey);
    return list.find(e => e.subreddit === subreddit) || null;
}

// ---------- Posted-tracking (for removal monitor) ----------
export function getPostedPath(dataDir, serverKey) {
    const { postedPath } = getServerPaths(dataDir, serverKey);
    return postedPath;
}
export function appendPostedRecord(dataDir, serverKey, record) {
    const { postedPath } = getServerPaths(dataDir, serverKey);
    const list = readJSON(postedPath, []);
    list.push(record);
    writeJSON(postedPath, list);
}
export function listPostedRecords(dataDir, serverKey) {
    const { postedPath } = getServerPaths(dataDir, serverKey);
    return readJSON(postedPath, []);
}
export function writePostedRecords(dataDir, serverKey, list) {
    const { postedPath } = getServerPaths(dataDir, serverKey);
    writeJSON(postedPath, list);
}

// ---------- Global schedules (auto-post after throttle) ----------
export function schedulesPath(dataDir) {
    return path.join(dataDir, 'schedules.json');
}
export function listSchedules(dataDir) {
    return readJSON(schedulesPath(dataDir), []);
}
export function addSchedule(dataDir, { serverKey, whenMs, reason = 'throttled' }) {
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const entry = { id, serverKey, whenMs, reason, createdMs: Date.now() };
    const list = listSchedules(dataDir);
    list.push(entry);
    writeJSON(schedulesPath(dataDir), list);
    return entry;
}

export function updateSchedule(dataDir, id, updates = {}) {
    const list = listSchedules(dataDir);
    const ix = list.findIndex(s => s.id === id);
    if (ix < 0) return null;
    const next = { ...list[ix], ...updates };
    list[ix] = next;
    writeJSON(schedulesPath(dataDir), list);
    return next;
}
export function removeSchedule(dataDir, id) {
    const list = listSchedules(dataDir).filter(s => s.id !== id);
    writeJSON(schedulesPath(dataDir), list);
}
