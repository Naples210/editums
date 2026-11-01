// Editums publishing server: connects social accounts and publishes scheduled posts.
// Zero dependencies (Node 20+). Reads settings from environment variables, see .env.example.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const env = (k, d) => process.env[k] || d;
const CFG = {
  port: Number(env('PORT', 8080)),
  espoUrl: env('ESPO_URL', 'https://api.espobase.com/project/em28cq3dw9').replace(/\/$/, ''),
  espoPublishable: env('ESPO_PUBLISHABLE_KEY', ''),
  espoSecret: env('ESPO_SECRET_KEY', ''),
  tokenKey: env('TOKEN_KEY', ''),
  publicUrl: env('PUBLIC_URL', 'https://api.editums.com').replace(/\/$/, ''),
  appUrl: env('APP_URL', 'https://editums.com').replace(/\/$/, ''),
  origins: env('ALLOWED_ORIGINS', 'https://editums.com,https://www.editums.com,https://editums.espohost.com').split(',').map(s => s.trim()),
  tickSeconds: Number(env('TICK_SECONDS', 60)),
  plugMinutes: Number(env('PLUG_MINUTES', 10)),
  feedMinutes: Number(env('FEED_MINUTES', 15)),
  mediaDir: env('MEDIA_DIR', '/data/media'),
  anthropicKey: env('ANTHROPIC_API_KEY', ''),
  claudeModel: env('CLAUDE_MODEL', 'claude-opus-5-5'),
  falKey: env('FAL_KEY', ''),
  falImageModel: env('FAL_IMAGE_MODEL', 'fal-ai/flux/dev'),
  falVideoModel: env('FAL_VIDEO_MODEL', 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video'),
  falSpeechModel: env('FAL_SPEECH_MODEL', 'fal-ai/whisper'),
  falQueueUrl: env('FAL_QUEUE_URL', 'https://queue.fal.run').replace(/\/$/, ''),
};
for (const k of ['espoPublishable', 'espoSecret', 'tokenKey']) if (!CFG[k]) { console.error(`Missing setting: ${k}. See .env.example.`); process.exit(1); }
if (!/^[0-9a-f]{64}$/i.test(CFG.tokenKey)) { console.error('TOKEN_KEY must be 64 hex characters (openssl rand -hex 32).'); process.exit(1); }
const KEY = Buffer.from(CFG.tokenKey, 'hex');

// Token encryption (AES-256-GCM), so a database leak alone doesn't expose account tokens.
function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function unseal(s) {
  const [iv, tag, data] = s.split('.').map(p => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

// Espobase REST with the secret key (server only; bypasses row level security).
async function db(path, { method = 'GET', body, prefer } = {}) {
  const h = { apikey: CFG.espoSecret, 'content-type': 'application/json' };
  if (prefer) h.prefer = prefer;
  const r = await fetch(CFG.espoUrl + '/rest/v1/' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  if (!r.ok) throw new Error(`db ${method} ${path.split('?')[0]}: ${(j && (j.message || j.error)) || r.status}`);
  return j;
}
const q = encodeURIComponent;

// Who is calling: checks the user's Espobase access token.
async function authUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) throw httpError(401, 'Sign in first.');
  const r = await fetch(CFG.espoUrl + '/auth/v1/user', { headers: { apikey: CFG.espoPublishable, authorization: 'Bearer ' + m[1] } });
  if (!r.ok) throw httpError(401, 'Your session expired. Sign in again.');
  const j = await r.json(); const u = j.user || j;
  if (!u || !u.id) throw httpError(401, 'Sign in first.');
  return u;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 64 * 1024) throw httpError(413, 'Request too large.'); chunks.push(c); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw httpError(400, 'Invalid JSON.'); }
}
async function fetchJson(url, opt = {}) {
  const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  return { ok: r.ok, status: r.status, json: j, text: t };
}

async function saveChannel(userId, ch, secret) {
  const [row] = await db('channels', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, ...ch } });
  await db('channel_tokens', { method: 'POST', prefer: 'return=minimal', body: { channel_id: row.id, data: seal(secret) } });
  return row;
}

// ---------- Bluesky (app password) ----------
const BSKY_DEFAULT = 'https://bsky.social';
async function bskyConnect(userId, { identifier, password, service }) {
  identifier = String(identifier || '').trim().replace(/^@/, ''); password = String(password || '').trim();
  service = String(service || BSKY_DEFAULT).trim().replace(/\/$/, '');
  if (!identifier || !password) throw httpError(400, 'Enter your Bluesky handle and an app password.');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(service)) throw httpError(400, 'Invalid Bluesky server.');
  const s = await fetchJson(service + '/xrpc/com.atproto.server.createSession', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier, password }) });
  if (!s.ok) throw httpError(400, 'Bluesky rejected that handle or app password.');
  const { did, handle, accessJwt, refreshJwt } = s.json;
  const p = await fetchJson(service + '/xrpc/app.bsky.actor.getProfile?actor=' + q(did), { headers: { authorization: 'Bearer ' + accessJwt } });
  return saveChannel(userId, { provider: 'bluesky', handle, display_name: p.json?.displayName || handle, avatar_url: p.json?.avatar || null, instance: service, external_id: did },
    { service, did, accessJwt, refreshJwt });
}
function bskyFacets(text) {
  // Link facets need UTF-8 byte offsets.
  const facets = [], re = /https?:\/\/[^\s)\]]+/g; let m;
  while ((m = re.exec(text))) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const start = Buffer.byteLength(text.slice(0, m.index)), end = start + Buffer.byteLength(url);
    facets.push({ index: { byteStart: start, byteEnd: end }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] });
  }
  return facets;
}
// Retries once with a refreshed session when Bluesky says the access token expired.
async function bskyCall(channel, secret, make) {
  let r = await make();
  if (!r.ok && (r.status === 400 || r.status === 401) && /expired|token/i.test(r.text)) {
    const ref = await fetchJson(secret.service + '/xrpc/com.atproto.server.refreshSession', { method: 'POST', headers: { authorization: 'Bearer ' + secret.refreshJwt } });
    if (!ref.ok) throw new Error('Bluesky sign-in expired. Reconnect the channel.');
    secret.accessJwt = ref.json.accessJwt; secret.refreshJwt = ref.json.refreshJwt;
    await db('channel_tokens?channel_id=eq.' + q(channel.id), { method: 'PATCH', prefer: 'return=minimal', body: { data: seal(secret), updated_at: new Date().toISOString() } });
    r = await make();
  }
  return r;
}
async function bskyPublish(channel, secret, post) {
  const text = post.caption || '';
  if ([...new Intl.Segmenter().segment(text)].length > 300) throw new Error('Bluesky posts are limited to 300 characters.');
  const call = make => bskyCall(channel, secret, make);
  const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), langs: ['en'] };
  const facets = bskyFacets(text); if (facets.length) record.facets = facets;
  const files = (await loadPostMedia(post)).slice(0, 4);
  if (files.length) {
    const images = [];
    for (const f of files) {
      if (f.data.length > 1000000) throw new Error('An image is larger than Bluesky’s 1 MB limit.');
      const up = await call(() => fetchJson(secret.service + '/xrpc/com.atproto.repo.uploadBlob', { method: 'POST', headers: { 'content-type': f.type, authorization: 'Bearer ' + secret.accessJwt }, body: f.data }));
      if (!up.ok) throw new Error('Bluesky image upload: ' + (up.json?.message || up.status));
      images.push({ alt: f.alt || '', image: up.json.blob, ...(f.width && f.height ? { aspectRatio: { width: f.width, height: f.height } } : {}) });
    }
    record.embed = { $type: 'app.bsky.embed.images', images };
  }
  const r = await call(() => fetchJson(secret.service + '/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret.accessJwt }, body: JSON.stringify({ repo: secret.did, collection: 'app.bsky.feed.post', record }) }));
  if (!r.ok) throw new Error('Bluesky: ' + (r.json?.message || r.status));
  const rkey = r.json.uri.split('/').pop();
  return `https://bsky.app/profile/${channel.handle || secret.did}/post/${rkey}`;
}

// ---------- Mastodon (OAuth) ----------
const MASTO_SCOPES = 'read:accounts write:statuses write:media';
const mastoRedirect = () => CFG.publicUrl + '/v1/oauth/mastodon/callback';
function mastoHost(s) {
  const h = String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw httpError(400, 'Enter your Mastodon server, for example mastodon.social.');
  return h;
}
async function mastoStart(userId, { instance }) {
  const host = mastoHost(instance);
  const app = await fetchJson(`https://${host}/api/v1/apps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Editums', redirect_uris: mastoRedirect(), scopes: MASTO_SCOPES, website: CFG.appUrl }) });
  if (!app.ok || !app.json?.client_id) throw httpError(400, `Couldn't reach ${host}. Check the server name.`);
  const state = crypto.randomBytes(24).toString('base64url');
  await db('oauth_states', { method: 'POST', prefer: 'return=minimal', body: { state, user_id: userId, provider: 'mastodon', data: { host, client_id: app.json.client_id, client_secret: app.json.client_secret } } });
  const u = new URL(`https://${host}/oauth/authorize`);
  u.search = new URLSearchParams({ client_id: app.json.client_id, redirect_uri: mastoRedirect(), response_type: 'code', scope: MASTO_SCOPES, state }).toString();
  return { url: u.toString() };
}
async function mastoCallback(params) {
  const state = params.get('state'), code = params.get('code');
  if (!state || !code) throw new Error(params.get('error_description') || 'Mastodon sign-in was cancelled.');
  const [st] = await db('oauth_states?state=eq.' + q(state) + '&select=*');
  if (!st) throw new Error('This sign-in link expired. Try connecting again.');
  await db('oauth_states?state=eq.' + q(state), { method: 'DELETE', prefer: 'return=minimal' });
  if (Date.now() - new Date(st.created_at).getTime() > 15 * 60 * 1000) throw new Error('This sign-in link expired. Try connecting again.');
  const { host, client_id, client_secret } = st.data;
  const tok = await fetchJson(`https://${host}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, client_id, client_secret, redirect_uri: mastoRedirect(), scope: MASTO_SCOPES }) });
  if (!tok.ok || !tok.json?.access_token) throw new Error('Mastodon didn’t accept the sign-in. Try again.');
  const me = await fetchJson(`https://${host}/api/v1/accounts/verify_credentials`, { headers: { authorization: 'Bearer ' + tok.json.access_token } });
  if (!me.ok) throw new Error('Couldn’t read your Mastodon account.');
  await saveChannel(st.user_id, { provider: 'mastodon', handle: `@${me.json.username}@${host}`, display_name: me.json.display_name || me.json.username, avatar_url: me.json.avatar || null, instance: host, external_id: String(me.json.id) },
    { host, accessToken: tok.json.access_token });
}
async function mastoPublish(channel, secret, post) {
  const media_ids = [];
  for (const f of (await loadPostMedia(post)).slice(0, 4)) {
    const form = new FormData(); form.append('file', new Blob([f.data], { type: f.type }), f.name || 'image'); if (f.alt) form.append('description', f.alt);
    const up = await fetchJson(`https://${secret.host}/api/v2/media`, { method: 'POST', headers: { authorization: 'Bearer ' + secret.accessToken }, body: form });
    if (!up.ok || !up.json?.id) throw new Error('Mastodon image upload: ' + (up.json?.error || up.status));
    media_ids.push(up.json.id);
  }
  const r = await fetchJson(`https://${secret.host}/api/v1/statuses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret.accessToken, 'idempotency-key': post.id }, body: JSON.stringify({ status: post.caption || '', ...(media_ids.length ? { media_ids } : {}) }) });
  if (r.status === 401) throw new Error('Mastodon sign-in expired. Reconnect the channel.');
  if (!r.ok) throw new Error('Mastodon: ' + (r.json?.error || r.status));
  return r.json.url;
}

const PUBLISHERS = { bluesky: bskyPublish, mastodon: mastoPublish };

// ---------- Media (images uploaded from the browser, kept on this server) ----------
const MEDIA_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const SERVE_TYPES = { ...MEDIA_TYPES, 'video/mp4': 'mp4', 'audio/mpeg': 'mp3' };
const MEDIA_ID = /^[0-9a-f-]{36}$/i;
async function saveMedia(userId, req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!MEDIA_TYPES[type]) throw httpError(415, 'Only JPG, PNG, WebP and GIF images can be published for now.');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) throw httpError(413, 'Images must be under 5 MB.'); chunks.push(c); }
  if (!size) throw httpError(400, 'Empty image.');
  const id = crypto.randomUUID();
  const meta = { user: userId, type, name: String(req.headers['x-file-name'] || '').slice(0, 120), width: Number(req.headers['x-width']) || null, height: Number(req.headers['x-height']) || null, created: new Date().toISOString() };
  await fs.mkdir(CFG.mediaDir, { recursive: true });
  await fs.writeFile(path.join(CFG.mediaDir, id + '.bin'), Buffer.concat(chunks));
  await fs.writeFile(path.join(CFG.mediaDir, id + '.json'), JSON.stringify(meta));
  return { id };
}
async function storeMediaBuffer(userId, data, type, extra = {}) {
  const id = crypto.randomUUID();
  await fs.mkdir(CFG.mediaDir, { recursive: true });
  await fs.writeFile(path.join(CFG.mediaDir, id + '.bin'), data);
  await fs.writeFile(path.join(CFG.mediaDir, id + '.json'), JSON.stringify({ user: userId, type, created: new Date().toISOString(), ...extra }));
  return id;
}
async function serveMedia(req, res, id, origin) {
  if (!MEDIA_ID.test(id)) throw httpError(404, 'Not found.');
  let meta, size;
  const file = path.join(CFG.mediaDir, id + '.bin');
  try { meta = JSON.parse(await fs.readFile(path.join(CFG.mediaDir, id + '.json'), 'utf8')); size = (await fs.stat(file)).size; }
  catch { throw httpError(404, 'Not found.'); }
  if (!SERVE_TYPES[meta.type] || meta.source) throw httpError(404, 'Not found.');
  const h = { 'content-type': meta.type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400', 'access-control-allow-origin': origin || CFG.appUrl, vary: 'Origin', 'x-content-type-options': 'nosniff' };
  // Videos need byte ranges to play in Safari and to seek.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    status = 206; h['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  h['content-length'] = end - start + 1;
  res.writeHead(status, h);
  if (req.method === 'HEAD') return res.end();
  await pipeline(createReadStream(file, { start, end }), res).catch(() => {});
}
async function loadPostMedia(post) {
  const out = [];
  for (const m of Array.isArray(post.media) ? post.media : []) {
    if (!m || !MEDIA_ID.test(m.serverId || '')) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(CFG.mediaDir, m.serverId + '.json'), 'utf8'));
      if (meta.user !== post.user_id) continue;
      out.push({ ...meta, alt: m.alt || '', data: await fs.readFile(path.join(CFG.mediaDir, m.serverId + '.bin')) });
    } catch { throw new Error('An image for this post is missing. Open the post and save it again.'); }
  }
  return out;
}

// ---------- Publishing ----------
async function publishPost(post) {
  if (!post.channel_id) throw new Error('Pick a connected channel to publish to.');
  if (!String(post.caption || '').trim()) throw new Error('The post has no text.');
  const [channel] = await db('channels?id=eq.' + q(post.channel_id) + '&user_id=eq.' + q(post.user_id) + '&select=*');
  if (!channel) throw new Error('That channel is no longer connected.');
  const [tok] = await db('channel_tokens?channel_id=eq.' + q(channel.id) + '&select=data');
  if (!tok) throw new Error('Reconnect this channel.');
  const fn = PUBLISHERS[channel.provider];
  if (!fn) throw new Error(`Publishing to ${channel.provider} isn’t available yet.`);
  return fn(channel, unseal(tok.data), post);
}
async function runPost(post) {
  // Claim the post first so two runs never publish it twice.
  const claimed = await db(`posts?id=eq.${q(post.id)}&status=in.(scheduled,publishing_now)`, { method: 'PATCH', prefer: 'return=representation', body: { status: 'publishing' } });
  if (!claimed?.length) return null;
  try {
    const url = await publishPost(post);
    await db('posts?id=eq.' + q(post.id), { method: 'PATCH', prefer: 'return=minimal', body: { status: 'published', published_at: new Date().toISOString(), external_url: url, last_error: null } });
    console.log('published', post.id, url);
    return { status: 'published', url };
  } catch (e) {
    await db('posts?id=eq.' + q(post.id), { method: 'PATCH', prefer: 'return=minimal', body: { status: 'failed', last_error: String(e.message).slice(0, 500) } });
    console.warn('failed', post.id, e.message);
    return { status: 'failed', error: e.message };
  }
}
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const due = await db(`posts?status=eq.scheduled&publish_at=lte.${q(new Date().toISOString())}&select=*&order=publish_at.asc&limit=25`);
    for (const p of due || []) await runPost(p);
  } catch (e) { console.warn('tick', e.message); } finally { ticking = false; }
}

// ---------- Plugs: act on published posts when they reach a milestone ----------
const PLUG_METRICS = { likes: 'likes', comments: 'replies', reposts: 'reposts' };
function bskyPostUri(channel, url) { const rkey = /\/post\/([^/?#]+)/.exec(url || '')?.[1]; return rkey && channel.external_id ? `at://${channel.external_id}/app.bsky.feed.post/${rkey}` : null; }
const mastoStatusId = url => /\/(\d+)(?:[/?#]|$)/.exec(url || '')?.[1] || null;
const PLUG_DRIVERS = {
  bluesky: {
    async stats(ch, secret, post) {
      const uri = bskyPostUri(ch, post.external_url); if (!uri) return null;
      const r = await bskyCall(ch, secret, () => fetchJson(secret.service + '/xrpc/app.bsky.feed.getPosts?uris=' + q(uri), { headers: { authorization: 'Bearer ' + secret.accessJwt } }));
      const p = r.json?.posts?.[0]; if (!r.ok || !p) return null;
      return { likes: p.likeCount || 0, replies: p.replyCount || 0, reposts: (p.repostCount || 0) + (p.quoteCount || 0), ref: { uri: p.uri, cid: p.cid } };
    },
    async comment(ch, secret, post, st, text) {
      const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), reply: { root: st.ref, parent: st.ref } };
      const f = bskyFacets(text); if (f.length) record.facets = f;
      const r = await bskyCall(ch, secret, () => fetchJson(secret.service + '/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret.accessJwt }, body: JSON.stringify({ repo: secret.did, collection: 'app.bsky.feed.post', record }) }));
      if (!r.ok) throw new Error('Bluesky: ' + (r.json?.message || r.status));
    },
    async repost(ch, secret, post, st) {
      const record = { $type: 'app.bsky.feed.repost', subject: st.ref, createdAt: new Date().toISOString() };
      const r = await bskyCall(ch, secret, () => fetchJson(secret.service + '/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret.accessJwt }, body: JSON.stringify({ repo: secret.did, collection: 'app.bsky.feed.repost', record }) }));
      if (!r.ok) throw new Error('Bluesky: ' + (r.json?.message || r.status));
    },
  },
  mastodon: {
    async stats(ch, secret, post) {
      const id = mastoStatusId(post.external_url); if (!id) return null;
      // Public read: the token only has write scopes for statuses.
      const r = await fetchJson(`https://${secret.host}/api/v1/statuses/${id}`);
      if (!r.ok) return null;
      return { likes: r.json.favourites_count || 0, replies: r.json.replies_count || 0, reposts: r.json.reblogs_count || 0, ref: { id } };
    },
    async comment(ch, secret, post, st, text) {
      const r = await fetchJson(`https://${secret.host}/api/v1/statuses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret.accessToken, 'idempotency-key': 'plug-' + post.id + '-' + st.plugId }, body: JSON.stringify({ status: text, in_reply_to_id: st.ref.id }) });
      if (!r.ok) throw new Error('Mastodon: ' + (r.json?.error || r.status));
    },
    async repost(ch, secret, post, st) {
      const r = await fetchJson(`https://${secret.host}/api/v1/statuses/${st.ref.id}/reblog`, { method: 'POST', headers: { authorization: 'Bearer ' + secret.accessToken } });
      if (!r.ok) throw new Error('Mastodon: ' + (r.json?.error || r.status));
    },
  },
};
const notify = (userId, title, body, url) => db('notifications', { method: 'POST', prefer: 'return=minimal', body: { user_id: userId, title, body: String(body || '').slice(0, 300), url: url || null } }).catch(e => console.warn('notify', e.message));
let plugging = false;
async function runPlugs() {
  if (plugging) return; plugging = true;
  try {
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    for (const row of await db('app_data?key=eq.plugs&select=user_id,value') || []) {
      const plugs = (Array.isArray(row.value) ? row.value : []).filter(p => p && p.id && p.on !== false && PLUG_METRICS[p.metric] && Number(p.count) > 0);
      if (!plugs.length) continue;
      const channels = await db(`channels?user_id=eq.${q(row.user_id)}&status=eq.active&select=*`) || [];
      const stats = new Map();
      for (const plug of plugs) {
        const ch = channels.find(c => c.handle === plug.channel || c.display_name === plug.channel || c.id === plug.channel);
        const drv = ch && PLUG_DRIVERS[ch.provider]; if (!drv) continue;
        const posts = await db(`posts?user_id=eq.${q(row.user_id)}&channel_id=eq.${q(ch.id)}&status=eq.published&published_at=gte.${q(since)}&external_url=not.is.null&select=id,caption,external_url&order=published_at.desc&limit=30`) || [];
        if (!posts.length) continue;
        const done = new Set((await db(`plug_runs?plug_id=eq.${q(plug.id)}&select=post_id`) || []).map(r => r.post_id));
        let secret;
        for (const post of posts) {
          if (done.has(post.id)) continue;
          try {
            if (!secret) { const [tok] = await db('channel_tokens?channel_id=eq.' + q(ch.id) + '&select=data'); if (!tok) break; secret = unseal(tok.data); }
            if (!stats.has(post.id)) stats.set(post.id, await drv.stats(ch, secret, post));
            const st = stats.get(post.id);
            const value = st?.[PLUG_METRICS[plug.metric]] ?? 0;
            if (!st || value < Number(plug.count)) continue;
            // Claim first so a plug never fires twice for the same post.
            const claim = await fetch(CFG.espoUrl + '/rest/v1/plug_runs', { method: 'POST', headers: { apikey: CFG.espoSecret, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ plug_id: plug.id, post_id: post.id }) });
            if (!claim.ok) continue;
            const what = `${value} ${plug.metric} on “${String(post.caption || '').slice(0, 60)}”`;
            if (plug.action === 'Auto-comment' && String(plug.text || '').trim()) { await drv.comment(ch, secret, post, { ...st, plugId: plug.id }, String(plug.text).trim().slice(0, 290)); await notify(row.user_id, 'Plug commented on your post', what, post.external_url); }
            else if (plug.action === 'Auto-repost') { await drv.repost(ch, secret, post, st); await notify(row.user_id, 'Plug reposted your post', what, post.external_url); }
            else await notify(row.user_id, `Your post reached ${plug.count} ${plug.metric}`, what, post.external_url);
            console.log('plug', plug.id, plug.action, post.id);
          } catch (e) { console.warn('plug', plug.id, post.id, e.message); }
        }
      }
    }
  } catch (e) { console.warn('plugs', e.message); } finally { plugging = false; }
}

// ---------- Auto post from RSS / Atom feeds ----------
const dns = require('node:dns').promises;
const net = require('node:net');
function privateAddress(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const v = ip.toLowerCase(); return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || (v.startsWith('::ffff:') && privateAddress(v.slice(7)));
}
// Fetches a public URL only (feeds are user input, so never reach this server's private network).
async function fetchPublic(url, maxBytes, accept) {
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Feed links must start with http or https.');
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(`Couldn’t find ${u.hostname}.`);
    if (addrs.some(a => privateAddress(a.address))) throw new Error('That address isn’t allowed.');
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'EditumsBot/1.0 (+https://editums.com)', accept } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), u).toString(); continue; }
    if (!r.ok) throw new Error(`The feed answered ${r.status}.`);
    const chunks = []; let size = 0;
    for await (const c of r.body) { size += c.length; if (size > maxBytes) throw new Error('The file is too large.'); chunks.push(c); }
    return { data: Buffer.concat(chunks), type: (r.headers.get('content-type') || '').split(';')[0].trim() };
  }
  throw new Error('Too many redirects.');
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m));
const stripHtml = s => decode(decode(s).replace(/<\/?(p|br|div|li|ul|ol|h[1-6]|blockquote|tr|td)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1] : ''; };
const attr = (el, name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(el)?.[1] || '';
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 50)) {
    let link = stripHtml(tag(b, 'link'));
    if (!link) { const links = b.match(/<link\b[^>]*>/gi) || []; const alt = links.find(l => !/rel=/i.test(l) || /rel=["']alternate["']/i.test(l)) || links[0]; link = alt ? decode(attr(alt, 'href')) : ''; }
    const title = stripHtml(tag(b, 'title'));
    const description = stripHtml(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content')).slice(0, 600);
    const guid = stripHtml(tag(b, 'guid') || tag(b, 'id')) || link || title;
    const when = Date.parse(stripHtml(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'))) || null;
    let image = '';
    for (const el of b.match(/<(?:enclosure|media:content|media:thumbnail)\b[^>]*>/gi) || []) {
      const u = decode(attr(el, 'url')), t = attr(el, 'type'), medium = attr(el, 'medium');
      if (u && (/^image\//.test(t) || medium === 'image' || /media:thumbnail/i.test(el) || (!t && /\.(jpe?g|png|webp)(\?|$)/i.test(u)))) { image = u; break; }
    }
    if (!image) image = decode(/<img[^>]+src=["']([^"']+)["']/i.exec(decode(tag(b, 'content:encoded') || tag(b, 'description') || tag(b, 'content')))?.[1] || '');
    if (guid && (title || link)) items.push({ guid: guid.slice(0, 500), title, link, description, when, image: /^https?:\/\//.test(image) ? image : '' });
  }
  return items;
}
const CAPTION_LIMIT = { bluesky: 300, mastodon: 500 };
const graphemes = s => [...new Intl.Segmenter().segment(s)].length;
function feedCaption(template, item, limit) {
  const fill = (title, desc) => (template || '{title} {url}').replace(/\{title\}/g, title).replace(/\{url\}/g, item.link || '').replace(/\{description\}/g, desc).replace(/[ \t]+\n/g, '\n').trim();
  let title = item.title, desc = item.description, out = fill(title, desc);
  const cut = (s, n) => { const g = [...new Intl.Segmenter().segment(s)].map(x => x.segment); return n <= 1 ? '' : g.length > n ? g.slice(0, n - 1).join('').trimEnd() + '…' : s; };
  if (!limit || graphemes(out) <= limit) return out;
  desc = cut(desc, Math.max(0, graphemes(desc) - (graphemes(out) - limit))); out = fill(title, desc);
  if (graphemes(out) > limit) { title = cut(title, Math.max(0, graphemes(title) - (graphemes(out) - limit))); out = fill(title, desc); }
  return graphemes(out) > limit ? cut(out, limit) : out;
}
async function feedImage(userId, url) {
  try {
    const { data, type } = await fetchPublic(url, 8 * 1024 * 1024, 'image/*');
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const src = mediaFile(crypto.randomUUID(), 'img'), out = crypto.randomUUID();
    await fs.writeFile(src, data);
    try { await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", '-q:v', '4', '-f', 'mjpeg', mediaFile(out)], 60000); }
    finally { await fs.rm(src, { force: true }); }
    const size = (await fs.stat(mediaFile(out))).size;
    if (size > 950000) { await fs.rm(mediaFile(out), { force: true }); return null; }
    await fs.writeFile(mediaFile(out, 'json'), JSON.stringify({ user: userId, type: 'image/jpeg', name: 'feed-image.jpg', created: new Date().toISOString() }));
    return { id: crypto.randomUUID(), serverId: out, name: 'feed-image.jpg', type: 'image/jpeg', size };
  } catch (e) { console.warn('feed image', e.message); return null; }
}
function localSlot(tz, d = new Date()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
  } catch { return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; }
}
const feedStateFile = () => path.join(CFG.mediaDir, 'feeds-state.json');
async function loadFeedState() { try { return JSON.parse(await fs.readFile(feedStateFile(), 'utf8')); } catch { return {}; } }
async function saveFeedState(st) { await fs.mkdir(CFG.mediaDir, { recursive: true }); await fs.writeFile(feedStateFile() + '.tmp', JSON.stringify(st)); await fs.rename(feedStateFile() + '.tmp', feedStateFile()); }

// Checks one user's feeds. New items become drafts or scheduled posts, one per chosen channel.
async function runFeedsFor(userId, feeds, state) {
  const report = [];
  const channels = await db(`channels?user_id=eq.${q(userId)}&status=eq.active&select=*`) || [];
  const [pref] = await db(`preferences?user_id=eq.${q(userId)}&select=timezone`).catch(() => []) || [];
  for (const feed of feeds) {
    const r = { id: feed.id, url: feed.url, created: 0 };
    report.push(r);
    try {
      const { data } = await fetchPublic(String(feed.url), 3 * 1024 * 1024, 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5');
      const items = parseFeed(data.toString('utf8'));
      if (!items.length) throw new Error('No articles found. Is this an RSS or Atom feed link?');
      const st = state[feed.id] || (state[feed.id] = { seen: [] });
      const seen = new Set(st.seen), fresh = items.filter(i => !seen.has(i.guid));
      let toPost = fresh;
      if (!st.started) {
        // First check: don't flood the calendar with the archive. Only the newest article, if it's from the last 48 hours.
        st.started = new Date().toISOString();
        const newest = [...items].sort((a, b) => (b.when || 0) - (a.when || 0))[0];
        toPost = newest && newest.when && Date.now() - newest.when < 48 * 3600 * 1000 ? [newest] : [];
      }
      toPost = toPost.slice(0, 5).reverse();
      const targets = channels.filter(c => (feed.channels || []).includes(c.handle) || (feed.channels || []).includes(c.display_name));
      const publish = /automatic/i.test(feed.mode || '');
      for (const item of toPost) {
        const img = item.image ? await feedImage(userId, item.image) : null;
        const slot = localSlot(pref?.timezone);
        const rows = (targets.length ? targets : [null]).map(c => ({
          user_id: userId, caption: feedCaption(feed.template, item, c ? CAPTION_LIMIT[c.provider] : 0),
          channel: c ? c.handle : ((feed.channels || [])[0] || 'Bluesky'), channel_id: c ? c.id : null, scheduled_day: slot.day, scheduled_hour: slot.hour,
          status: publish && c ? 'scheduled' : 'draft', publish_at: publish && c ? new Date().toISOString() : null,
          media: img ? [img] : [], ai_briefs: { tag: 'RSS' },
        }));
        await db('posts', { method: 'POST', prefer: 'return=minimal', body: rows });
        r.created += rows.length;
        await notify(userId, publish && targets.length ? 'Publishing a new article from your feed' : 'New draft from your feed', item.title || item.link, '#app-calendar');
      }
      st.seen = [...new Set([...items.map(i => i.guid), ...st.seen])].slice(0, 300);
      st.lastCheck = new Date().toISOString(); st.lastError = null;
    } catch (e) {
      r.error = e.message;
      const st = state[feed.id] || (state[feed.id] = { seen: [] });
      if (st.lastError !== e.message) await notify(userId, 'A feed couldn’t be read', `${feed.url}: ${e.message}`, '#app-autopost');
      st.lastError = e.message; st.lastCheck = new Date().toISOString();
      console.warn('feed', feed.url, e.message);
    }
  }
  return report;
}
const activeFeeds = v => (Array.isArray(v) ? v : []).filter(f => f && f.id && f.on !== false && /^https?:\/\//i.test(String(f.url || ''))).slice(0, 20);
let feeding = false;
async function runFeeds() {
  if (feeding) return; feeding = true;
  try {
    const state = await loadFeedState();
    for (const row of await db('app_data?key=eq.feeds&select=user_id,value') || []) {
      const feeds = activeFeeds(row.value);
      if (feeds.length) await runFeedsFor(row.user_id, feeds, state).catch(e => console.warn('feeds', row.user_id, e.message));
    }
    await saveFeedState(state);
  } catch (e) { console.warn('feeds', e.message); } finally { feeding = false; }
}
async function checkFeedsNow(userId) {
  while (feeding) await new Promise(r => setTimeout(r, 500));
  feeding = true;
  try {
    const [row] = await db(`app_data?user_id=eq.${q(userId)}&key=eq.feeds&select=value`) || [];
    const feeds = activeFeeds(row?.value);
    if (!feeds.length) throw httpError(400, 'Add a feed first (and make sure it’s switched on).');
    const state = await loadFeedState();
    const report = await runFeedsFor(userId, feeds, state);
    await saveFeedState(state);
    return { feeds: report };
  } finally { feeding = false; }
}

// ---------- Teams: accept an invite link ----------
async function acceptInvite(user, body) {
  const token = String(body.token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw httpError(400, 'This invite link isn’t valid.');
  const [inv] = await db('team_members?invite_token=eq.' + q(token) + '&select=*');
  if (!inv) throw httpError(404, 'This invite was already used or removed. Ask for a new link.');
  if (inv.owner_id === user.id) throw httpError(400, 'That’s your own workspace. Send the link to your teammate.');
  const [already] = await db(`team_members?owner_id=eq.${q(inv.owner_id)}&member_id=eq.${q(user.id)}&select=id`);
  if (already) { await db('team_members?id=eq.' + q(inv.id), { method: 'DELETE', prefer: 'return=minimal' }); }
  else await db('team_members?id=eq.' + q(inv.id), { method: 'PATCH', prefer: 'return=minimal', body: { member_id: user.id, member_email: user.email || null, status: 'active', invite_token: null } });
  const [ws] = await db('workspaces?owner_id=eq.' + q(inv.owner_id) + '&select=name');
  await notify(inv.owner_id, 'A teammate joined', `${user.email || inv.email} joined your workspace.`, '#app-team');
  return { owner_id: inv.owner_id, name: ws?.name || 'Team workspace', role: inv.role };
}

// ---------- AI: Maui (Claude), images and video (fal.ai) ----------
const claude = CFG.anthropicKey ? new Anthropic({ apiKey: CFG.anthropicKey }) : null;
// Monthly allowances per plan. Owners (admins) are unlimited.
const PLAN_LIMITS = {
  starter: { chat: 20, image: 10, video: 0, clip: 0 },
  creator: { chat: 1000, image: 50, video: 3, clip: 10 },
  team: { chat: 3000, image: 200, video: 15, clip: 40 },
  agency: { chat: 10000, image: 500, video: 50, clip: 100 },
};
// Trials get the plan's features but only a small taste of the costly ones (AI video, clipping).
const TRIAL_CAPS = { video: 2, clip: 2 };
const USAGE_NAMES = { chat: 'Maui messages', image: 'AI images', video: 'AI videos', clip: 'video clipping runs' };
const planCache = new Map();
async function planFor(userId) {
  const hit = planCache.get(userId);
  if (hit && Date.now() - hit.at < 30000) return hit.v;
  const [[admin], [sub]] = await Promise.all([db('admins?user_id=eq.' + q(userId) + '&select=user_id'), db('subscriptions?user_id=eq.' + q(userId) + '&select=plan,status')]);
  const paying = !!(sub && ['trialing', 'active'].includes(sub.status) && PLAN_LIMITS[String(sub.plan).toLowerCase()]);
  const v = { admin: !!admin, plan: paying ? String(sub.plan).toLowerCase() : 'starter', status: paying ? sub.status : 'none', trial: paying && sub.status === 'trialing' };
  planCache.set(userId, { v, at: Date.now() });
  return v;
}
function limitFor(p, kind) {
  if (p.admin) return Infinity;
  const base = (PLAN_LIMITS[p.plan] || PLAN_LIMITS.starter)[kind] ?? 0;
  return p.trial && TRIAL_CAPS[kind] !== undefined ? Math.min(base, TRIAL_CAPS[kind]) : base;
}
const monthStart = () => { const m = new Date(); m.setUTCDate(1); m.setUTCHours(0, 0, 0, 0); return m.toISOString(); };
async function usedThisMonth(userId, kind) { return (await db(`ai_usage?user_id=eq.${q(userId)}&kind=eq.${kind}&created_at=gte.${q(monthStart())}&select=id`))?.length || 0; }
// Checks the allowance and records the use in one step, one request per user at a time, so parallel
// requests can't slip past the limit. Returns a usage id to refund if the work then fails.
const usageLocks = new Map();
async function reserveUsage(userId, kind) {
  const prev = usageLocks.get(userId) || Promise.resolve();
  let release; const mine = new Promise(r => (release = r));
  const chain = prev.then(() => mine);
  usageLocks.set(userId, chain);
  chain.then(() => { if (usageLocks.get(userId) === chain) usageLocks.delete(userId); });
  await prev;
  try {
    const p = await planFor(userId);
    if (p.admin) return null;
    const limit = limitFor(p, kind), used = await usedThisMonth(userId, kind), what = USAGE_NAMES[kind];
    if (used >= limit) {
      const planName = p.plan[0].toUpperCase() + p.plan.slice(1);
      if (p.trial && limit < (PLAN_LIMITS[p.plan] || {})[kind]) throw httpError(402, `Your free trial includes ${limit} ${what}. Your plan’s full ${PLAN_LIMITS[p.plan][kind]} a month unlock when the trial ends and your first payment goes through.`);
      throw httpError(402, limit ? `You’ve used all ${limit} ${what} on your ${planName} plan this month. Upgrade for more.` : `${what[0].toUpperCase() + what.slice(1)} aren’t included on the ${planName} plan. Upgrade to use them.`);
    }
    const [row] = await db('ai_usage', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, kind } });
    return row?.id || null;
  } finally { release(); }
}
async function refundUsage(usageId) {
  if (!usageId) return;
  await db('ai_usage?id=eq.' + q(usageId), { method: 'DELETE', prefer: 'return=minimal' }).catch(e => console.warn('refund', e.message));
}
async function usageSummary(userId) {
  const p = await planFor(userId), out = {};
  for (const kind of Object.keys(USAGE_NAMES)) { const limit = limitFor(p, kind); out[kind] = { used: await usedThisMonth(userId, kind), limit: Number.isFinite(limit) ? limit : null }; }
  return { plan: p.admin ? 'owner' : p.plan, status: p.admin ? 'owner' : p.status, trial: p.trial, resets: new Date(new Date(monthStart()).setUTCMonth(new Date(monthStart()).getUTCMonth() + 1)).toISOString(), usage: out };
}

const MAUI_SYSTEM = `You are Maui, the friendly AI social media agent inside Editums. You help creators and small businesses plan, write and schedule social posts.

How to answer:
- Reply in a warm, concise, practical voice. Plain text only in "reply" (no markdown headings or asterisks); short lines and simple dashes are fine.
- When the user asks for posts, captions, a plan or a schedule, put each ready-to-publish post in "posts". Otherwise leave "posts" empty.
- Write each caption to fit its channel: Bluesky max 300 characters, X max 280, Mastodon max 500, Threads max 500, Instagram max 2200, LinkedIn max 3000. Count emojis and links.
- Use only the channels the user has selected; if none are given, pick sensible ones and say so.
- Schedule posts on or after today, at good local posting hours (usually 8-11 or 17-20), spread across days for a plan.
- Never claim you published or scheduled anything yourself; the user adds the drafts to their calendar.`;
const MAUI_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'posts'],
  properties: {
    reply: { type: 'string' },
    posts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['caption', 'channel', 'day', 'hour'],
      properties: { caption: { type: 'string' }, channel: { type: 'string' }, day: { type: 'string', description: 'YYYY-MM-DD' }, hour: { type: 'integer', description: '0-23 local time' } } } },
  },
};
async function mauiChat(userId, body) {
  if (!claude) throw httpError(503, 'Maui isn’t switched on yet.');
  const history = (Array.isArray(body.messages) ? body.messages : []).slice(-20)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!history.length || history.at(-1).role !== 'user') throw httpError(400, 'Say something to Maui first.');
  while (history[0].role !== 'user') history.shift();
  const usageId = await reserveUsage(userId, 'chat');
  const channels = (Array.isArray(body.channels) ? body.channels : []).map(String).slice(0, 30);
  const context = `Today is ${String(body.today || new Date().toISOString().slice(0, 10)).slice(0, 10)} (user's time zone: ${String(body.tz || 'unknown').slice(0, 60)}). Selected channels: ${channels.length ? channels.join(', ') : 'none'}.`;
  history[history.length - 1] = { role: 'user', content: context + '\n\n' + history.at(-1).content };
  let msg;
  try {
    msg = await claude.beta.messages.create({
      model: CFG.claudeModel, max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      system: [{ type: 'text', text: MAUI_SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: MAUI_SCHEMA } },
      messages: history,
    });
  } catch (e) {
    await refundUsage(usageId);
    if (e instanceof Anthropic.RateLimitError) throw httpError(429, 'Maui is busy right now. Try again in a minute.');
    if (e instanceof Anthropic.APIError) { console.warn('claude', e.status, e.message); throw httpError(502, 'Maui couldn’t answer just now. Try again.'); }
    throw e;
  }
  if (msg.stop_reason === 'refusal') return { reply: 'Sorry, I can’t help with that one. Try asking another way.', posts: [] };
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let out; try { out = JSON.parse(text); } catch { out = { reply: text || 'Sorry, something went wrong. Try again.', posts: [] }; }
  const posts = (Array.isArray(out.posts) ? out.posts : []).filter(p => p && typeof p.caption === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.day) && Number.isInteger(p.hour) && p.hour >= 0 && p.hour < 24).slice(0, 30);
  return { reply: String(out.reply || ''), posts };
}

// fal.ai jobs (images and video). Kept in memory; a restart only loses jobs still running.
const jobs = new Map();
const IMAGE_SIZES = { square: 'square_hd', portrait: 'portrait_4_3', story: 'portrait_16_9', landscape: 'landscape_16_9' };
const VIDEO_RATIOS = { vertical: '9:16', landscape: '16:9', square: '1:1' };
async function falSubmit(model, input) {
  const r = await fetchJson(CFG.falQueueUrl + '/' + model, { method: 'POST', headers: { authorization: 'Key ' + CFG.falKey, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok || !r.json?.request_id) { console.warn('fal submit', r.status, r.text.slice(0, 300)); throw httpError(502, 'The image service didn’t accept the request. Try again.'); }
  return r.json;
}
async function startGeneration(userId, kind, body) {
  if (!CFG.falKey) throw httpError(503, 'AI images and video aren’t switched on yet.');
  const prompt = String(body.prompt || '').trim().slice(0, 2000);
  if (prompt.length < 3) throw httpError(400, 'Describe what you want first.');
  const usageId = await reserveUsage(userId, kind);
  const style = String(body.style || '').slice(0, 60);
  let sub; try { sub = kind === 'image'
    ? await falSubmit(CFG.falImageModel, { prompt: style ? `${prompt}. Style: ${style}.` : prompt, image_size: IMAGE_SIZES[body.format] || 'square_hd', num_images: 1, enable_safety_checker: true })
    : await falSubmit(CFG.falVideoModel, { prompt, duration: String(body.duration) === '10' ? '10' : '5', aspect_ratio: VIDEO_RATIOS[body.format] || '9:16' }); }
  catch (e) { await refundUsage(usageId); throw e; }
  const id = crypto.randomUUID();
  jobs.set(id, { id, userId, kind, usageId, statusUrl: sub.status_url, responseUrl: sub.response_url, status: 'running', created: Date.now() });
  return { job: id, status: 'running' };
}
async function checkJob(userId, id) {
  const job = jobs.get(id);
  if (!job || job.userId !== userId) throw httpError(404, 'That generation was not found. Start it again.');
  if (job.status !== 'running') return job.result;
  if (job.local) return { status: 'running', stage: job.stage };
  const auth = { authorization: 'Key ' + CFG.falKey };
  const st = await fetchJson(job.statusUrl, { headers: auth });
  if (!st.ok) return { status: 'running' };
  if (st.json.status !== 'COMPLETED') return { status: 'running', queue: st.json.queue_position ?? null };
  const res = await fetchJson(job.responseUrl, { headers: auth });
  const files = job.kind === 'image' ? (res.json?.images || []) : (res.json?.video ? [res.json.video] : []);
  if (!res.ok || st.json.error || !files.length) {
    job.status = 'failed'; job.result = { status: 'failed', error: 'Generation failed. Try a different description. It didn’t count against your plan.' };
    await refundUsage(job.usageId);
    return job.result;
  }
  const media = [];
  for (const f of files) {
    const dl = await fetch(f.url, { signal: AbortSignal.timeout(120000) });
    if (!dl.ok) continue;
    const type = (dl.headers.get('content-type') || f.content_type || (job.kind === 'image' ? 'image/png' : 'video/mp4')).split(';')[0];
    if (!SERVE_TYPES[type]) continue;
    const data = Buffer.from(await dl.arrayBuffer());
    const mid = await storeMediaBuffer(userId, data, type, { width: f.width || null, height: f.height || null, name: `editums-ai-${job.kind}.${SERVE_TYPES[type]}` });
    media.push({ id: mid, type, url: `${CFG.publicUrl}/v1/media/${mid}`, width: f.width || null, height: f.height || null });
  }
  job.status = media.length ? 'done' : 'failed';
  if (!media.length) await refundUsage(job.usageId);
  job.result = media.length ? { status: 'done', media } : { status: 'failed', error: 'Couldn’t download the result. Try again.' };
  return job.result;
}
setInterval(() => { const cut = Date.now() - 6 * 3600 * 1000; for (const [k, j] of jobs) if (j.created < cut) jobs.delete(k); }, 3600 * 1000);

// ---------- Video clipping: transcribe (fal.ai Whisper), pick highlights (Claude), cut with ffmpeg ----------
const CLIP_TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv' };
const CLIP_MAX_BYTES = 500 * 1024 * 1024, CLIP_MAX_SECONDS = 90 * 60;
const CLIP_FORMATS = {
  vertical: { w: 1080, h: 1920, crop: "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'" },
  square: { w: 1080, h: 1080, crop: "crop='min(iw,ih)':'min(iw,ih)'" },
  original: null,
};
const run = (cmd, args, timeout = 30 * 60 * 1000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => e ? reject(new Error(String(err || e.message).slice(-600))) : resolve(out)));
const userErr = m => Object.assign(new Error(m), { friendly: true });
const mediaFile = (id, ext = 'bin') => path.join(CFG.mediaDir, `${id}.${ext}`);
async function dropMedia(id) { for (const ext of ['bin', 'json']) await fs.rm(mediaFile(id, ext), { force: true }); }

async function saveClipSource(userId, req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!CLIP_TYPES[type]) throw httpError(415, 'Upload an MP4, MOV, WebM or MKV video.');
  if (Number(req.headers['content-length']) > CLIP_MAX_BYTES) throw httpError(413, 'Videos must be under 500 MB.');
  await fs.mkdir(CFG.mediaDir, { recursive: true });
  const id = crypto.randomUUID();
  let size = 0;
  try {
    await pipeline(req, async function* (src) { for await (const c of src) { size += c.length; if (size > CLIP_MAX_BYTES) throw httpError(413, 'Videos must be under 500 MB.'); yield c; } }, createWriteStream(mediaFile(id)));
  } catch (e) { await fs.rm(mediaFile(id), { force: true }); throw e.status ? e : httpError(400, 'The upload was interrupted. Try again.'); }
  if (!size) { await fs.rm(mediaFile(id), { force: true }); throw httpError(400, 'Empty video.'); }
  await fs.writeFile(mediaFile(id, 'json'), JSON.stringify({ user: userId, type, source: true, name: String(req.headers['x-file-name'] || '').slice(0, 120), created: new Date().toISOString() }));
  return { id };
}

// Runs fal.ai models that we wait on here (speech-to-text).
async function falRun(model, input, maxMs = 20 * 60 * 1000) {
  const sub = await falSubmit(model, input), auth = { authorization: 'Key ' + CFG.falKey }, t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 4000));
    const st = await fetchJson(sub.status_url, { headers: auth });
    if (st.ok && st.json?.status === 'COMPLETED') break;
    if (Date.now() - t0 > maxMs) throw userErr('Transcribing took too long.');
  }
  const r = await fetchJson(sub.response_url, { headers: auth });
  if (!r.ok) throw userErr('Transcribing failed.');
  return r.json;
}

const CLIP_SYSTEM = `You are the clip editor inside Editums, a social media app. You get a timestamped transcript of a long video and pick the best moments to post as short clips on TikTok, Reels, Shorts and similar.

Pick moments that work on their own: a strong hook in the first seconds, one complete idea, and a clean ending at the end of a sentence. Prefer surprising, useful, funny or emotional moments. Clips must not overlap. Use the transcript times exactly as given for start and end (seconds). For each clip write a short title and a ready-to-post caption (under 250 characters, 1-3 relevant hashtags at the end) in the language of the video.`;
const CLIP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['clips'],
  properties: { clips: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['start', 'end', 'title', 'caption'],
    properties: { start: { type: 'number' }, end: { type: 'number' }, title: { type: 'string' }, caption: { type: 'string' } } } } },
};
async function pickHighlights(segments, duration, count, minLen, maxLen, wish) {
  const lines = segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n').slice(0, 400000);
  const ask = `Video length: ${duration.toFixed(0)} seconds. Pick up to ${count} clips, each between ${minLen} and ${maxLen} seconds long.${wish ? `\nThe creator asked: ${wish}` : ''}\n\nTranscript:\n${lines}`;
  let msg;
  try {
    msg = await claude.beta.messages.create({
      model: CFG.claudeModel, max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      system: [{ type: 'text', text: CLIP_SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CLIP_SCHEMA } },
      messages: [{ role: 'user', content: ask }],
    });
  } catch (e) { console.warn('claude clip', e.status, e.message); throw userErr('Couldn’t pick the highlights just now. Try again.'); }
  if (msg.stop_reason === 'refusal') throw userErr('This video can’t be clipped.');
  let out; try { out = JSON.parse(msg.content.filter(b => b.type === 'text').map(b => b.text).join('')); } catch { out = { clips: [] }; }
  const picked = [];
  for (const c of Array.isArray(out.clips) ? out.clips : []) {
    let start = Math.max(0, Number(c.start) || 0), end = Math.min(duration, Number(c.end) || 0);
    if (end - start > maxLen + 5) end = start + maxLen;
    if (end - start < 3 || picked.some(p => start < p.end && end > p.start)) continue;
    picked.push({ start, end, title: String(c.title || '').slice(0, 120), caption: String(c.caption || '').slice(0, 600) });
    if (picked.length >= count) break;
  }
  return picked.sort((a, b) => a.start - b.start);
}
// No speech: spread clips evenly instead.
function evenClips(duration, count, len) {
  const n = Math.max(1, Math.min(count, Math.floor(duration / len) || 1)), gap = duration / n, out = [];
  for (let i = 0; i < n; i++) { const start = i * gap; out.push({ start, end: Math.min(duration, start + len), title: `Clip ${i + 1}`, caption: '' }); }
  return out;
}

// Captions burned into the clip: short phrases, big text, lower third.
const assTime = t => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = (t % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${s}`; };
function buildAss(segments, clip, w, h) {
  const size = Math.round(Math.min(w, h) * 0.065), lines = [];
  for (const s of segments) {
    if (s.end <= clip.start || s.start >= clip.end) continue;
    const words = s.text.trim().split(/\s+/).filter(Boolean); if (!words.length) continue;
    const per = (s.end - s.start) / words.length;
    for (let i = 0; i < words.length; i += 5) {
      const a = Math.max(s.start + i * per, clip.start), b = Math.min(s.start + Math.min(i + 5, words.length) * per, clip.end);
      if (b <= a) continue;
      const txt = words.slice(i, i + 5).join(' ').replace(/[{}\\]/g, '');
      lines.push(`Dialogue: 0,${assTime(a - clip.start)},${assTime(b - clip.start)},Cap,,0,0,0,,${txt}`);
    }
  }
  if (!lines.length) return null;
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,DejaVu Sans,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.max(3, Math.round(size / 12))},1,2,${Math.round(w * 0.08)},${Math.round(w * 0.08)},${Math.round(h * 0.18)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`;
}

let clipQueue = Promise.resolve();
async function startClipping(userId, body) {
  if (!claude || !CFG.falKey) throw httpError(503, 'Video clipping isn’t switched on yet.');
  const source = String(body.source || '');
  let meta; try { meta = JSON.parse(await fs.readFile(mediaFile(source, 'json'), 'utf8')); } catch {}
  if (!MEDIA_ID.test(source) || !meta || meta.user !== userId || !meta.source) throw httpError(404, 'Upload the video again.');
  const opts = {
    count: Math.min(10, Math.max(1, Number(body.count) || 3)),
    format: CLIP_FORMATS[body.format] !== undefined ? body.format : 'vertical',
    length: ({ short: [15, 30], medium: [30, 60], long: [60, 90] })[body.length] || [20, 60],
    captions: body.captions !== false,
    wish: String(body.prompt || '').trim().slice(0, 500),
  };
  const usageId = await reserveUsage(userId, 'clip');
  const id = crypto.randomUUID();
  const job = { id, userId, kind: 'clip', usageId, local: true, status: 'running', stage: 'Waiting in line', created: Date.now() };
  jobs.set(id, job);
  clipQueue = clipQueue.then(() => runClipping(job, source, opts)).catch(() => {});
  return { job: id, status: 'running' };
}
async function runClipping(job, source, o) {
  const src = mediaFile(source), audioId = crypto.randomUUID(), tmp = [];
  try {
    job.stage = 'Reading the video';
    const duration = Number(String(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], 60000)).trim());
    if (!(duration > 0)) throw userErr('That file doesn’t look like a video we can read.');
    if (duration > CLIP_MAX_SECONDS) throw userErr('Videos up to 90 minutes can be clipped.');
    const hasAudio = String(await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src], 60000)).trim() !== '';
    let segments = [];
    if (hasAudio) {
      job.stage = 'Transcribing';
      await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-f', 'mp3', mediaFile(audioId)]);
      await fs.writeFile(mediaFile(audioId, 'json'), JSON.stringify({ user: job.userId, type: 'audio/mpeg', created: new Date().toISOString() }));
      const tr = await falRun(CFG.falSpeechModel, { audio_url: `${CFG.publicUrl}/v1/media/${audioId}`, task: 'transcribe', chunk_level: 'segment' });
      segments = (tr?.chunks || []).map(c => ({ start: Number(c.timestamp?.[0]), end: Number(c.timestamp?.[1] ?? c.timestamp?.[0]), text: String(c.text || '').trim() }))
        .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text);
    }
    const [minLen, maxLen] = o.length;
    let picks = [];
    if (segments.length) { job.stage = 'Finding the best moments'; picks = await pickHighlights(segments, duration, o.count, minLen, maxLen, o.wish); }
    if (!picks.length) picks = evenClips(duration, o.count, Math.min(maxLen, Math.max(minLen, 30)));
    const fmt = CLIP_FORMATS[o.format], clips = [];
    for (const [i, c] of picks.entries()) {
      job.stage = `Cutting clip ${i + 1} of ${picks.length}`;
      const out = crypto.randomUUID(), vf = [];
      if (fmt) vf.push(fmt.crop, `scale=${fmt.w}:${fmt.h}`, 'setsar=1'); else vf.push("scale='min(1920,iw)':-2");
      let size = fmt ? [fmt.w, fmt.h] : null;
      if (!size) { const dim = String(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src], 60000)).trim().split(','); const sw = Number(dim[0]) || 1920, sh = Number(dim[1]) || 1080, k = Math.min(1, 1920 / sw); size = [Math.round(sw * k / 2) * 2, Math.round(sh * k / 2) * 2]; }
      const ass = o.captions ? buildAss(segments, c, size[0], size[1]) : null;
      if (ass) { const f = mediaFile(out, 'ass'); tmp.push(f); await fs.writeFile(f, ass); vf.push(`subtitles=${f}`); }
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', c.start.toFixed(2), '-i', src, '-t', (c.end - c.start).toFixed(2), '-vf', vf.join(','),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', mediaFile(out)]);
      await fs.writeFile(mediaFile(out, 'json'), JSON.stringify({ user: job.userId, type: 'video/mp4', width: size[0], height: size[1], name: `editums-clip-${i + 1}.mp4`, created: new Date().toISOString() }));
      clips.push({ start: c.start, end: c.end, title: c.title, caption: c.caption, media: { id: out, type: 'video/mp4', url: `${CFG.publicUrl}/v1/media/${out}`, width: size[0], height: size[1] } });
    }
    job.status = 'done'; job.result = { status: 'done', clips, media: clips.map(c => c.media), transcribed: segments.length > 0 };
  } catch (e) {
    console.warn('clip', job.id, e.message);
    job.status = 'failed'; job.result = { status: 'failed', error: e.friendly || e.status ? e.message : 'Clipping failed. Try another video.' };
    await refundUsage(job.usageId);
  } finally {
    await dropMedia(source); await dropMedia(audioId);
    for (const f of tmp) await fs.rm(f, { force: true });
  }
}
// Remove uploaded videos that were never clipped.
setInterval(async () => {
  try {
    const cut = Date.now() - 24 * 3600 * 1000;
    for (const f of await fs.readdir(CFG.mediaDir)) {
      if (!f.endsWith('.json')) continue;
      const meta = JSON.parse(await fs.readFile(path.join(CFG.mediaDir, f), 'utf8').catch(() => '{}'));
      if (meta.source && Date.parse(meta.created) < cut) await dropMedia(f.slice(0, -5));
    }
  } catch {}
}, 3600 * 1000);

// ---------- Facebook Pages (Facebook Login) ----------
// Needs FACEBOOK_APP_ID and FACEBOOK_APP_SECRET. Redirect URI to register in the Meta app:
//   <PUBLIC_URL>/v1/oauth/facebook/callback
const FB = {
  appId: env('FACEBOOK_APP_ID', ''), secret: env('FACEBOOK_APP_SECRET', ''), configId: env('FACEBOOK_CONFIG_ID', ''),
  version: env('FACEBOOK_GRAPH_VERSION', 'v26.0'),
};
FB.graph = env('FACEBOOK_GRAPH_URL', 'https://graph.facebook.com/' + FB.version).replace(/\/$/, '');
FB.dialog = env('FACEBOOK_DIALOG_URL', 'https://www.facebook.com/' + FB.version + '/dialog/oauth');
const FB_SCOPES = 'pages_show_list,pages_manage_posts,pages_read_engagement';
const fbRedirect = () => CFG.publicUrl + '/v1/oauth/facebook/callback';
const fbProof = token => crypto.createHmac('sha256', FB.secret).update(token).digest('hex');
function fbErr(r, what) {
  const e = r.json?.error || {};
  if (e.code === 190 || e.code === 102) return new Error('Facebook sign-in expired or was removed. Reconnect the Page.');
  if (e.code === 10 || e.code === 200) return new Error('Facebook didn’t allow this. Reconnect the Page and grant all requested permissions.');
  return new Error(`Facebook${what ? ' ' + what : ''}: ${e.error_user_msg || e.message || r.status}`);
}
async function fbGet(path, token, params = {}) {
  const u = new URL(FB.graph + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (token) { u.searchParams.set('access_token', token); u.searchParams.set('appsecret_proof', fbProof(token)); }
  return fetchJson(u);
}
async function fbPost(path, token, body) {
  if (body instanceof FormData) { body.append('access_token', token); body.append('appsecret_proof', fbProof(token)); return fetchJson(FB.graph + path, { method: 'POST', body }); }
  return fetchJson(FB.graph + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, access_token: token, appsecret_proof: fbProof(token) }) });
}
async function fbStart(userId) {
  if (!FB.appId || !FB.secret) throw httpError(503, 'Facebook isn’t switched on yet.');
  const state = crypto.randomBytes(24).toString('base64url');
  await db('oauth_states', { method: 'POST', prefer: 'return=minimal', body: { state, user_id: userId, provider: 'facebook', data: {} } });
  const u = new URL(FB.dialog);
  u.search = new URLSearchParams({ client_id: FB.appId, redirect_uri: fbRedirect(), state, response_type: 'code', ...(FB.configId ? { config_id: FB.configId } : { scope: FB_SCOPES }) }).toString();
  return { url: u.toString() };
}
async function fbCallback(params) {
  const state = params.get('state'), code = params.get('code');
  if (!state || !code) throw new Error(params.get('error_description') || params.get('error_message') || 'Facebook sign-in was cancelled.');
  const [st] = await db('oauth_states?state=eq.' + q(state) + '&select=*');
  if (!st || st.provider !== 'facebook') throw new Error('This sign-in link expired. Try connecting again.');
  await db('oauth_states?state=eq.' + q(state), { method: 'DELETE', prefer: 'return=minimal' });
  if (Date.now() - new Date(st.created_at).getTime() > 15 * 60 * 1000) throw new Error('This sign-in link expired. Try connecting again.');
  const short = await fbGet('/oauth/access_token', null, { client_id: FB.appId, client_secret: FB.secret, redirect_uri: fbRedirect(), code });
  if (!short.ok || !short.json?.access_token) throw new Error('Facebook didn’t accept the sign-in. Try again.');
  // Long-lived user token → Page tokens that don't expire.
  const long = await fbGet('/oauth/access_token', null, { grant_type: 'fb_exchange_token', client_id: FB.appId, client_secret: FB.secret, fb_exchange_token: short.json.access_token });
  const userToken = long.json?.access_token || short.json.access_token;
  const pages = await fbGet('/me/accounts', userToken, { fields: 'id,name,access_token,picture{url},tasks', limit: '100' });
  if (!pages.ok) throw fbErr(pages, 'pages');
  const usable = (pages.json?.data || []).filter(p => p.access_token && (!Array.isArray(p.tasks) || p.tasks.includes('CREATE_CONTENT')));
  if (!usable.length) throw new Error('No Facebook Pages found. You need to manage a Page and select it when Facebook asks which Pages to share.');
  for (const p of usable) {
    const secret = { pageId: p.id, pageToken: p.access_token };
    const fields = { provider: 'facebook', handle: p.name, display_name: p.name, avatar_url: p.picture?.data?.url || null, instance: 'facebook.com', external_id: String(p.id) };
    const [existing] = await db(`channels?user_id=eq.${q(st.user_id)}&provider=eq.facebook&external_id=eq.${q(p.id)}&select=id`);
    if (existing) {
      await db('channels?id=eq.' + q(existing.id), { method: 'PATCH', prefer: 'return=minimal', body: { ...fields, status: 'active' } });
      await db('channel_tokens?channel_id=eq.' + q(existing.id), { method: 'PATCH', prefer: 'return=minimal', body: { data: seal(secret), updated_at: new Date().toISOString() } });
    } else await saveChannel(st.user_id, fields, secret);
  }
  return usable.length;
}
const fbPostId = url => { const m = /facebook\.com\/(\d+)\/posts\/(\d+)/.exec(url || ''); return m ? `${m[1]}_${m[2]}` : null; };
async function fbPublish(channel, secret, post) {
  const text = String(post.caption || '');
  const files = (await loadPostMedia(post)).slice(0, 10);
  const body = { message: text };
  if (files.length) {
    const ids = [];
    for (const f of files) {
      const form = new FormData();
      form.append('source', new Blob([f.data], { type: f.type }), f.name || 'image');
      form.append('published', 'false');
      if (f.alt) form.append('alt_text_custom', f.alt);
      const up = await fbPost(`/${secret.pageId}/photos`, secret.pageToken, form);
      if (!up.ok || !up.json?.id) throw fbErr(up, 'image upload');
      ids.push(up.json.id);
    }
    body.attached_media = ids.map(id => ({ media_fbid: id }));
  }
  const r = await fbPost(`/${secret.pageId}/feed`, secret.pageToken, body);
  if (!r.ok || !r.json?.id) throw fbErr(r);
  const [pageId, postId] = String(r.json.id).split('_');
  return `https://www.facebook.com/${pageId}/posts/${postId || pageId}`;
}
PUBLISHERS.facebook = fbPublish;
CAPTION_LIMIT.facebook = 63206;
PLUG_DRIVERS.facebook = {
  async stats(ch, secret, post) {
    const id = fbPostId(post.external_url); if (!id) return null;
    const r = await fbGet('/' + id, secret.pageToken, { fields: 'likes.summary(true).limit(0),comments.summary(true).limit(0),shares' });
    if (!r.ok) return null;
    return { likes: r.json.likes?.summary?.total_count || 0, replies: r.json.comments?.summary?.total_count || 0, reposts: r.json.shares?.count || 0, ref: { id } };
  },
  async comment(ch, secret, post, st, text) {
    const r = await fbPost(`/${st.ref.id}/comments`, secret.pageToken, { message: text });
    if (!r.ok) throw fbErr(r, 'comment');
  },
  async repost() { throw new Error('Facebook doesn’t allow apps to reshare posts. Use “Auto-comment” or a notification instead.'); },
};
async function fbFollowers(ch) {
  const [tok] = await db('channel_tokens?channel_id=eq.' + q(ch.id) + '&select=data'); if (!tok) return null;
  const s = unseal(tok.data);
  const r = await fbGet('/' + s.pageId, s.pageToken, { fields: 'followers_count,fan_count' });
  return r.ok ? (r.json.followers_count ?? r.json.fan_count ?? null) : null;
}

// ---------- Public API (API keys) and MCP server ----------
// Keys look like ed_live_<40 hex>. Only their SHA-256 fingerprint is stored (api_keys.key_hash).
const API_KEY_RE = /^ed_live_[0-9a-f]{40}$/;
const keyCache = new Map(); // hash -> { userId, keyId, at, touched }
async function authApiKey(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const key = m ? m[1] : String(req.headers['x-api-key'] || '');
  if (!API_KEY_RE.test(key)) throw httpError(401, 'Missing or invalid API key. Send it as "Authorization: Bearer ed_live_…". Create one under Agents / Dev in Editums.');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  let hit = keyCache.get(hash);
  if (!hit || Date.now() - hit.at > 60000) {
    const [row] = await db('api_keys?key_hash=eq.' + hash + '&revoked_at=is.null&select=id,user_id');
    if (!row) { keyCache.delete(hash); throw httpError(401, 'This API key was revoked or doesn’t exist.'); }
    hit = { userId: row.user_id, keyId: row.id, at: Date.now(), touched: hit?.touched || 0 };
    keyCache.set(hash, hit);
  }
  if (Date.now() - hit.touched > 5 * 60000) {
    hit.touched = Date.now();
    db('api_keys?id=eq.' + q(hit.keyId), { method: 'PATCH', prefer: 'return=minimal', body: { last_used_at: new Date().toISOString() } }).catch(() => {});
  }
  rateLimit(hit.keyId);
  const p = await planFor(hit.userId);
  if (!p.admin && (p.plan === 'starter' || p.status === 'none')) throw httpError(403, 'API and MCP access is included on the Creator, Team and Agency plans (trials included). Upgrade at ' + CFG.appUrl + '/#pricing');
  return { id: hit.userId, keyId: hit.keyId };
}
const rate = new Map();
function rateLimit(keyId, perMinute = 120) {
  const now = Date.now(), w = rate.get(keyId) || { start: now, n: 0 };
  if (now - w.start > 60000) { w.start = now; w.n = 0; }
  w.n++; rate.set(keyId, w);
  if (w.n > perMinute) { const e = httpError(429, `Rate limit: ${perMinute} requests per minute per key. Try again shortly.`); e.retryAfter = Math.ceil((w.start + 60000 - now) / 1000); throw e; }
}

const POST_FIELDS = 'id,caption,channel,channel_id,status,publish_at,published_at,external_url,last_error,media,created_at,updated_at';
const EDITABLE = ['draft', 'scheduled', 'failed'];
function apiPost(p) {
  return { id: p.id, channel_id: p.channel_id, channel: p.channel, text: p.caption, status: p.status, publish_at: p.publish_at, published_at: p.published_at, url: p.external_url, error: p.last_error,
    media: (Array.isArray(p.media) ? p.media : []).filter(m => m && m.serverId).map(m => ({ id: m.serverId, type: m.type || null })), created_at: p.created_at, updated_at: p.updated_at };
}
function apiChannel(c) { return { id: c.id, provider: c.provider, handle: c.handle, name: c.display_name, avatar_url: c.avatar_url, status: c.status }; }
async function userChannel(userId, channelId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(channelId || ''))) throw httpError(400, 'channel_id is required. List your channels with GET /public/v1/channels.');
  const [c] = await db(`channels?id=eq.${q(channelId)}&user_id=eq.${q(userId)}&select=*`);
  if (!c) throw httpError(404, 'Channel not found.');
  if (c.status && c.status !== 'active') throw httpError(409, 'That channel needs to be reconnected in Editums.');
  return c;
}
async function userPost(userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw httpError(404, 'Post not found.');
  const [p] = await db(`posts?id=eq.${q(id)}&user_id=eq.${q(userId)}&select=*`);
  if (!p) throw httpError(404, 'Post not found.');
  return p;
}
function checkText(text, provider) {
  text = String(text ?? '').trim();
  if (!text) throw httpError(400, 'text is required.');
  const lim = CAPTION_LIMIT[provider];
  if (lim && graphemes(text) > lim) throw httpError(400, `Too long for ${provider}: ${graphemes(text)} characters, the limit is ${lim}.`);
  return text;
}
function parseWhen(v) {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw httpError(400, 'publish_at must be an ISO 8601 date-time, e.g. 2026-11-02T15:00:00Z.');
  if (t > Date.now() + 366 * 86400000) throw httpError(400, 'publish_at can be at most a year ahead.');
  return new Date(Math.max(t, Date.now())).toISOString();
}
async function attachMedia(userId, body) {
  const out = [];
  for (const id of (Array.isArray(body.media_ids) ? body.media_ids : []).slice(0, 4)) {
    if (!MEDIA_ID.test(String(id))) throw httpError(400, 'Unknown media id: ' + id);
    let meta; try { meta = JSON.parse(await fs.readFile(path.join(CFG.mediaDir, id + '.json'), 'utf8')); } catch { throw httpError(400, 'Unknown media id: ' + id); }
    if (meta.user !== userId || !MEDIA_TYPES[meta.type]) throw httpError(400, 'Unknown media id: ' + id);
    out.push({ id: crypto.randomUUID(), serverId: id, name: meta.name || 'image', type: meta.type });
  }
  for (const url of (Array.isArray(body.image_urls) ? body.image_urls : []).slice(0, 4 - out.length)) {
    const img = await feedImage(userId, String(url));
    if (!img) throw httpError(400, 'Couldn’t use the image at ' + String(url).slice(0, 200) + ' (must be a public JPG, PNG, WebP or GIF under 8 MB).');
    out.push(img);
  }
  return out;
}
async function userTimezone(userId) { const [pref] = await db(`preferences?user_id=eq.${q(userId)}&select=timezone`).catch(() => []) || []; return pref?.timezone; }

// Core actions, shared by REST and MCP.
const API = {
  async me(u) { const n = await db(`channels?user_id=eq.${q(u.id)}&select=id`); return { user_id: u.id, channels: n?.length || 0 }; },
  async channels(u) { return (await db(`channels?user_id=eq.${q(u.id)}&select=*&order=created_at.asc`) || []).map(apiChannel); },
  async listPosts(u, { status, limit, before } = {}) {
    let path = `posts?user_id=eq.${q(u.id)}&select=${POST_FIELDS}&order=created_at.desc&limit=${Math.min(Math.max(Number(limit) || 20, 1), 100)}`;
    if (status) { const st = String(status).split(',').filter(s => /^[a-z_]+$/.test(s)); if (st.length) path += `&status=in.(${st.join(',')})`; }
    if (before && !Number.isNaN(Date.parse(before))) path += `&created_at=lt.${q(new Date(before).toISOString())}`;
    return (await db(path) || []).map(apiPost);
  },
  async getPost(u, id) { return apiPost(await userPost(u.id, id)); },
  async createPost(u, body = {}) {
    const ch = await userChannel(u.id, body.channel_id);
    const caption = checkText(body.text ?? body.caption, ch.provider);
    const now = body.publish_now === true || body.publish_at === 'now';
    const when = now ? new Date().toISOString() : parseWhen(body.publish_at);
    const draft = body.draft === true || (!now && !when);
    const media = await attachMedia(u.id, body);
    const slot = localSlot(await userTimezone(u.id), when ? new Date(when) : new Date());
    const [row] = await db('posts', { method: 'POST', prefer: 'return=representation', body: {
      user_id: u.id, created_by: u.id, caption, channel: ch.handle, channel_id: ch.id, scheduled_day: slot.day, scheduled_hour: slot.hour,
      status: draft ? 'draft' : (now ? 'publishing_now' : 'scheduled'), publish_at: draft ? null : when, media, ai_briefs: { tag: 'API' } } });
    if (now) { const r = await runPost(row); const [fresh] = await db(`posts?id=eq.${q(row.id)}&select=*`); return { ...apiPost(fresh || row), ...(r?.error ? { error: r.error } : {}) }; }
    return apiPost(row);
  },
  async updatePost(u, id, body = {}) {
    const p = await userPost(u.id, id);
    if (!EDITABLE.includes(p.status)) throw httpError(409, `A ${p.status} post can’t be edited.`);
    const patch = { updated_at: new Date().toISOString() };
    let ch = null;
    if (body.channel_id !== undefined) { ch = await userChannel(u.id, body.channel_id); patch.channel_id = ch.id; patch.channel = ch.handle; }
    if (body.text !== undefined || body.caption !== undefined) { ch = ch || (p.channel_id ? (await db(`channels?id=eq.${q(p.channel_id)}&select=provider`))?.[0] : null); patch.caption = checkText(body.text ?? body.caption, ch?.provider); }
    if (body.media_ids !== undefined || body.image_urls !== undefined) patch.media = await attachMedia(u.id, body);
    if (body.draft === true) { patch.status = 'draft'; patch.publish_at = null; }
    else if (body.publish_at !== undefined) {
      const when = parseWhen(body.publish_at);
      patch.status = when ? 'scheduled' : 'draft'; patch.publish_at = when;
      if (when) { const slot = localSlot(await userTimezone(u.id), new Date(when)); patch.scheduled_day = slot.day; patch.scheduled_hour = slot.hour; }
    }
    const rows = await db(`posts?id=eq.${q(p.id)}&status=in.(${EDITABLE.join(',')})`, { method: 'PATCH', prefer: 'return=representation', body: patch });
    if (!rows?.length) throw httpError(409, 'The post changed while you were editing it. Fetch it again.');
    return apiPost(rows[0]);
  },
  async deletePost(u, id) {
    const p = await userPost(u.id, id);
    if (['published', 'publishing', 'publishing_now'].includes(p.status)) throw httpError(409, 'Published posts can’t be deleted through the API. Delete them on the network.');
    await db(`posts?id=eq.${q(p.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
    return { id: p.id, deleted: true };
  },
  async publishPost(u, id) {
    const p = await userPost(u.id, id);
    if (p.status === 'published') throw httpError(409, 'This post is already published.');
    if (['publishing', 'publishing_now'].includes(p.status)) throw httpError(409, 'This post is already being published.');
    await db('posts?id=eq.' + q(p.id), { method: 'PATCH', prefer: 'return=minimal', body: { status: 'publishing_now' } });
    const r = await runPost({ ...p, status: 'publishing_now' });
    const [fresh] = await db(`posts?id=eq.${q(p.id)}&select=*`);
    return { ...apiPost(fresh || p), ...(r?.error ? { error: r.error } : {}) };
  },
  async analytics(u, { days } = {}) {
    const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 365) * 86400000).toISOString();
    const channels = await db(`channels?user_id=eq.${q(u.id)}&select=*`) || [];
    const posts = await db(`posts?user_id=eq.${q(u.id)}&status=eq.published&published_at=gte.${q(since)}&external_url=not.is.null&select=id,caption,channel_id,published_at,external_url&order=published_at.desc&limit=100`) || [];
    const out = { since, channels: [], posts: [] };
    for (const ch of channels) {
      const row = { id: ch.id, provider: ch.provider, handle: ch.handle, followers: null, posts: 0, likes: 0, reposts: 0, replies: 0 };
      try {
        if (ch.provider === 'bluesky') row.followers = (await fetchJson('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=' + q(ch.external_id || ch.handle))).json?.followersCount ?? null;
        if (ch.provider === 'facebook') row.followers = await fbFollowers(ch);
        if (ch.provider === 'mastodon' && ch.external_id) row.followers = (await fetchJson(`https://${mastoHost(ch.instance)}/api/v1/accounts/${q(ch.external_id)}`)).json?.followers_count ?? null;
      } catch {}
      const drv = PLUG_DRIVERS[ch.provider]; const mine = posts.filter(p => p.channel_id === ch.id);
      let secret = null;
      if (drv && mine.length) { const [tok] = await db('channel_tokens?channel_id=eq.' + q(ch.id) + '&select=data'); if (tok) secret = unseal(tok.data); }
      for (const p of mine) {
        let st = null; try { if (secret) st = await drv.stats(ch, secret, p); } catch {}
        const s = st ? { likes: st.likes, reposts: st.reposts, replies: st.replies } : null;
        out.posts.push({ id: p.id, channel_id: ch.id, text: p.caption, published_at: p.published_at, url: p.external_url, stats: s });
        row.posts++; if (s) { row.likes += s.likes; row.reposts += s.reposts; row.replies += s.replies; }
      }
      out.channels.push(row);
    }
    return out;
  },
};

// REST: /public/v1/...
async function handlePublic(req, res, url) {
  const send2 = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
  const u = await authApiKey(req);
  const p = url.pathname.replace(/\/+$/, ''), m = req.method;
  const qs = Object.fromEntries(url.searchParams);
  let mm;
  if (m === 'GET' && p === '/public/v1/me') return send2(200, await API.me(u));
  if (m === 'GET' && p === '/public/v1/channels') return send2(200, { data: await API.channels(u) });
  if (m === 'GET' && p === '/public/v1/posts') return send2(200, { data: await API.listPosts(u, qs) });
  if (m === 'POST' && p === '/public/v1/posts') return send2(201, await API.createPost(u, await readJson(req)));
  if (m === 'POST' && p === '/public/v1/media') return send2(201, await saveMedia(u.id, req));
  if (m === 'GET' && p === '/public/v1/analytics') { rateLimit(u.keyId + ':analytics', 10); return send2(200, await API.analytics(u, qs)); }
  if ((mm = /^\/public\/v1\/posts\/([0-9a-f-]{36})$/i.exec(p))) {
    if (m === 'GET') return send2(200, await API.getPost(u, mm[1]));
    if (m === 'PATCH') return send2(200, await API.updatePost(u, mm[1], await readJson(req)));
    if (m === 'DELETE') return send2(200, await API.deletePost(u, mm[1]));
  }
  if (m === 'POST' && (mm = /^\/public\/v1\/posts\/([0-9a-f-]{36})\/publish$/i.exec(p))) return send2(200, await API.publishPost(u, mm[1]));
  if (m === 'GET' && p === '/public/v1') return send2(200, { name: 'Editums API', version: 1, docs: CFG.appUrl + '/#app-developers' });
  throw httpError(404, `No such endpoint: ${m} ${p}`);
}

// MCP (Streamable HTTP, JSON responses): POST /mcp with the same API key.
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_TOOLS = [
  { name: 'list_channels', description: 'List the social channels connected to this Editums account (id, network, handle). Use a channel id when creating posts.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
    run: u => API.channels(u) },
  { name: 'list_posts', description: 'List recent posts, newest first. Optionally filter by status: draft, scheduled, published, failed.', inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Comma-separated statuses, e.g. "scheduled,draft"' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } }, annotations: { readOnlyHint: true },
    run: (u, a) => API.listPosts(u, a) },
  { name: 'create_post', description: 'Create a post on one channel. Give publish_at (ISO 8601 with time zone) to schedule it, publish_now=true to publish immediately, or neither to save a draft. Bluesky allows 300 characters, Mastodon 500.',
    inputSchema: { type: 'object', required: ['channel_id', 'text'], properties: { channel_id: { type: 'string' }, text: { type: 'string' }, publish_at: { type: 'string', description: 'e.g. 2026-11-02T15:00:00-05:00' }, publish_now: { type: 'boolean' }, image_urls: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Public image URLs to attach' } } },
    annotations: { destructiveHint: false, openWorldHint: true }, run: (u, a) => API.createPost(u, a) },
  { name: 'update_post', description: 'Edit a draft, scheduled or failed post: change its text, channel or time. Set publish_at to reschedule, or draft=true to unschedule.',
    inputSchema: { type: 'object', required: ['post_id'], properties: { post_id: { type: 'string' }, text: { type: 'string' }, channel_id: { type: 'string' }, publish_at: { type: 'string' }, draft: { type: 'boolean' } } },
    run: (u, a) => API.updatePost(u, a.post_id, a) },
  { name: 'publish_post', description: 'Publish an existing draft or scheduled post right now.', inputSchema: { type: 'object', required: ['post_id'], properties: { post_id: { type: 'string' } } },
    annotations: { openWorldHint: true }, run: (u, a) => API.publishPost(u, a.post_id) },
  { name: 'delete_post', description: 'Delete a draft, scheduled or failed post. Published posts can’t be deleted here.', inputSchema: { type: 'object', required: ['post_id'], properties: { post_id: { type: 'string' } } },
    annotations: { destructiveHint: true }, run: (u, a) => API.deletePost(u, a.post_id) },
  { name: 'get_analytics', description: 'Followers per channel and likes, reposts and replies for posts published in the last N days (default 30).', inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } } }, annotations: { readOnlyHint: true },
    run: (u, a) => { rateLimit(u.keyId + ':analytics', 10); return API.analytics(u, a); } },
];
async function mcpOne(u, msg) {
  const isReq = msg && msg.jsonrpc === '2.0' && msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
  if (!isReq) return null; // notifications and responses get no reply
  const ok = result => ({ jsonrpc: '2.0', id: msg.id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize': {
      const want = msg.params?.protocolVersion;
      return ok({ protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[1], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'editums', title: 'Editums', version: '1.0.0' },
        instructions: 'Editums schedules and publishes social media posts. Call list_channels first to get channel ids, then create_post. Times are ISO 8601; include a time zone offset.' });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: MCP_TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = MCP_TOOLS.find(t => t.name === msg.params?.name);
      if (!tool) return err(-32602, 'Unknown tool: ' + msg.params?.name);
      try {
        const result = await tool.run(u, msg.params?.arguments || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result });
      } catch (e) {
        if (!e.status) console.error('mcp tool', tool.name, e);
        return ok({ content: [{ type: 'text', text: e.status ? e.message : 'Something went wrong. Try again.' }], isError: true });
      }
    }
    default: return err(-32601, 'Method not found: ' + msg.method);
  }
}
async function handleMcp(req, res) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  let u;
  try { u = await authApiKey(req); }
  catch (e) { res.writeHead(e.status || 401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: e.message } })); }
  let body;
  try { body = await readJson(req); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); }
  const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map(m => mcpOne(u, m)))).filter(Boolean);
  if (!replies.length) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
}

// ---------- Stripe billing webhook ----------
// Stripe → POST /v1/stripe/webhook. Verifies the Stripe-Signature header with STRIPE_WEBHOOK_SECRET,
// then keeps public.subscriptions in sync. Checkout links carry ?client_reference_id=<user id>.
const STRIPE_SECRET = env('STRIPE_WEBHOOK_SECRET', '');
const PLAN_BY_AMOUNT = { month: { 900: 'starter', 1900: 'creator', 3900: 'team', 8900: 'agency' }, year: { 8400: 'starter', 18000: 'creator', 37200: 'team', 85200: 'agency' } };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function readRaw(req, max = 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw httpError(413, 'Request too large.'); chunks.push(c); }
  return Buffer.concat(chunks);
}
function verifyStripe(raw, header, secret, toleranceSec = 300) {
  const parts = {}; for (const kv of String(header || '').split(',')) { const [k, v] = kv.split('='); if (k && v) (parts[k.trim()] ||= []).push(v.trim()); }
  const t = Number(parts.t?.[0]);
  if (!t || !parts.v1?.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  return parts.v1.some(sig => { const b = Buffer.from(sig, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
}
const stripeStateFile = () => path.join(CFG.mediaDir, 'stripe-state.json');
async function loadStripeState() { try { return JSON.parse(await fs.readFile(stripeStateFile(), 'utf8')); } catch { return { pending: {}, last: {} }; } }
async function saveStripeState(st) { await fs.mkdir(CFG.mediaDir, { recursive: true }); await fs.writeFile(stripeStateFile() + '.tmp', JSON.stringify(st)); await fs.rename(stripeStateFile() + '.tmp', stripeStateFile()); }
function subRow(sub) {
  const item = sub.items?.data?.[0] || {}, price = item.price || sub.plan || {};
  const interval = price.recurring?.interval || price.interval;
  // The current price decides the plan: subscription metadata keeps the original plan after a switch in the customer portal.
  const plan = String(price.metadata?.plan || PLAN_BY_AMOUNT[interval]?.[price.unit_amount ?? price.amount] || sub.metadata?.plan || '').toLowerCase() || null;
  const cycle = interval === 'year' ? 'yearly' : interval === 'month' ? 'monthly' : (sub.metadata?.cycle || null);
  const ts = s => s ? new Date(s * 1000).toISOString() : null;
  return { plan, billing_period: cycle, status: sub.status === 'incomplete_expired' ? 'canceled' : sub.status,
    trial_ends_at: ts(sub.trial_end), current_period_end: ts(item.current_period_end || sub.current_period_end), provider_customer_id: sub.customer };
}
let stripeLock = Promise.resolve();
async function handleStripe(req, res) {
  if (!STRIPE_SECRET) throw httpError(503, 'Billing webhook is not configured.');
  const raw = await readRaw(req);
  if (!verifyStripe(raw, req.headers['stripe-signature'], STRIPE_SECRET)) throw httpError(400, 'Invalid signature.');
  const event = JSON.parse(raw.toString('utf8'));
  // One event at a time so out-of-order deliveries can't race each other.
  const run = stripeLock.then(() => applyStripeEvent(event));
  stripeLock = run.catch(() => {});
  await run;
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"received":true}');
}
async function applyStripeEvent(event) {
  const st = await loadStripeState();
  const obj = event.data?.object || {};
  const now = new Date().toISOString();
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
    let userId = UUID_RE.test(obj.client_reference_id || '') ? obj.client_reference_id : null;
    if (userId && !(await db('profiles?user_id=eq.' + q(userId) + '&select=user_id'))?.length) userId = null;
    if (!userId && obj.customer_details?.email) {
      const [p] = await db('profiles?email=ilike.' + q(obj.customer_details.email.replace(/[%_]/g, '')) + '&select=user_id') || [];
      userId = p?.user_id || null;
    }
    if (!userId) { console.warn('stripe: checkout without a matching Editums user', obj.id); return; }
    const pending = st.pending[obj.customer]?.row || { plan: null, billing_period: null, status: 'incomplete' }; // filled in by the subscription event
    await db('subscriptions', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { user_id: userId, ...pending, provider_customer_id: obj.customer, updated_at: now } });
    delete st.pending[obj.customer];
    await saveStripeState(st);
    await notify(userId, 'Your Editums trial has started', pending.plan ? `Plan: ${pending.plan[0].toUpperCase() + pending.plan.slice(1)}` : 'Welcome aboard!', '#app-billing');
    console.log('stripe: linked', obj.customer, 'to', userId);
    return;
  }
  if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(event.type)) {
    const row = subRow(obj);
    if (event.type === 'customer.subscription.deleted') row.status = 'canceled';
    // Ignore events older than the last one applied for this customer.
    if ((st.last[obj.customer] || 0) > event.created) return;
    st.last[obj.customer] = event.created;
    const updated = await db('subscriptions?provider_customer_id=eq.' + q(obj.customer), { method: 'PATCH', prefer: 'return=representation', body: { ...row, updated_at: now } });
    if (!updated?.length) st.pending[obj.customer] = { row, at: Date.now() }; // checkout.session.completed hasn't linked the user yet
    for (const [k, v] of Object.entries(st.pending)) if (Date.now() - v.at > 30 * 86400000) delete st.pending[k];
    await saveStripeState(st);
    console.log('stripe:', event.type, obj.customer, row.plan, row.status, updated?.length ? '' : '(pending)');
  }
}

// ---------- HTTP ----------
function send(res, status, body, origin) {
  const h = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (origin) Object.assign(h, { 'access-control-allow-origin': origin, vary: 'Origin' });
  res.writeHead(status, h); res.end(JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, CFG.publicUrl), origin = CFG.origins.includes(req.headers.origin) ? req.headers.origin : null;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'authorization,content-type,x-file-name,x-width,x-height,range', 'access-control-max-age': '600', vary: 'Origin' } : {});
    return res.end();
  }
  try {
    const route = req.method + ' ' + url.pathname;
    if (url.pathname === '/mcp') return await handleMcp(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/stripe/webhook') return await handleStripe(req, res);
    if (url.pathname === '/public/v1' || url.pathname.startsWith('/public/v1/')) return await handlePublic(req, res, url);
    if (route === 'GET /health') return send(res, 200, { ok: true, providers: Object.keys(PUBLISHERS).filter(p => p !== 'facebook' || (FB.appId && FB.secret)), ai: { maui: !!claude, media: !!CFG.falKey, clips: !!(claude && CFG.falKey) }, api: { rest: '/public/v1', mcp: '/mcp' }, billing: !!STRIPE_SECRET }, origin);
    if (route === 'GET /v1/oauth/mastodon/callback') {
      let to = CFG.appUrl + '/?connected=mastodon#app-calendar';
      try { await mastoCallback(url.searchParams); } catch (e) { to = CFG.appUrl + '/?channel_error=' + q(e.message) + '#app-calendar'; }
      res.writeHead(302, { location: to }); return res.end();
    }
    if (route === 'GET /v1/oauth/facebook/callback') {
      let to = CFG.appUrl + '/?connected=facebook#app-calendar';
      try { await fbCallback(url.searchParams); } catch (e) { to = CFG.appUrl + '/?channel_error=' + q(e.message) + '#app-calendar'; }
      res.writeHead(302, { location: to }); return res.end();
    }
    if (route === 'POST /v1/channels/facebook/start') { const u = await authUser(req); return send(res, 200, await fbStart(u.id), origin); }
    if (route === 'GET /v1/analytics') { const u = await authUser(req); return send(res, 200, await API.analytics(u, Object.fromEntries(url.searchParams)), origin); }
    if (route === 'POST /v1/channels/bluesky') { const u = await authUser(req); const row = await bskyConnect(u.id, await readJson(req)); return send(res, 201, { channel: row }, origin); }
    if (route === 'GET /v1/usage') { const u = await authUser(req); return send(res, 200, await usageSummary(u.id), origin); }
    if (route === 'POST /v1/ai/chat') { const u = await authUser(req); return send(res, 200, await mauiChat(u.id, await readJson(req)), origin); }
    if (route === 'POST /v1/ai/image' || route === 'POST /v1/ai/video') { const u = await authUser(req); return send(res, 202, await startGeneration(u.id, url.pathname.endsWith('image') ? 'image' : 'video', await readJson(req)), origin); }
    const jobm = /^\/v1\/ai\/jobs\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (req.method === 'GET' && jobm) { const u = await authUser(req); return send(res, 200, await checkJob(u.id, jobm[1]), origin); }
    const mediam = /^\/v1\/media\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && mediam) return serveMedia(req, res, mediam[1], origin);
    if (route === 'POST /v1/feeds/check') { const u = await authUser(req); return send(res, 200, await checkFeedsNow(u.id), origin); }
    if (route === 'POST /v1/team/accept') { const u = await authUser(req); return send(res, 200, await acceptInvite(u, await readJson(req)), origin); }
    if (route === 'POST /v1/clips/upload') { const u = await authUser(req); return send(res, 201, await saveClipSource(u.id, req), origin); }
    if (route === 'POST /v1/ai/clip') { const u = await authUser(req); return send(res, 202, await startClipping(u.id, await readJson(req)), origin); }
    if (route === 'POST /v1/media') { const u = await authUser(req); return send(res, 201, await saveMedia(u.id, req), origin); }
    if (route === 'POST /v1/channels/mastodon/start') { const u = await authUser(req); return send(res, 200, await mastoStart(u.id, await readJson(req)), origin); }
    const pub = /^\/v1\/posts\/([0-9a-f-]{36})\/publish$/i.exec(url.pathname);
    if (req.method === 'POST' && pub) {
      const u = await authUser(req);
      const [post] = await db('posts?id=eq.' + q(pub[1]) + '&user_id=eq.' + q(u.id) + '&select=*');
      if (!post) throw httpError(404, 'Post not found. Save it first.');
      if (post.status === 'published') throw httpError(409, 'This post is already published.');
      await db('posts?id=eq.' + q(post.id), { method: 'PATCH', prefer: 'return=minimal', body: { status: 'publishing_now' } });
      return send(res, 200, await runPost(post) || { status: 'publishing' }, origin);
    }
    send(res, 404, { error: 'not_found' }, origin);
  } catch (e) {
    if (!e.status) console.error(e);
    if (e.retryAfter) res.setHeader('retry-after', String(e.retryAfter));
    if (url.pathname.startsWith('/public/')) res.setHeader('access-control-allow-origin', '*');
    send(res, e.status || 500, { error: e.status ? 'request_failed' : 'server_error', message: e.status ? e.message : 'Something went wrong. Try again.' }, origin);
  }
});
server.listen(CFG.port, () => console.log(`Editums publisher on :${CFG.port}, checking every ${CFG.tickSeconds}s`));
setInterval(tick, CFG.tickSeconds * 1000); setTimeout(tick, 3000);
setInterval(runPlugs, CFG.plugMinutes * 60000); setTimeout(runPlugs, 20000);
setInterval(runFeeds, CFG.feedMinutes * 60000); setTimeout(runFeeds, 40000);
