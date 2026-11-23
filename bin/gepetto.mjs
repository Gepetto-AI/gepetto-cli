#!/usr/bin/env node
// @gepetto/cli (ex gepetto-cli) : connecter un projet à l'API Gepetto v2 depuis le terminal, pour une personne ou pour son agent de code.
// Aucune dépendance (Node 18 ou plus). Toutes les commandes acceptent --json pour une sortie lisible par une machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const VERSION = '0.3.0';
const API = (process.env.GEPETTO_API_URL || 'https://europe-west1-gepettoai.cloudfunctions.net/v2').replace(/\/$/, '');
// The keys go wherever GEPETTO_API_URL points: https only (http allowed for a local server)
{
  let ok = false;
  try { const u = new URL(API); ok = u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)); } catch { /* invalid */ }
  if (!ok) { console.error(`Error (invalid_api_url): GEPETTO_API_URL must be an https URL (or http://localhost), not "${API}".`); process.exit(1); }
}
/** The only sites the CLI opens in the browser: the approval page and the payment page. */
const BROWSER_HOSTS = ['app.gepettoapp.com', 'pay.gepettoapp.com', 'checkout.stripe.com'];
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'gepetto');
const CREDENTIALS = path.join(CONFIG_DIR, 'credentials.json');
const TOOLS = ['declutter', 'furnish', 'sunshine', 'creative-redesign', 'surfaces', 'enhance', 'upscale', 'camera-move', 'transition'];
/** Under /v2/video: always asynchronous, followed here until the MP4 is ready (live key only). */
const VIDEOS = ['camera-move', 'transition'];
const LISTS = ['rooms', 'styles', 'furnitures', 'skies', 'surfaces', 'transitions'];

// --- arguments ---

const argv = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [rawName, inline] = a.slice(2).split(/=(.*)/s, 2);
    const name = rawName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
    else flags[name] = true;
  } else positional.push(a);
}
const JSON_OUT = flags.json === true;
delete flags.json;

// --- sortie ---

const out = (human, data) => {
  if (JSON_OUT) console.log(JSON.stringify(data ?? { message: human }));
  else if (human) console.log(human);
};
function fail(code, message, extra = {}) {
  if (JSON_OUT) console.log(JSON.stringify({ status: 'error', code, message, ...extra }));
  else console.error(`Error (${code}): ${message}`);
  process.exit(1);
}

// --- HTTP ---

async function api(method, route, { token, body, raw, contentType, query } = {}) {
  const url = new URL(API + route);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers = { 'User-Agent': `gepetto-cli/${VERSION}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) { payload = raw; headers['Content-Type'] = contentType; }
  else if (body) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch (e) {
    fail('network_error', `Could not reach ${API} (${e.message}).`);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { status: 'error', code: `http_${res.status}`, message: text.slice(0, 300) }; }
  if (!res.ok) fail(json.code || `http_${res.status}`, json.message || `HTTP ${res.status}`, json.id ? { id: json.id } : {});
  return json;
}

// --- identifiants ---

const readCredentials = () => { try { return JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8')); } catch { return null; } };
function writeCredentials(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CREDENTIALS, JSON.stringify(data, null, 2), { mode: 0o600 });
  // The modes above only apply to new files: forced, in case they existed with wider rights
  try { fs.chmodSync(CONFIG_DIR, 0o700); fs.chmodSync(CREDENTIALS, 0o600); } catch { /* Windows */ }
}
function session() {
  const c = readCredentials();
  if (!c?.token) fail('cli_login_required', 'Not signed in: run `npx @gepetto/cli login` first.');
  return c.token;
}

/** GEPETTO_API_KEY from a dotenv file of the current directory. */
function keyFromEnvFiles() {
  for (const file of ['.env.local', '.env']) {
    try {
      const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => /^\s*GEPETTO_API_KEY\s*=/.test(l));
      if (line) return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    } catch { /* no file */ }
  }
  return null;
}

/** The API key: --key, then GEPETTO_API_KEY, then .env.local / .env, then the test key of the signed-in account. */
async function apiKey() {
  if (typeof flags.key === 'string') return flags.key;
  if (process.env.GEPETTO_API_KEY) return process.env.GEPETTO_API_KEY;
  const fromFile = keyFromEnvFiles();
  if (fromFile) return fromFile;
  if (readCredentials()?.token) return (await api('GET', '/cli/keys', { token: session() })).test_key;
  fail('missing_api_key', 'No API key: run `npx @gepetto/cli login` then `npx @gepetto/cli init`, or set GEPETTO_API_KEY.');
}

/** Sets NAME=value in a dotenv file (replaced if present), and makes sure git ignores the file. */
function writeEnv(file, name, value) {
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const line = `${name}=${value}`;
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
  content = re.test(content) ? content.replace(re, line) : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.writeFileSync(file, content, { mode: 0o600 });
  let gitignore = '';
  try { gitignore = fs.readFileSync('.gitignore', 'utf8'); } catch { /* none */ }
  const ignored = gitignore.split('\n').map((l) => l.trim()).some((l) => l === file || l === `/${file}` || l === '.env*' || (file.startsWith('.env') && l === '.env*.local' && file.endsWith('.local')));
  if (!ignored) fs.appendFileSync('.gitignore', `${gitignore && !gitignore.endsWith('\n') ? '\n' : ''}${file}\n`);
  return !ignored;
}

/** Opens a Gepetto or Stripe page in the browser, without going through a shell (the link is printed anyway). */
function openBrowser(url) {
  if (flags.noBrowser) return;
  let target;
  try { target = new URL(url); } catch { return; }
  if (target.protocol !== 'https:' || !BROWSER_HOSTS.includes(target.hostname)) return;
  const href = target.toString();
  const [cmd, args] = process.platform === 'darwin' ? ['open', [href]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', href]]
      : ['xdg-open', [href]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false }).on('error', () => {}).unref(); } catch { /* printed anyway */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heic' };

/** A local file is sent with POST /v2/uploads; a URL is kept as it is. */
async function imageUrl(value, key, label) {
  if (/^https?:\/\//i.test(value)) return value;
  if (!fs.existsSync(value)) fail('file_not_found', `${label}: no file "${value}".`);
  const type = MIME[path.extname(value).toLowerCase()];
  if (!type) fail('unsupported_image', `${label}: use a JPEG, PNG, WebP or HEIC file.`);
  const data = fs.readFileSync(value);
  if (data.length > 10 * 1024 * 1024) fail('file_too_large', `${label}: 10 MB at most for an upload; give a public URL instead.`);
  return (await api('POST', '/uploads', { token: key, raw: data, contentType: type })).url;
}

// --- commandes ---

const commands = {
  async login() {
    const device = await api('POST', '/cli/device', { body: { client: `@gepetto/cli ${VERSION}`, host: os.hostname() } });
    if (JSON_OUT) console.log(JSON.stringify({ event: 'authorize', url: device.verification_url, code: device.user_code, expires_in: device.expires_in }));
    else console.log(`Open ${device.verification_url} and check that the code is ${device.user_code}, then click "Authorize".\nWaiting for the authorization…`);
    openBrowser(device.verification_url);
    const deadline = Date.now() + device.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep((device.interval || 3) * 1000);
      const r = await api('POST', '/cli/token', { body: { device_code: device.device_code } });
      if (r.status === 'approved') {
        writeCredentials({ token: r.token, email: r.email, created_at: new Date().toISOString() });
        return out(`Signed in as ${r.email}. Next: npx @gepetto/cli init`, { event: 'logged_in', email: r.email });
      }
    }
    fail('code_expired', 'The code expired before it was approved. Run the command again.');
  },

  async logout() {
    const c = readCredentials();
    let revoked = false;
    if (c?.token) {
      // The session is revoked on the server, not only forgotten here
      try {
        const r = await fetch(`${API}/cli/logout`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'User-Agent': `gepetto-cli/${VERSION}` } });
        revoked = r.ok || r.status === 401;
      } catch { /* offline */ }
    }
    try { fs.unlinkSync(CREDENTIALS); } catch { /* already out */ }
    out(revoked || !c?.token ? 'Signed out.' : 'Signed out here, but the server could not be reached to revoke the session: run logout again when online, or wait for it to expire (90 days).',
      { status: 'signed_out', revoked });
  },

  async whoami() {
    const c = readCredentials();
    if (!c?.token) fail('cli_login_required', 'Not signed in: run `npx @gepetto/cli login`.');
    out(`Signed in as ${c.email}.`, { email: c.email });
  },

  async init() {
    const keys = await api('GET', '/cli/keys', { token: session() });
    const file = typeof flags.env === 'string' ? flags.env : '.env';
    const added = writeEnv(file, 'GEPETTO_API_KEY', keys.test_key);
    out(`Test key written to ${file} (GEPETTO_API_KEY)${added ? `, ${file} added to .gitignore` : ''}.\nTest keys make 200 free renders. For production: npx @gepetto/cli subscribe`,
      { status: 'ok', file, key_type: 'test', gitignore_updated: added });
  },

  /** The keys of the account, masked unless --show (a key printed in a terminal ends up in logs and in agents' context). */
  async keys() {
    const k = await api('GET', '/cli/keys', { token: session() });
    const show = flags.show === true;
    const mask = (key) => (key ? (show ? key : `${key.slice(0, 9)}…${key.slice(-4)}`) : null);
    if (JSON_OUT) return console.log(JSON.stringify({ email: k.email, test_key: mask(k.test_key), live_key: mask(k.live_key), masked: !show }));
    console.log(`Account ${k.email}\n  test  ${mask(k.test_key)}\n  live  ${mask(k.live_key) ?? '(none: npx @gepetto/cli subscribe)'}${show ? '' : '\nAdd --show to print them in full.'}`);
  },

  async subscribe() {
    const token = session();
    const { url } = await api('POST', '/cli/subscribe', { token });
    if (JSON_OUT) console.log(JSON.stringify({ event: 'checkout', url }));
    else console.log(`API subscription: €100 excl. tax per month including €100 of renders, then pay as you go, plus a one-time €50 activation fee.\nPayment: ${url}\nWaiting for the payment…`);
    openBrowser(url);
    const file = typeof flags.env === 'string' ? flags.env : '.env.production.local';
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const keys = await api('GET', '/cli/keys', { token });
      if (keys.live_key) {
        const added = writeEnv(file, 'GEPETTO_API_KEY', keys.live_key);
        return out(`Payment received. Live key written to ${file} (GEPETTO_API_KEY)${added ? `, ${file} added to .gitignore` : ''}.`, { event: 'subscribed', file });
      }
    }
    fail('payment_timeout', 'No payment after 30 minutes. Run the command again once paid: the key will be written.');
  },

  /** The Stripe customer portal of the account: invoices, payment method, cancellation. */
  async billing() {
    const { url } = await api('POST', '/cli/billing', { token: session() });
    out(`Billing (invoices, payment method, cancellation): ${url}`, { event: 'billing', url });
    openBrowser(url);
  },

  async run() {
    const tool = positional[1];
    if (!TOOLS.includes(tool)) fail('unknown_tool', `Tool: ${TOOLS.join(', ')}. Example: npx @gepetto/cli run declutter --image ./room.jpg`);
    const key = await apiKey();
    const video = VIDEOS.includes(tool);
    const { image, mask, end, transition, out: outFile, key: _k, noBrowser: _n, ...rest } = flags;
    const body = { ...rest };
    if (typeof image === 'string') body.url = await imageUrl(image, key, '--image');
    else if (!(tool === 'transition' && body.jobId)) fail('missing_parameter', '--image is required (a local file or a URL).');
    if (typeof mask === 'string') body.mask = await imageUrl(mask, key, '--mask');
    if (typeof end === 'string') body.endUrl = await imageUrl(end, key, '--end');
    if (typeof transition === 'string') body.transitionId = transition;
    if (!JSON_OUT) console.log(body.webhook ? 'Sending the job…' : video ? 'Making the video (2 to 10 minutes)…' : 'Rendering (about 15 to 60 s)…');
    let job = await api('POST', video ? `/video/${tool}` : `/${tool}`, { token: key, body });
    // A video answers 202 at once: follow it until it is done (30 minutes at most, as the API)
    const deadline = Date.now() + 30 * 60 * 1000;
    while (video && !body.webhook && (job.status === 'pending' || job.status === 'processing') && Date.now() < deadline) {
      await sleep(5000);
      job = await api('GET', `/job/${encodeURIComponent(job.id)}`, { token: key });
    }
    if (job.status === 'error') fail(job.error?.code ?? 'render_failed', `${job.error?.message ?? 'The render failed.'} (job ${job.id})`);
    if (job.status !== 'success') return out(`Job ${job.id}: ${job.status}. Follow it with: npx @gepetto/cli job ${job.id}`, job);
    // Default name built from what the server sent: only letters, digits, - and _, and a known extension
    const ext = path.extname(new URL(job.output).pathname).toLowerCase();
    const safeId = String(job.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'output';
    const known = video ? ['.mp4'] : ['.jpg', '.jpeg', '.png', '.webp'];
    const target = typeof outFile === 'string' ? outFile : `${tool}-${safeId}${known.includes(ext) ? ext : known[0]}`;
    fs.writeFileSync(target, Buffer.from(await (await fetch(job.output)).arrayBuffer()));
    out(`Done in ${job.createdAt && job.finishedAt ? Math.round((Date.parse(job.finishedAt) - Date.parse(job.createdAt)) / 1000) + ' s' : '—'}: ${target} (${job.test ? 'test key' : `${job.priceCents} cents`})`, { ...job, file: target });
  },

  async job() {
    const id = positional[1];
    if (!id) fail('missing_parameter', 'Usage: npx @gepetto/cli job <id>');
    const job = await api('GET', `/job/${encodeURIComponent(id)}`, { token: await apiKey() });
    out(`${job.id} ${job.tool} ${job.status}${job.output ? ' ' + job.output : ''}${job.error ? ` (${job.error.code}: ${job.error.message})` : ''}`, job);
  },

  async jobs() {
    const list = await api('GET', '/jobs', { token: await apiKey(), query: { status: flags.failed ? 'error' : undefined, limit: flags.limit } });
    if (JSON_OUT) return console.log(JSON.stringify(list));
    if (!list.length) return console.log('No job.');
    for (const j of list) console.log(`${j.createdAt?.slice(0, 16).replace('T', ' ')}  ${j.id}  ${j.tool.padEnd(17)} ${j.status.padEnd(10)} ${j.error ? `${j.error.code}: ${j.error.message}` : j.output ?? ''}`);
  },

  async usage() {
    const u = await api('GET', '/usage', { token: await apiKey() });
    if (JSON_OUT) return console.log(JSON.stringify(u));
    const tools = Object.entries(u.byTool).map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
    if (u.key_type === 'test') return console.log(`Test key: ${u.testRenders.used} of ${u.testRenders.limit} free renders used. This month: ${u.renders} renders (${tools}).`);
    console.log(`Since ${u.periodStart.slice(0, 10)}: ${u.renders} renders (${tools}), €${(u.consumedCents / 100).toFixed(2)} used of the €${(u.includedCents / 100).toFixed(2)} included${u.overageCents ? `, €${(u.overageCents / 100).toFixed(2)} over` : ''}.`);
  },

  async list() {
    const what = positional[1];
    if (!LISTS.includes(what)) fail('unknown_list', `List: ${LISTS.join(', ')}`);
    const data = await api('GET', what === 'transitions' ? '/video/transitions' : `/${what}`, { token: await apiKey() });
    if (JSON_OUT) return console.log(JSON.stringify(data));
    const show = (items) => items.map((x) => `  ${x.id}${x.name_en || x.name ? `  (${x.name_en || x.name})` : ''}${x.modes ? `  modes: ${x.modes.join(', ')}` : ''}`).join('\n');
    if (Array.isArray(data)) console.log(show(data));
    else for (const [group, items] of Object.entries(data)) console.log(`${group}:\n${show(items)}`);
  },

  async webhook() {
    if (positional[1] !== 'test' || !positional[2]) fail('missing_parameter', 'Usage: npx @gepetto/cli webhook test <url>   (for example http://localhost:3000/api/gepetto)');
    const account = await api('GET', '/account', { token: await apiKey() });
    const now = new Date().toISOString();
    const samples = {
      success: { id: 'job_test_success', status: 'success', tool: 'declutter', mode: 'zone', output: 'https://assets.gepettoapp.com/samples/pavillon/sejour.png', error: null, priceCents: 0, test: true, createdAt: now, finishedAt: now },
      error: { id: 'job_test_error', status: 'error', tool: 'declutter', mode: 'zone', output: null, error: { code: 'render_failed', message: 'The render failed. You were not charged.' }, priceCents: 0, test: true, createdAt: now, finishedAt: now },
    };
    const results = {};
    for (const [name, payload] of Object.entries(samples)) {
      const body = JSON.stringify(payload);
      const t = Math.floor(Date.now() / 1000);
      const v1 = crypto.createHmac('sha256', account.webhook_secret).update(`${t}.${body}`).digest('hex');
      try {
        const r = await fetch(positional[2], { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Gepetto-Webhooks/2', 'Gepetto-Signature': `t=${t},v1=${v1}` }, body });
        results[name] = r.status;
      } catch (e) {
        results[name] = `unreachable (${e.message})`;
      }
      if (!JSON_OUT) console.log(`render ${name.padEnd(8)} -> ${typeof results[name] === 'number' ? `HTTP ${results[name]}` : results[name]}`);
    }
    if (JSON_OUT) console.log(JSON.stringify({ results }));
    else console.log('Signature: header Gepetto-Signature "t=<unix time>,v1=<hex>", HMAC-SHA256 of "<t>.<raw body>" with your webhook secret (npx @gepetto/cli secret).');
  },

  async secret() {
    const account = await api('GET', '/account', { token: await apiKey() });
    out(account.webhook_secret, { webhook_secret: account.webhook_secret });
  },

  help() {
    console.log(`@gepetto/cli ${VERSION}: Gepetto API v2 (real estate photo editing) from the terminal.

  login                          Sign in with your Gepetto account (opens a page, you click "Authorize")
  init [--env .env]              Write your test key (200 free renders) to .env as GEPETTO_API_KEY
  keys [--show]                  Your test and live keys (masked unless --show)
  run <tool> --image <file|url> [--mask <file|url>] [--out file] [--<param> value]
                                 Tools: ${TOOLS.join(', ')}
                                 e.g. run furnish --image room.jpg --roomId bedroom --styleId modern
                                 Videos (live key): run camera-move --image room.jpg --camera zoom_in
                                 run transition --image before.jpg --end after.jpg --transition <id>
                                 (or --jobId <id of a finished render>, or --prompt "...")
  list <${LISTS.join('|')}>  Valid ids for the parameters
  job <id> | jobs [--failed]     A job, or the latest ones (with the reason of a failure)
  usage                          Renders and consumption of the period
  webhook test <url>             Send a signed success and failure to your webhook endpoint
  secret                         Your webhook signing secret
  subscribe                      Payment link of the subscription; writes the live key once paid
  billing                        Invoices, payment method and cancellation (Stripe portal)
  logout | whoami

  Every command accepts --json. Docs: https://docs.gepettoapp.com`);
  },
};

const name = positional[0] || 'help';
if (!commands[name] || name === 'help' || flags.help) commands.help();
else commands[name]().catch((e) => fail('cli_error', e.message));
