import 'dotenv/config';

// ---- basics ----
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const UA = process.env.USER_AGENT || 'linux:cryer:v0.3.0 (by /u/unknown)';

function basicAuthHeader(id, secret) {
  const enc = Buffer.from(`${id}:${secret}`).toString('base64');
  return `Basic ${enc}`;
}

export async function getToken() {
  const {
    REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET,
    REDDIT_USERNAME,
    REDDIT_PASSWORD,
    REDDIT_REFRESH_TOKEN
  } = process.env;

  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
    throw new Error('Missing Reddit client id/secret');
  }

  // Preferred path: refresh token
  if (REDDIT_REFRESH_TOKEN) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REDDIT_REFRESH_TOKEN
    });
    const r = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': basicAuthHeader(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET),
                          'User-Agent': UA,
                          'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${JSON.stringify(json)}`);
    return json.access_token;
  }

  // Script app path
  if (!REDDIT_USERNAME || !REDDIT_PASSWORD) {
    throw new Error('Missing Reddit username/password for script app');
  }

  const params = new URLSearchParams({
    grant_type: 'password',
    username: REDDIT_USERNAME,
    password: REDDIT_PASSWORD
  });

  const resp = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET),
                           'User-Agent': UA,
                           'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`token error: ${resp.status} ${JSON.stringify(json)}`);
  return json.access_token;
}

// ---- submit & flair ----
// /api/submit supports link vs self posts via 'kind' plus url/text. Official behavior. :contentReference[oaicite:4]{index=4}
export async function submitPost(accessToken, { sr, kind, title, text, url, flair_id, flair_text }) {
  const params = new URLSearchParams({ sr, kind, title, api_type: 'json' });
  if (kind === 'self') params.append('text', text || '');
  if (kind === 'link') params.append('url', url || '');
  if (flair_id) params.append('flair_id', flair_id);
  if (flair_text) params.append('flair_text', flair_text);

  const resp = await fetch('https://oauth.reddit.com/api/submit', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  const json = await resp.json();
  if (!resp.ok || json?.json?.errors?.length) {
    throw new Error(`submit failed: ${resp.status} ${JSON.stringify(json?.json?.errors || json)}`);
  }
  // Some responses don’t include permalink/id; we’ll resolve it below if needed. :contentReference[oaicite:5]{index=5}
  const data = json?.json?.data || {};
  return { json: data, headers: resp.headers };
}

// Fetch available flairs. Uses link_flair_v2 when available. :contentReference[oaicite:6]{index=6}
export async function listLinkFlairs(subreddit) {
  const accessToken = await getToken();
  const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/api/link_flair_v2`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': UA }
  });
  if (!resp.ok) return [];
  const arr = await resp.json();
  if (!Array.isArray(arr)) return [];
  return arr.map(t => ({
    id: t.id, text: t.text, text_editable: !!t.text_editable
  }));
}

// ---- rate limit ----
export async function rateLimitPause(resp) {
  try {
    const h = resp?.headers; if (!h || !h.get) return;
    const parse = (x) => {
      if (!x) return NaN;
      const first = String(x).split(',')[0].trim();
      return parseFloat(first);
    };
    const remaining = parse(h.get('x-ratelimit-remaining'));
    const reset = parse(h.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining) && Number.isFinite(reset) && remaining < 2 && reset > 0) {
      await sleep((Math.ceil(reset) + 1) * 1000);
    }
  } catch {}
}

// ---- lookups for monitoring & post-submit resolution ----

// id form: bare base36 like "abc123". We call /api/info?id=t3_<id> . :contentReference[oaicite:7]{index=7}
export async function fetchSubmissionInfo(idOrFullname) {
  const accessToken = await getToken();
  const fullname = idOrFullname.startsWith('t3_') ? idOrFullname : `t3_${idOrFullname}`;
  const url = `https://oauth.reddit.com/api/info?id=${encodeURIComponent(fullname)}&raw_json=1`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': UA }
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  const thing = json?.data?.children?.[0]?.data;
  return thing || null;
}

// After submit, if the API didn’t return id/permalink, look at our own user’s recent submissions.
// Uses standard listing under /user/{name}/submitted. :contentReference[oaicite:8]{index=8}
export async function resolveRecentSubmission(subreddit, title, sinceEpochMs = Date.now() - 10 * 60 * 1000) {
  const accessToken = await getToken();
  const user = process.env.REDDIT_USERNAME;
  if (!user) return null;
  const url = `https://oauth.reddit.com/user/${encodeURIComponent(user)}/submitted?limit=10`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': UA }
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  const items = json?.data?.children || [];
  for (const it of items) {
    const d = it?.data;
    if (!d) continue;
    if (d.subreddit?.toLowerCase() === subreddit.toLowerCase()
      && d.title?.trim() === title?.trim()
      && (d.created_utc * 1000) >= sinceEpochMs) {
      return { id: d.id, permalink: d.permalink || d.url };
      }
  }
  return null;
}

// Interpret removal. Field is visible to non-mods too. :contentReference[oaicite:9]{index=9}
export function classifyRemoval(thing) {
  const cat = (thing?.removed_by_category || '').toLowerCase();
  if (!cat) return { removed: false, category: null };
  if (['moderator','automod_filtered','content_takedown','copyright_takedown','legal'].includes(cat)) {
    return { removed: true, category: cat };
  }
  if (cat === 'deleted') { // author deleted
    return { removed: true, category: 'deleted' };
  }
  return { removed: true, category: cat };
}
