import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

import {
  getToken, submitPost, sleep, rateLimitPause,
  resolveRecentSubmission, fetchSubmissionInfo, classifyRemoval
} from './lib/reddit.js';
import {
  listServers, getServerPaths, readJSON, writeJSON,
  ensureServerScaffold, readServerConfig, defaultServerConfig,
  appendPostedRecord, listPostedRecords, writePostedRecords,
  updateServerLastAdAt, addSchedule, listSchedules, removeSchedule
} from './lib/store.js';
import { log } from './lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.CRYER_DATA_DIR || './data');
const PORT = parseInt(process.env.CRYER_PORT || '8383', 10);
const BIND = process.env.CRYER_BIND || '127.0.0.1';
const SHARED_KEY = process.env.CRYER_SHARED_KEY || '';

const SQUIRE_NOTIFY_URL = process.env.SQUIRE_NOTIFY_URL || '';
const SQUIRE_SHARED_KEY = process.env.SQUIRE_SHARED_KEY || '';

const SERVER_ROLLING_WINDOW_MS = 24 * 3600 * 1000; // server-level throttle window
const SCHEDULE_TICK_MS = parseInt(process.env.CRYER_SCHEDULE_TICK_MS || '60000', 10); // 60s

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '256kb' }));

function auth(req, res, next) {
  if (!SHARED_KEY) return res.status(500).json({ error: 'Shared key not configured' });
  const key = req.header('X-Cryer-Key') || '';
  if (key !== SHARED_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

async function notifySquire(type, payload) {
  if (!SQUIRE_NOTIFY_URL) return { ok: false, skipped: true };
  try {
    log.info('intend_notify', { type, sample: Object.keys(payload || {}).slice(0, 5) });
    const r = await fetch(SQUIRE_NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cryer-Key': SHARED_KEY, 'X-Squire-Key': SQUIRE_SHARED_KEY },
      body: JSON.stringify({ type, payload })
    });
    const ok = r.ok;
    log.info('notify_result', { type, ok, status: r.status });
    return { ok };
  } catch (e) {
    log.warn('notify_error', { type, error: e.message });
    return { ok: false, error: e.message };
  }
}

// fill missing post fields from server defaults
function withServerDefaults(serverKey, post) {
  const cfg = readServerConfig(DATA_DIR, serverKey) || defaultServerConfig(serverKey);
  const d = cfg.defaults || {};
  const out = { ...post };
  if (!out.title && d.title) out.title = d.title;
  if (out.type === 'self') {
    if (!out.body && d.body) out.body = d.body;
    if (d.invite && out.body && !out.body.includes(d.invite)) out.body += `\n\n${d.invite}`;
    if (d.invite && !out.body) out.body = d.invite;
  } else if (out.type === 'link') {
    if (!out.url && d.invite) out.url = d.invite;
  }
  return out;
}

// --- API ---
app.post('/v1/register-server', auth, async (req, res) => {
  const { serverKey, name } = req.body || {};
  if (!serverKey) return res.status(400).json({ error: 'serverKey required' });
  await ensureServerScaffold(DATA_DIR, serverKey, name || serverKey);
  return res.json({ ok: true });
});

// Auto-post scheduler creation
app.post('/v1/schedule-advertise', auth, async (req, res) => {
  const { serverKey, at, afterMs } = req.body || {};
  if (!serverKey) return res.status(400).json({ error: 'serverKey required' });
  const whenMs = Number.isFinite(afterMs) ? (Date.now() + Number(afterMs)) : Number(at);
  if (!Number.isFinite(whenMs)) return res.status(400).json({ error: 'at or afterMs required' });
  const entry = addSchedule(DATA_DIR, { serverKey, whenMs, reason: 'manual' });
  log.info('schedule.created', { serverKey, whenMs, id: entry.id, from: 'api' });
  return res.json({ ok: true, schedule: entry });
});

// Main advertise endpoint
app.post('/v1/advertise', auth, async (req, res) => {
  const { serverKey, dryRun, autoScheduleIfThrottled } = req.body || {};
  if (!serverKey) return res.status(400).json({ error: 'serverKey required' });

  log.info('session.start', { serverKey, dryRun: !!dryRun });

  // server-level throttle: rolling 24h from last session
  const serverCfg = readServerConfig(DATA_DIR, serverKey);
  const lastAdAt = Number(serverCfg.lastAdAt || 0);
  const nowMs = Date.now();
  if (lastAdAt && (nowMs - lastAdAt) < SERVER_ROLLING_WINDOW_MS) {
    const throttleUntil = lastAdAt + SERVER_ROLLING_WINDOW_MS;
    log.info('session.throttled', { serverKey, throttleUntil });
    let scheduled = null;
    if (autoScheduleIfThrottled) {
      scheduled = addSchedule(DATA_DIR, { serverKey, whenMs: throttleUntil, reason: 'throttled' });
      log.info('schedule.created', { serverKey, whenMs: throttleUntil, id: scheduled.id, from: 'throttle' });
    }
    // Do not notify Squire here per requirements
    return res.json({ ok: true, status: 'throttled', throttleUntil, scheduled });
  }

  const { serverDir, subsPath, cooldownPath } = getServerPaths(DATA_DIR, serverKey);
  if (!fs.existsSync(serverDir)) return res.status(404).json({ error: 'server not found' });

  const subs = readJSON(subsPath, []);
  const cooldowns = readJSON(cooldownPath, {});
  const results = [];

  const token = dryRun ? null : await getToken();

  let postedCount = 0;

  for (const entry of subs) {
    const { subreddit } = entry;
    const rules = entry.rules || {};
    let post = entry.post || { type: 'self', title: '', body: '' };
    post = withServerDefaults(serverKey, post);

    // cadence: per-sub days (default 1)
    const days = Number.isFinite(rules.cooldownDays) ? rules.cooldownDays : 1;
    const cdMs = days * 24 * 3600000;
    const now = Date.now();
    const last = cooldowns[entry.key || subreddit] || 0;
    const waitMs = cdMs - (now - last);
    if (waitMs > 0) {
      const detail = { subreddit, status: 'skip_cooldown', inHours: Math.ceil(waitMs / 3600000) };
      results.push(detail);
      log.info('subreddit.skip_cooldown', { serverKey, ...detail });
      continue;
    }

    // validations
    const errors = [];
    const inviteRequired = rules.requirePermanentInvite !== false;

    if (!post.title) errors.push('title is required');
    if (post.type === 'self') {
      if (!post.body) errors.push('body is required for self posts');
      if (inviteRequired && post.body && !/(discord\.gg|discord\.com\/invite)\//i.test(post.body)) {
        errors.push('permanent invite link required in body');
      }
    } else if (post.type === 'link') {
      if (!post.url) errors.push('url is required for link posts');
      if (inviteRequired && post.url && !/(discord\.gg|discord\.com\/invite)\//i.test(post.url)) {
        errors.push('permanent invite link required as link URL');
      }
    } else {
      errors.push('unsupported post type');
    }

    if (errors.length) {
      results.push({ subreddit, status: 'invalid', errors });
      log.warn('subreddit.invalid', { serverKey, subreddit, errors });
      continue;
    }

    if (dryRun) {
      const detail = { subreddit, status: 'dry_run_ok', type: post.type, title: post.title, url: post.url, body: post.body };
      results.push(detail);
      log.info('subreddit.dry', { serverKey, subreddit, type: post.type });
      continue;
    }

    try {
      const resp = await submitPost(token, {
        sr: subreddit,
        kind: post.type === 'link' ? 'link' : 'self',
        title: post.title,
        text: post.type === 'self' ? post.body : undefined,
        url: post.type === 'link' ? post.url : undefined,
        flair_id: post.flair_id,
        flair_text: post.flair_text
      });

      await rateLimitPause(resp);

      // update cooldown
      cooldowns[entry.key || subreddit] = Date.now();
      writeJSON(cooldownPath, cooldowns);

      // resolve id/permalink robustly
      let id = resp?.json?.id || resp?.json?.name?.replace(/^t3_/, '') || null;
      let permalink = resp?.json?.url || null;
      if (!id || !permalink) {
        const resolved = await resolveRecentSubmission(subreddit, post.title);
        if (resolved) { id = resolved.id || id; permalink = resolved.permalink || permalink; }
      }

      if (id) {
        appendPostedRecord(DATA_DIR, serverKey, {
          id, subreddit, serverKey, createdUtc: Math.floor(Date.now()/1000), status: 'live'
        });
      }

      const detail = { subreddit, status: 'posted', id, permalink };
      results.push(detail);
      postedCount += 1;
      log.info('subreddit.posted', { serverKey, ...detail });
    } catch (e) {
      const detail = { subreddit, status: 'error', error: e.message || String(e) };
      results.push(detail);
      log.error('subreddit.error', { serverKey, ...detail });
      await sleep(1000);
    }
  }

  // record server-level lastAdAt if we actually posted at least one (not dry)
  if (!dryRun && postedCount > 0) {
    updateServerLastAdAt(DATA_DIR, serverKey, Date.now());
  }

  // Session summary -> Squire (only once, not per sub)
  try {
    const counts = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    log.info('session.end', { serverKey, dryRun: !!dryRun, counts });
    // Notify Squire with non-posted details and overall counts
    await notifySquire('cryer.session.completed', {
      serverKey, dryRun: !!dryRun, counts, details: results.filter(r => r.status !== 'posted')
    });
  } catch {}

  return res.json({ ok: true, results });
});

app.get('/v1/health', (_req, res) => res.json({ ok: true }));

// --- background removal monitor ---
const MONITOR_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MONITOR_TTL_DAYS = 7;

async function runRemovalMonitorOnce() {
  const servers = listServers(DATA_DIR);
  for (const s of servers) {
    const key = s.key || s.id;
    const list = listPostedRecords(DATA_DIR, key);
    const now = Math.floor(Date.now()/1000);
    let changed = false;
    for (const rec of list) {
      if (rec.status !== 'live') continue;
      if ((now - (rec.createdUtc || now)) > MONITOR_TTL_DAYS * 86400) { rec.status = 'expired'; changed = true; continue; }
      if (!rec.id) { rec.status = 'unknown'; changed = true; continue; }

      try {
        const thing = await fetchSubmissionInfo(rec.id);
        if (!thing) continue;
        const { removed, category } = classifyRemoval(thing);
        if (removed && category && category !== 'deleted') {
          rec.status = 'removed';
          rec.removal = { category, checkedUtc: now };
          changed = true;
          log.warn('removal.detected', { serverKey: key, subreddit: rec.subreddit, id: rec.id, category });
          await notifySquire('cryer.post.removed', {
            serverKey: key, subreddit: rec.subreddit, id: rec.id, category
          });
        }
      } catch (e) {
        log.warn('removal.check_error', { serverKey: key, id: rec.id, error: e.message });
      }
    }
    if (changed) writePostedRecords(DATA_DIR, key, list);
  }
}

// --- background schedule runner ---
async function runScheduleTick() {
  const now = Date.now();
  const list = listSchedules(DATA_DIR);
  for (const s of list) {
    if (s.whenMs <= now) {
      log.info('schedule.trigger', { id: s.id, serverKey: s.serverKey, reason: s.reason });
      try {
        await fetch(`http://${BIND}:${PORT}/v1/advertise`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Cryer-Key': SHARED_KEY },
          body: JSON.stringify({ serverKey: s.serverKey, dryRun: false, autoScheduleIfThrottled: false })
        });
      } catch (e) {
        log.warn('schedule.trigger_error', { id: s.id, serverKey: s.serverKey, error: e.message });
      } finally {
        removeSchedule(DATA_DIR, s.id);
      }
    }
  }
}

setInterval(runRemovalMonitorOnce, MONITOR_INTERVAL_MS);
runRemovalMonitorOnce().catch(()=>{});

setInterval(runScheduleTick, SCHEDULE_TICK_MS);
runScheduleTick().catch(()=>{});

app.listen(PORT, BIND, () => {
  console.log(`Cryer listening on http://${BIND}:${PORT}`);
});
