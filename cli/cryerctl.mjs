import 'dotenv/config';
import prompts from 'prompts';
import path from 'path';
import fs from 'fs';
import readline from 'readline';

import {
  ensureServerScaffold, getServerPaths, listServers, readServerConfig, writeServerConfig,
  deleteServer, listSubreddits, upsertSubreddit, deleteSubreddit, defaultServerConfig,
  findServersWithSubreddit, getSubredditFromServer,
  listQueue, enqueueTemplate, dequeueTemplate, slugifyName
} from '../lib/store.js';
import { listLinkFlairs } from '../lib/reddit.js';
import { resolveCallbackHost } from '../lib/network.js';

const DATA_DIR = path.resolve(process.env.CRYER_DATA_DIR || './data');
const BIND = process.env.CRYER_BIND || '127.0.0.1';
const PORT = process.env.CRYER_PORT || '8383';
const KEY = process.env.CRYER_SHARED_KEY || '';
const CALLBACK_HOST = resolveCallbackHost(BIND);
const SQUIRE_SERVERS_URL = process.env.SQUIRE_SERVERS_URL || ''; // http://localhost:8888/internal/servers OR file://...
const SQUIRE_SHARED_KEY = process.env.SQUIRE_SHARED_KEY || '';
const LOG_PATH = path.resolve(process.env.CRYER_LOG_PATH || path.join(DATA_DIR, 'cryer.log'));

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

// --- entry: support "logs" mode like `node cli/cryerctl.mjs logs`
const subcommand = (process.argv[2] || '').trim().toLowerCase();
if (subcommand === 'logs') {
  await logsUI();
  process.exit(0);
}

async function mainMenu() {
  while (true) {
    await printQueueAlert();
    const { action } = await prompts({
      type: 'select',
      name: 'action',
      message: 'Cryer — Main Menu',
      choices: [
        { title: 'Add / Register Discord server', value: 'add' },
        { title: 'List servers', value: 'list' },
        { title: 'Sync servers from Squire (optional)', value: 'sync' },
                                     { title: 'Select a server', value: 'edit' },
                                     { title: 'Post advertisements for ALL servers (now)', value: 'post-all' },
                                     { title: 'Delete a server', value: 'delete' },
                                     { title: 'View logs', value: 'logs' },
                                     { title: 'Exit', value: 'exit' }
      ]
    });
    if (!action || action === 'exit') return;
    if (action === 'add') await addServer();
    if (action === 'list') await listServersAction();
    if (action === 'sync') await syncServersFromSquire();
    if (action === 'edit') await selectServerMenu();
    if (action === 'post-all') await postAllServers();
    if (action === 'delete') await deleteServerAction();
    if (action === 'logs') await logsUI();
  }
}

function serverKeyOf(s) {
  return s?.key || s?.id || slugifyName(s?.name || '');
}

async function printQueueAlert() {
  const servers = listServers(DATA_DIR);
  const withQueues = [];
  for (const s of servers) {
    const key = serverKeyOf(s);
    const q = listQueue(DATA_DIR, key);
    if (q.length) withQueues.push(`${s.name || key} (${q.length})`);
  }
  if (withQueues.length) {
    console.log(RED(BOLD(`⚠ Templates waiting for customization:`)));
    console.log(RED(`  ${withQueues.join(', ')}`));
  }
}

async function addServer() {
  const { name } = await prompts([
    { type: 'text', name: 'name', message: 'Server name (display):' }
  ]);
  if (!name) return;

  const defaultKey = slugifyName(name);
  const { key } = await prompts([
    { type: 'text', name: 'key', message: `Server key (slug) [${defaultKey}] (Enter for default)`, initial: defaultKey }
  ]);

  const serverKey = (key || defaultKey);
  await ensureServerScaffold(DATA_DIR, serverKey, name);

  const { setDefaults } = await prompts({
    type: 'toggle', name: 'setDefaults',
    message: 'Configure default title/invite/body now?',
    initial: true, active: 'yes', inactive: 'no'
  });
  if (setDefaults) await editServerDefaults(serverKey);

  console.log(`✔ Registered server: ${name} [${serverKey}]`);
}

async function listServersAction() {
  const list = listServers(DATA_DIR);
  if (!list.length) { console.log('No servers yet.'); return; }
  for (const s of list) {
    const key = serverKeyOf(s);
    const q = listQueue(DATA_DIR, key).length;
    const tag = q ? RED(` (queue: ${q})`) : '';
    console.log(`- ${s.name || key} [${key}]${tag}`);
  }
}

async function deleteServerAction() {
  const servers = listServers(DATA_DIR);
  if (!servers.length) { console.log('No servers.'); return; }
  const { serverKey } = await prompts({
    type: 'select',
    name: 'serverKey',
    message: 'Pick server to delete',
    choices: [{ title: 'Go back', value: '__back' }].concat(
      servers.map(s => {
        const key = serverKeyOf(s);
        return { title: `${s.name || key} [${key}]`, value: key };
      })
    )
  });
  if (!serverKey || serverKey === '__back') return;
  const { yes } = await prompts({ type: 'toggle', name: 'yes', message: `Delete ${serverKey}?`, initial: false, active: 'Yes', inactive: 'No' });
  if (!yes) return;
  deleteServer(DATA_DIR, serverKey);
  console.log(`✔ Deleted ${serverKey}`);
}

async function selectServerMenu() {
  const servers = listServers(DATA_DIR);
  if (!servers.length) { console.log('No servers.'); return; }
  const { serverKey } = await prompts({
    type: 'select',
    name: 'serverKey',
    message: 'Pick server',
    choices: servers.map(s => {
      const key = serverKeyOf(s);
      return { title: `${s.name || key} [${key}]`, value: key };
    })
  });
  if (!serverKey) return;

  while (true) {
    const { choice } = await prompts({
      type: 'select',
      name: 'choice',
      message: `Server: ${serverKey}`,
      choices: [
        { title: 'Defaults (title, invite, body)', value: 'defaults' },
                                     { title: 'Add a subreddit', value: 'add-sub' },
                                     { title: 'Select a subreddit', value: 'sel-sub' },
                                     { title: 'List subreddits', value: 'list-subs' },
                                     { title: 'Delete a subreddit', value: 'del-sub' },
                                     { title: 'Review queue (customize templates)', value: 'queue' },
                                     { title: 'Post advertisements now (via local API)', value: 'post-now' },
                                     { title: 'Go back', value: 'back' }
      ]
    });
    if (!choice || choice === 'back') return;
    if (choice === 'defaults') await editServerDefaults(serverKey);
    if (choice === 'add-sub') await addSubredditFlow(serverKey);
    if (choice === 'sel-sub') await selectSubredditFlow(serverKey);
    if (choice === 'list-subs') await listSubredditsAction(serverKey);
    if (choice === 'del-sub') await deleteSubredditAction(serverKey);
    if (choice === 'queue') await reviewQueueFlow(serverKey);
    if (choice === 'post-now') await postNow(serverKey);
  }
}

async function editServerDefaults(serverKey) {
  const cfg = readServerConfig(DATA_DIR, serverKey);
  const d = cfg.defaults || defaultServerConfig(serverKey).defaults;

  const ans = await prompts([
    { type: 'text', name: 'title',  message: 'Default post title', initial: d.title },
    { type: 'text', name: 'invite', message: 'Default permanent invite URL', initial: d.invite },
    { type: 'text', name: 'body',   message: 'Default body (self posts). For link posts, the URL will be the invite.', initial: d.body }
  ]);
  cfg.defaults = {
    title:  ans.title  ?? d.title,
    invite: ans.invite ?? d.invite,
    body:   ans.body   ?? d.body
  };
  writeServerConfig(DATA_DIR, serverKey, cfg);
  console.log('✔ Saved defaults');
}

function defaultRules() {
  return {
    cooldownDays: 1,
    requirePermanentInvite: true
  };
}

function mergeDefaults(serverKey, post, providedDefaults = null) {
  let d = providedDefaults;
  if (!d) {
    const cfg = readServerConfig(DATA_DIR, serverKey);
    d = cfg?.defaults || defaultServerConfig(serverKey).defaults;
  }
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

async function addSubredditFlow(serverKey) {
  const { subreddit } = await prompts([
    { type: 'text', name: 'subreddit', message: 'Subreddit (no /r/):' }
  ]);
  if (!subreddit) return;

  // Pre-load template if sub exists elsewhere
  const others = findServersWithSubreddit(DATA_DIR, subreddit, serverKey);
  let template = null;
  if (others.length) {
    const { preload } = await prompts({
      type: 'select', name: 'preload',
      message: `r/${subreddit} exists in other servers. Pre-load one as a template?`,
      choices: [{ title: 'No (start fresh)', value: '__none' }].concat(
        others.map(k => ({ title: `Use from ${k}`, value: k }))
      )
    });
    if (preload && preload !== '__none') {
      template = getSubredditFromServer(DATA_DIR, preload, subreddit);
    }
  }

  const initialType = template?.post?.type || 'self';
  const { ptype } = await prompts({
    type: 'select',
    name: 'ptype',
    message: 'Post type',
    choices: [
      { title: 'Self (text post with body)', value: 'self' },
                                  { title: 'Link (URL post; no body)', value: 'link' }
    ],
    initial: initialType === 'link' ? 1 : 0
  });

  const cfg = readServerConfig(DATA_DIR, serverKey);
  const serverDefaults = cfg?.defaults || defaultServerConfig(serverKey).defaults;

  let post = mergeDefaults(serverKey, {
    type: ptype || 'self',
    title: template?.post?.title || '',
    body: template?.post?.body || '',
    url: template?.post?.url || '',
    flair_id: template?.post?.flair_id || '',
    flair_text: template?.post?.flair_text || ''
  }, serverDefaults);
  let rules = template?.rules ? { ...template.rules } : defaultRules();

  const ask = [{ type: 'text', name: 'title', message: 'Title', initial: post.title || '' }];
  if ((ptype || 'self') === 'self') {
    ask.push({ type: 'text', name: 'body', message: 'Body (include invite)', initial: post.body || '' });
  } else {
    ask.push({ type: 'text', name: 'url', message: 'Link URL (invite URL recommended)', initial: post.url || '' });
  }
  ask.push({ type: 'number', name: 'cooldownDays', message: 'Cooldown (days, default 1):', initial: rules.cooldownDays ?? 1 });
  const postAns = await prompts(ask);
  post = { ...post, ...postAns };
  rules = { ...rules, cooldownDays: Number.isFinite(postAns.cooldownDays) ? postAns.cooldownDays : (rules.cooldownDays ?? 1) };

  const { wantFlair } = await prompts({ type: 'toggle', name: 'wantFlair', message: 'Fetch & choose a flair from Reddit?', initial: !!template?.post?.flair_id, active: 'yes', inactive: 'no' });
  if (wantFlair) {
    try {
      const flairs = await listLinkFlairs(subreddit);
      if (flairs.length) {
        const { flairPick } = await prompts({
          type: 'select',
          name: 'flairPick',
          message: 'Choose a flair',
          choices: [{ title: 'None', value: 'none' }].concat(flairs.map(f => ({ title: `${f.text || '(no text)'}`, value: f })))
        });
        if (flairPick && flairPick !== 'none') {
          post.flair_id = flairPick.id;
          if (flairPick.text_editable) {
            const { ft } = await prompts({ type: 'text', name: 'ft', message: 'Custom flair text (optional):', initial: post.flair_text || flairPick.text || '' });
            post.flair_text = ft || '';
          } else {
            post.flair_text = '';
          }
        } else {
          post.flair_id = ''; post.flair_text = '';
        }
      } else {
        console.log('No flairs available or subreddit restricts flair listing.');
      }
    } catch (e) {
      console.log(`Flair fetch failed: ${e.message}`);
    }
  }

  const entry = { key: subreddit, subreddit, rules, post };
  upsertSubreddit(DATA_DIR, serverKey, entry);
  console.log(`✔ Added r/${subreddit}`);

  const allServers = listServers(DATA_DIR).filter(s => serverKeyOf(s) !== serverKey);
  if (allServers.length) {
    const { doCopy } = await prompts({ type: 'toggle', name: 'doCopy', message: 'Copy this subreddit to other servers (into their Queues)?', initial: false, active: 'yes', inactive: 'no' });
    if (doCopy) {
      const { targets } = await prompts({
        type: 'multiselect',
        name: 'targets',
        message: 'Select target server(s)',
                                        choices: allServers.map(s => {
                                          const key = serverKeyOf(s);
                                          return { title: `${s.name || key} [${key}]`, value: key };
                                        })
      });
      if (targets && targets.length) {
        for (const t of targets) enqueueTemplate(DATA_DIR, t, entry);
        console.log(`✔ Queued for: ${targets.join(', ')}`);
      }
    }
  }
}

async function listSubredditsAction(serverKey) {
  const subs = listSubreddits(DATA_DIR, serverKey);
  if (!subs.length) { console.log('No subreddits.'); return; }
  subs.forEach(s => {
    const r = s.rules || {};
    const days = r.cooldownDays ?? 1;
    console.log(`- r/${s.subreddit}  type=${s.post?.type || 'self'}  cadence=${days}d  inviteRequired=${r.requirePermanentInvite !== false}`);
  });
}

async function selectSubredditFlow(serverKey) {
  const list = listSubreddits(DATA_DIR, serverKey);
  if (!list.length) { console.log('No subreddits.'); return; }
  const { key } = await prompts({
    type: 'select',
    name: 'key',
    message: 'Pick subreddit',
    choices: [{ title: 'Go back', value: '__back' }].concat(
      list.map(e => ({ title: `r/${e.subreddit}`, value: e.key || e.subreddit }))
    )
  });
  if (!key || key === '__back') return;
  const entry = list.find(e => (e.key || e.subreddit) === key);
  if (!entry) return;

  while (true) {
    const r = entry.rules || defaultRules();
    const p = entry.post || { type: 'self', title: '', body: '', url: '' };
    const summary =
    `r/${entry.subreddit}\n` +
    `- type: ${p.type}\n` +
    `- title: ${p.title}\n` +
    (p.type === 'self' ? `- body: ${p.body?.slice(0, 80) || ''}\n` : `- url: ${p.url}\n`) +
    `- flair_id: ${p.flair_id || '(none)'}  flair_text: ${p.flair_text || ''}\n` +
    `- cooldown: ${r.cooldownDays ?? 1} day(s); invite required: ${r.requirePermanentInvite !== false}`;

    console.log('\n' + summary + '\n');

    const { section } = await prompts({
      type: 'select',
      name: 'section',
      message: 'What would you like to do?',
      choices: [
        { title: 'Modify rules (cadence & invite requirement)', value: 'rules' },
                                      { title: 'Modify post (type/title/body/url)', value: 'post' },
                                      { title: 'Modify flair', value: 'flair' },
                                      { title: 'Copy this subreddit to other servers (enqueue templates)', value: 'copy' },
                                      { title: 'Go back', value: 'back' }
      ]
    });
    if (!section || section === 'back') break;

    if (section === 'rules') {
      const ans = await prompts([
        { type: 'number', name: 'cooldownDays', message: 'Cooldown (days):', initial: r.cooldownDays ?? 1 },
                                { type: 'toggle', name: 'requirePermanentInvite', message: 'Require permanent invite?', initial: r.requirePermanentInvite !== false, active: 'yes', inactive: 'no' }
      ]);
      entry.rules = {
        cooldownDays: Number.isFinite(ans.cooldownDays) ? ans.cooldownDays : (r.cooldownDays ?? 1),
        requirePermanentInvite: ans.requirePermanentInvite !== false
      };
    }

    if (section === 'post') {
      const { ptype } = await prompts({
        type: 'select',
        name: 'ptype',
        message: 'Post type',
        choices: [
          { title: 'Self (text post with body)', value: 'self' },
                                      { title: 'Link (URL post; no body)', value: 'link' }
        ],
        initial: p.type === 'link' ? 1 : 0
      });
      const ask = [{ type: 'text', name: 'title', message: 'Title', initial: p.title || '' }];
      if (ptype === 'link') {
        ask.push({ type: 'text', name: 'url', message: 'Link URL', initial: p.url || '' });
      } else {
        ask.push({ type: 'text', name: 'body', message: 'Body (include invite)', initial: p.body || '' });
      }
      const ans = await prompts(ask);
      entry.post = { ...p, type: ptype, ...ans };
    }

    if (section === 'flair') {
      const { fetchFlairs } = await prompts({ type: 'toggle', name: 'fetchFlairs', message: 'Fetch flairs from Reddit?', initial: true, active: 'yes', inactive: 'no' });
      if (fetchFlairs) {
        try {
          const flairs = await listLinkFlairs(entry.subreddit);
          if (flairs.length) {
            const { flairPick } = await prompts({
              type: 'select',
              name: 'flairPick',
              message: 'Choose flair',
              choices: [{ title: 'None', value: 'none' }].concat(flairs.map(f => ({ title: `${f.text || '(no text)'}`, value: f })))
            });
            if (flairPick && flairPick !== 'none') {
              entry.post = entry.post || {};
              entry.post.flair_id = flairPick.id;
              if (flairPick.text_editable) {
                const { ft } = await prompts({ type: 'text', name: 'ft', message: 'Custom flair text (optional):', initial: entry.post.flair_text || flairPick.text || '' });
                entry.post.flair_text = ft || '';
              } else {
                entry.post.flair_text = '';
              }
            } else {
              entry.post = entry.post || {};
              entry.post.flair_id = '';
              entry.post.flair_text = '';
            }
          } else {
            console.log('No flairs available or subreddit restricts flair listing.');
          }
        } catch (e) {
          console.log(`Flair fetch failed: ${e.message}`);
        }
      }
    }

    if (section === 'copy') {
      const servers = listServers(DATA_DIR).filter(s => serverKeyOf(s) !== serverKey);
      if (!servers.length) { console.log('No other servers exist.'); continue; }
      const { targets } = await prompts({
        type: 'multiselect',
        name: 'targets',
        message: 'Select target server(s) for queued templates',
                                        choices: servers.map(s => {
                                          const key = serverKeyOf(s);
                                          return { title: `${s.name || key} [${key}]`, value: key };
                                        })
      });
      if (targets && targets.length) {
        for (const t of targets) enqueueTemplate(DATA_DIR, t, entry);
        console.log(`✔ Queued for: ${targets.join(', ')}`);
      }
    }

    upsertSubreddit(DATA_DIR, serverKey, entry);
    console.log('✔ Saved');
  }
}

async function deleteSubredditAction(serverKey) {
  const list = listSubreddits(DATA_DIR, serverKey);
  if (!list.length) { console.log('No subreddits.'); return; }
  const { key } = await prompts({
    type: 'select',
    name: 'key',
    message: 'Pick subreddit to delete',
    choices: [{ title: 'Go back', value: '__back' }].concat(
      list.map(e => ({ title: `r/${e.subreddit}`, value: e.key || e.subreddit }))
    )
  });
  if (!key || key === '__back') return;
  const { yes } = await prompts({ type: 'toggle', name: 'yes', message: `Delete ${key}?`, initial: false, active: 'Yes', inactive: 'No' });
  if (!yes) return;
  deleteSubreddit(DATA_DIR, serverKey, key);
  console.log('✔ Deleted');
}

async function reviewQueueFlow(serverKey) {
  while (true) {
    const q = listQueue(DATA_DIR, serverKey);
    if (!q.length) { console.log('Queue is empty.'); return; }

    const { key } = await prompts({
      type: 'select',
      name: 'key',
      message: 'Queue — pick a subreddit to customize',
      choices: [{ title: 'Go back', value: '__back' }].concat(
        q.map(e => ({ title: `r/${e.subreddit}`, value: e.key || e.subreddit }))
      )
    });
    if (!key || key === '__back') return;

    const item = dequeueTemplate(DATA_DIR, serverKey, key);
    if (!item) continue;

    let done = false;
    while (!done) {
      const { step } = await prompts({
        type: 'select', name: 'step', message: `Customize r/${item.subreddit}`,
        choices: [
          { title: 'Rules (cadence & invite requirement)', value: 'rules' },
                                     { title: 'Post (type/title/body/url)', value: 'post' },
                                     { title: 'Flair', value: 'flair' },
                                     { title: 'Save & finish', value: 'finish' },
                                     { title: 'Cancel (requeue)', value: 'cancel' }
        ]
      });
      if (!step || step === 'finish') {
        upsertSubreddit(DATA_DIR, serverKey, item);
        console.log('✔ Promoted from queue to live list');
        done = true;
      } else if (step === 'cancel') {
        enqueueTemplate(DATA_DIR, serverKey, item);
        console.log('↩ Returned to queue');
        done = true;
      } else if (step === 'rules') {
        const r0 = item.rules || { cooldownDays: 1, requirePermanentInvite: true };
        const ans = await prompts([
          { type: 'number', name: 'cooldownDays', message: 'Cooldown (days):', initial: r0.cooldownDays ?? 1 },
                                  { type: 'toggle', name: 'requirePermanentInvite', message: 'Require permanent invite?', initial: r0.requirePermanentInvite !== false, active: 'yes', inactive: 'no' }
        ]);
        item.rules = { cooldownDays: Number.isFinite(ans.cooldownDays) ? ans.cooldownDays : (r0.cooldownDays ?? 1), requirePermanentInvite: ans.requirePermanentInvite !== false };
      } else if (step === 'post') {
        const p0 = item.post || { type: 'self', title: '', body: '', url: '' };
        const { ptype } = await prompts({
          type: 'select',
          name: 'ptype',
          message: 'Post type',
          choices: [
            { title: 'Self (text post with body)', value: 'self' },
                                        { title: 'Link (URL post; no body)', value: 'link' }
          ],
          initial: p0.type === 'link' ? 1 : 0
        });
        const ask = [{ type: 'text', name: 'title', message: 'Title', initial: p0.title || '' }];
        if (ptype === 'link') ask.push({ type: 'text', name: 'url', message: 'Link URL', initial: p0.url || '' });
        else ask.push({ type: 'text', name: 'body', message: 'Body (include invite)', initial: p0.body || '' });
        const ans = await prompts(ask);
        item.post = { ...p0, type: ptype, ...ans };
      } else if (step === 'flair') {
        try {
          const flairs = await listLinkFlairs(item.subreddit);
          if (flairs.length) {
            const { flairPick } = await prompts({
              type: 'select',
              name: 'flairPick',
              message: 'Choose flair',
              choices: [{ title: 'None', value: 'none' }].concat(flairs.map(f => ({ title: `${f.text || '(no text)'}`, value: f })))
            });
            if (flairPick && flairPick !== 'none') {
              item.post = item.post || {};
              item.post.flair_id = flairPick.id;
              if (flairPick.text_editable) {
                const { ft } = await prompts({ type: 'text', name: 'ft', message: 'Custom flair text (optional):', initial: item.post.flair_text || flairPick.text || '' });
                item.post.flair_text = ft || '';
              } else item.post.flair_text = '';
            } else {
              item.post = item.post || {};
              item.post.flair_id = '';
              item.post.flair_text = '';
            }
          } else {
            console.log('No flairs available or subreddit restricts flair listing.');
          }
        } catch (e) {
          console.log(`Flair fetch failed: ${e.message}`);
        }
      }
    }
  }
}

async function postNow(serverKey) {
  const { dry } = await prompts({ type: 'toggle', name: 'dry', message: 'Dry run?', initial: true, active: 'Yes', inactive: 'No' });
  const r = await fetch(`http://${CALLBACK_HOST}:${PORT}/v1/advertise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cryer-Key': KEY },
    body: JSON.stringify({ serverKey, dryRun: !!dry })
  });
  const json = await r.json();
  if (json?.status === 'throttled') {
    const until = new Date(json.throttleUntil).toLocaleString();
    console.log(RED(`Session throttled until ${until}`));
    const { sched } = await prompts({ type: 'toggle', name: 'sched', message: 'Schedule automatic post at that time?', initial: true, active: 'yes', inactive: 'no' });
    if (sched) {
      const r2 = await fetch(`http://${CALLBACK_HOST}:${PORT}/v1/schedule-advertise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cryer-Key': KEY },
        body: JSON.stringify({ serverKey, at: json.throttleUntil })
      });
      const j2 = await r2.json();
      if (j2?.ok) console.log('✔ Scheduled');
      else console.log('Failed to schedule:', j2?.error || r2.status);
    }
    return;
  }
  console.log(JSON.stringify(json, null, 2));
}

async function postAllServers() {
  const servers = listServers(DATA_DIR);
  for (const s of servers) {
    const key = serverKeyOf(s);
    console.log(BOLD(`\n=== Posting for ${s.name || key} [${key}] ===`));
    await postNow(key);
  }
}

async function syncServersFromSquire() {
  if (!SQUIRE_SERVERS_URL) { console.log('No SQUIRE_SERVERS_URL configured.'); return; }
  let data = null;
  try {
    if (SQUIRE_SERVERS_URL.startsWith('file://')) {
      const p = SQUIRE_SERVERS_URL.replace('file://', '');
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } else {
      const resp = await fetch(SQUIRE_SERVERS_URL, {
        headers: { 'User-Agent': 'cryerctl', 'X-Squire-Key': SQUIRE_SHARED_KEY }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    }
  } catch (e) {
    console.log(`Sync failed: ${e.message}`);
    return;
  }
  if (!Array.isArray(data)) { console.log('Unexpected payload. Expected an array of { key?, name }.'); return; }
  for (const it of data) {
    const name = it.name || it.key || 'server';
    const key = it.key || slugifyName(name);
    await ensureServerScaffold(DATA_DIR, key, name);
  }
  console.log('✔ Synced servers from Squire');
}

async function logsUI() {
  const exists = fs.existsSync(LOG_PATH);
  if (!exists) {
    console.log('No log file yet at:', LOG_PATH);
    return;
  }
  const { lines, follow } = await prompts([
    { type: 'number', name: 'lines', message: 'How many recent lines?', initial: 200, min: 1 },
    { type: 'toggle', name: 'follow', message: 'Follow (like tail -f)?', initial: true, active: 'yes', inactive: 'no' }
  ]);

  const dumpLast = (count) => {
    const buf = fs.readFileSync(LOG_PATH, 'utf8');
    const arr = buf.split(/\r?\n/).filter(Boolean);
    const slice = arr.slice(-count);
    for (const l of slice) console.log(l);
  };

    dumpLast(lines || 200);
    if (!follow) return;

    console.log(BOLD('\n--- Following; press Ctrl+C to exit ---\n'));
  const stream = fs.createReadStream(LOG_PATH, { encoding: 'utf8', flags: 'a+' });
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => console.log(line));
  fs.watch(LOG_PATH, { persistent: true }, () => {
    // trigger read by reopening stream (simple approach)
    stream.close();
    const s2 = fs.createReadStream(LOG_PATH, { encoding: 'utf8', flags: 'a+' });
    s2.on('data', chunk => process.stdout.write(chunk));
  });
}

// kick off
mainMenu().catch(e => {
  console.error(e);
  process.exit(1);
});
