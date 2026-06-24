// PentLux hub content API
// Serves media (photos + EN/MK video IDs) to the guest hub, and saves it from the panel.
//
// Deploy on Railway (new service, or alongside the Lara bot).
// Env vars required:
//   DATABASE_URL     - your Neon connection string (the same one the bot uses is fine)
//   ADMIN_TOKEN      - a long random password; the panel must send it to save
//
// Env vars for Shelly light control (each apartment is a separate Shelly account):
//   SHELLY_AUTH_KEY_49 / SHELLY_SERVER_49  - Apt 49's "Get key" + server URL
//   SHELLY_AUTH_KEY_50 / SHELLY_SERVER_50  - Apt 50's "Get key" + server URL
//   CONTROL_TOKEN    - a long random password gating who can flip lights (temporary,
//                      replaced by per-stay guest tokens later)
//
// Routes:
//   GET  /api/media/:apt   -> public, returns the media JSON for that apartment
//   POST /api/media/:apt   -> protected by ADMIN_TOKEN, saves the media JSON
//   GET  /api/lights/:apt  -> lists the lights configured for that apartment
//   POST /api/light        -> flips a light on/off via Shelly Cloud (needs CONTROL_TOKEN)

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },     // Neon needs SSL
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// --- CORS (the hub & panel are served from your Hostinger domain) ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');           // media is public content
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const VALID_APTS = ['apt49', 'apt50'];

// ====== SHELLY LIGHTS ======
// Fill in each light once you have the Device IDs from the Shelly app.
// type: 'relay' for on/off lights (most common), 'light' for dimmers.
// channel: usually 0 (use 1 for the second output on a 2-channel device).
const LIGHTS = {
  apt49: [
    { key: 'kitchen',    name: 'Kitchen',          deviceId: '8caab54c4cc3', type: 'light' },
    { key: 'hallway',    name: 'Hallway',          deviceId: '8caab54cf39f', type: 'light' },
    { key: 'bar',        name: 'Bar',              deviceId: '483fda9198d3', type: 'light' },
    { key: 'shower',     name: 'Shower',           deviceId: '8caab54cf67e', type: 'light' },
    { key: 'bed',        name: 'Bed lights',       deviceId: '30c9224b7fd0', type: 'light' },
    { key: 'living',     name: 'Living room',      deviceId: '441793a852c0', type: 'light' },
    { key: 'mainled',    name: 'Main LED',         deviceId: 'a5b52b',       type: 'light' },
    { key: 'kitchenled', name: 'Kitchen LED',      deviceId: 'a68c2d',       type: 'light' },
    { key: 'mirrorled',  name: 'Mirror LED',       deviceId: 'a57450',       type: 'light' },
    { key: 'stairsled',  name: 'Stairs LED',       deviceId: 'a6afec',       type: 'light' },
    { key: 'logoled',    name: 'Logo LED',         deviceId: 'a5b535',       type: 'light' },
    { key: 'saunaled',   name: 'Sauna LED',        deviceId: 'a56b06',       type: 'light' },
    { key: 'projector',  name: 'Projector screen', deviceId: '10061cfad170', type: 'cover', favPos: 51 },
    { key: 'entrance',   name: 'Building entrance', deviceId: '8caab5560679', type: 'relay', acct: 'entrance', channel: 1 },
  ],
  apt50: [
    // Apt 50 lights go here once you grab their Device IDs.
    { key: 'entrance', name: 'Building entrance', deviceId: '8caab5560679', type: 'relay', acct: 'entrance', channel: 1 },
  ],
};

function findLight(apt, key) {
  return (LIGHTS[apt] || []).find(l => l.key === key);
}

// Each apartment is a separate Shelly account, with its own key + server.
// Shared devices (the building entrance) must use their OWNER account's key.
// Set these in Railway Variables:
//   apt49    -> SHELLY_SERVER_49, SHELLY_AUTH_KEY_49
//   apt50    -> SHELLY_SERVER_50, SHELLY_AUTH_KEY_50
//   entrance -> SHELLY_SERVER_ENTRANCE, SHELLY_AUTH_KEY_ENTRANCE  (the account that OWNS the door)
function shellyCreds(acct) {
  if (acct === 'apt49')    return { server: process.env.SHELLY_SERVER_49, key: process.env.SHELLY_AUTH_KEY_49 };
  if (acct === 'apt50')    return { server: process.env.SHELLY_SERVER_50, key: process.env.SHELLY_AUTH_KEY_50 };
  if (acct === 'entrance') return { server: process.env.SHELLY_SERVER_ENTRANCE, key: process.env.SHELLY_AUTH_KEY_ENTRANCE };
  return {};
}

// Calls Shelly Cloud to switch a device. For covers, "on" = open, "off" = close.
async function shellyControl(apt, dev, turnOn) {
  const { server, key } = shellyCreds(apt);
  if (!server || !key) throw new Error('Shelly not configured for ' + apt);

  let path, params;
  if (dev.type === 'cover') {
    path = '/device/relay/roller/control';
    params = { id: dev.deviceId, auth_key: key, direction: turnOn ? 'open' : 'close' };
  } else if (dev.type === 'relay') {
    path = '/device/relay/control';
    params = { id: dev.deviceId, channel: String(dev.channel ?? 0), turn: turnOn ? 'on' : 'off', auth_key: key };
  } else { // 'light', dimmers, RGB
    path = '/device/light/control';
    params = { id: dev.deviceId, channel: String(dev.channel ?? 0), turn: turnOn ? 'on' : 'off', auth_key: key };
  }

  const r = await fetch(server.replace(/\/+$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return r.json();
}

// ===== Shelly v2 cloud API (status + smart control) =====
async function shellyV2(apt, endpoint, bodyObj) {
  const { server, key } = shellyCreds(apt);
  if (!server || !key) throw new Error('Shelly not configured for ' + apt);
  const base = server.startsWith('http') ? server : 'https://' + server;
  const url = base.replace(/\/+$/, '') + endpoint + '?auth_key=' + encodeURIComponent(key);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { _raw: txt.slice(0, 300), _http: r.status }; }
}

// Reads one device object (from v2 get) into a simple shape: what it is + on/off + colour.
function parseDeviceState(dev) {
  const st = (dev && dev.status) || {};
  for (const k of Object.keys(st)) {
    const c = st[k] || {};
    if (k.startsWith('cover:'))  return { kind: 'cover',  channel: c.id || 0, state: c.state, pos: c.current_pos };
    if (k.startsWith('switch:')) return { kind: 'switch', channel: c.id || 0, on: !!c.output };
    if (k.startsWith('rgbw:'))   return { kind: 'rgbw',   channel: c.id || 0, on: !!c.output, rgb: c.rgb, white: c.white, gain: c.gain, brightness: c.brightness };
    if (k.startsWith('rgb:'))    return { kind: 'rgb',    channel: c.id || 0, on: !!c.output, rgb: c.rgb, gain: c.gain, brightness: c.brightness };
    if (k.startsWith('light:'))  return { kind: 'light',  channel: c.id || 0, on: !!c.output, brightness: c.brightness };
  }
  // Gen1 shapes
  if (Array.isArray(st.relays) && st.relays.length) return { kind: 'switch', channel: 0, on: !!st.relays[0].ison };
  if (Array.isArray(st.lights) && st.lights.length) {
    const l = st.lights[0];
    return { kind: (l.red !== undefined ? 'rgb' : 'light'), channel: 0, on: !!l.ison, rgb: [l.red, l.green, l.blue], gain: l.gain, brightness: l.brightness };
  }
  if (Array.isArray(st.rollers) && st.rollers.length) return { kind: 'cover', channel: 0, state: st.rollers[0].state };
  return { kind: 'unknown', online: dev && dev.online };
}

// --- READ (public) ---
app.get('/api/media/:apt', async (req, res) => {
  const apt = req.params.apt;
  if (!VALID_APTS.includes(apt)) return res.status(404).json({ error: 'unknown apartment' });
  try {
    const { rows } = await pool.query('SELECT data FROM media WHERE apt = $1', [apt]);
    res.json(rows[0] ? rows[0].data : {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'database error' });
  }
});

// --- WRITE (token-protected) ---
app.post('/api/media/:apt', async (req, res) => {
  const apt = req.params.apt;
  if (!VALID_APTS.includes(apt)) return res.status(404).json({ error: 'unknown apartment' });

  const auth = req.headers.authorization || '';
  if (!ADMIN_TOKEN || auth !== 'Bearer ' + ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const data = (req.body && typeof req.body === 'object') ? req.body : {};
  try {
    await pool.query(
      `INSERT INTO media (apt, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (apt) DO UPDATE SET data = $2, updated_at = now()`,
      [apt, data]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'database error' });
  }
});

// --- LIGHTS: list what's configured for an apartment (public; just names) ---
app.get('/api/lights/:apt', (req, res) => {
  const apt = req.params.apt;
  if (!VALID_APTS.includes(apt)) return res.status(404).json({ error: 'unknown apartment' });
  res.json((LIGHTS[apt] || []).map(l => ({ key: l.key, name: l.name, id: l.deviceId, type: l.type || 'switch', fav: l.favPos })));
});

// --- LIGHTS: flip one on/off (gated by CONTROL_TOKEN for now) ---
app.post('/api/light', async (req, res) => {
  const { apt, key, turn, token } = req.body || {};
  const need = process.env.CONTROL_TOKEN || '';
  if (need && token !== need) return res.status(401).json({ error: 'unauthorized' });
  if (!VALID_APTS.includes(apt)) return res.status(404).json({ error: 'unknown apartment' });
  const dev = findLight(apt, key);
  if (!dev) return res.status(404).json({ error: 'unknown light' });
  try {
    const out = await shellyControl(apt, dev, !!turn);
    if (out && out.isok === false) {
      return res.status(502).json({ error: 'Shelly refused: ' + JSON.stringify(out.errors || out) });
    }
    res.json({ ok: true, shelly: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- LIGHTS: live status for every device in an apartment (on/off, colour, type) ---
app.get('/api/status/:apt', async (req, res) => {
  const apt = req.params.apt;
  if (!VALID_APTS.includes(apt)) return res.status(404).json({ error: 'unknown apartment' });
  const devs = LIGHTS[apt] || [];
  const byAcct = {};
  devs.forEach(d => { const a = d.acct || apt; (byAcct[a] = byAcct[a] || []).push(d.deviceId); });
  const out = {};
  try {
    for (const acct of Object.keys(byAcct)) {
      const ids = byAcct[acct];
      const { server, key } = shellyCreds(acct);
      if (!server || !key) continue; // account not configured yet
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        const resp = await shellyV2(acct, '/v2/devices/api/get', { ids: batch, select: ['status'] });
        const arr = Array.isArray(resp) ? resp : (resp.data || resp.devices || []);
        arr.forEach(d => { out[d.id] = parseDeviceState(d); });
        await new Promise(r => setTimeout(r, 1100)); // respect 1 req/sec per account
      }
    }
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- LIGHTS: smart control (switch / light / rgb / cover), gated by CONTROL_TOKEN ---
app.post('/api/control', async (req, res) => {
  const { apt, id, kind, on, channel, color, cover, pulse, token } = req.body || {};
  const need = process.env.CONTROL_TOKEN || '';
  if (need && token !== need) return res.status(401).json({ error: 'unauthorized' });
  if (!VALID_APTS.includes(apt)) return res.status(404).json({ error: 'unknown apartment' });
  if (!id) return res.status(400).json({ error: 'missing device id' });
  // shared devices (entrance) carry an account override in the registry
  const devRec = (LIGHTS[apt] || []).find(x => x.deviceId === id);
  const acct = (devRec && devRec.acct) || apt;
  // a device may pin its channel (e.g. the entrance is on relay 1 of a 2-channel Shelly)
  const ch = (devRec && Number.isInteger(devRec.channel)) ? devRec.channel
           : (Number.isInteger(channel) ? channel : 0);
  try {
    let resp;
    if (kind === 'cover') {
      resp = await shellyV2(acct, '/v2/devices/api/set/cover', { id, channel: ch, position: cover }); // 'open' | 'close' | 'stop' | number
    } else if (kind === 'rgb' || kind === 'rgbw') {
      const body = { id, channel: ch, on: on !== false };
      if (color) {
        body.mode = 'color';
        if (color.r != null) body.red = color.r;
        if (color.g != null) body.green = color.g;
        if (color.b != null) body.blue = color.b;
        if (color.w != null) body.white = color.w;
        if (color.gain != null) body.gain = color.gain;
      }
      resp = await shellyV2(acct, '/v2/devices/api/set/light', body);
    } else if (kind === 'light') {
      const body = { id, channel: ch, on: !!on };
      if (color && color.brightness != null) body.brightness = color.brightness;
      resp = await shellyV2(acct, '/v2/devices/api/set/light', body);
    } else { // switch / relay (default)
      const body = { id, channel: ch, on: !!on };
      if (pulse) body.toggle_after = pulse; // momentary pulse (e.g. door buzzer)
      resp = await shellyV2(acct, '/v2/devices/api/set/switch', body);
    }
    if (resp && resp.isok === false) return res.status(502).json({ error: 'Shelly refused: ' + JSON.stringify(resp.errors || resp) });
    // Re-read the device so the panel reflects reality (respecting the 1 req/sec limit).
    let state = null;
    try {
      await new Promise(r => setTimeout(r, 1100));
      const fresh = await shellyV2(acct, '/v2/devices/api/get', { ids: [id], select: ['status'] });
      const arr = Array.isArray(fresh) ? fresh : (fresh.data || fresh.devices || []);
      if (arr[0]) state = parseDeviceState(arr[0]);
    } catch (_) { /* best effort */ }
    res.json({ ok: true, state });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ===== TUYA (SmartLife) IR control =====
// Env vars:
//   TUYA_ACCESS_ID, TUYA_SECRET  - from your Tuya Cloud project (Overview tab)
//   TUYA_REGION                  - us | eu | weu | in  (yours is 'us')
const TUYA_HOSTS = { us: 'https://openapi.tuyaus.com', eu: 'https://openapi.tuyaeu.com', weu: 'https://openapi-weaz.tuyaeu.com', in: 'https://openapi.tuyain.com' };
const TUYA_HOST = TUYA_HOSTS[process.env.TUYA_REGION || 'us'] || TUYA_HOSTS.us;
let _tuyaTok = { token: null, exp: 0 };

// IR devices per apartment. Projector: On=PowerOn x1, Off=PowerOff x2 (Optoma/Epson confirm-press).
// Fireplace: single toggle (Power). Surround has no library power key, so it rides with the projector.
const IR = {
  apt49: {
    blaster: 'eba8d2c7eaf3305853ici8',
    devices: [
      { key: 'projector', name: 'Projector', kind: 'projector', remote: 'eb4cdd878cffc95c13goai', cat: 6, idx: 12270, onKey: 'PowerOn', offKey: 'PowerOff', offTimes: 2 },
      { key: 'surround', name: 'Surround', kind: 'toggle', remote: 'eb5b9e2dce0416317c19jm', cat: 7, idx: 10282, toggleKey: 'power', raw: true },
      { key: 'fireplace', name: 'Fireplace', kind: 'pair', cat: 1, raw: true,
        on:  { remote: 'eb4db3cddf5e956c3bweln', idx: 1743857161, key: 'Power' },
        off: { remote: 'eb9b430b91c25da7cfgvyu', idx: 1743857319, key: 'Power' } },
    ],
  },
  apt50: {
    blaster: 'eb876e291c2bb888944hxa',
    devices: [
      { key: 'projector', name: 'Projector', kind: 'projector', remote: 'ebb070a5474d6159eftm9x', cat: 6, idx: 5595, onKey: 'PowerOn', offKey: 'PowerOff', offTimes: 2 },
      { key: 'surround', name: 'Surround', kind: 'toggle', remote: 'eb4c91cca43cfcbc5fd8y5', cat: 7, idx: 10282, toggleKey: 'power', raw: true },
      { key: 'fireplace_living', name: 'Living room fireplace', kind: 'pair', cat: 1, raw: true,
        on:  { remote: 'eb01b3ff902a6ff4d57ewm', idx: 1743855011, key: 'Power' },
        off: { remote: 'eb7d0937d77f09aa05zdnn', idx: 1743854589, key: 'Power' } },
    ],
  },
};

async function irSend(blaster, dev, action) {
  const endpoint = dev.raw ? 'raw/command' : 'command';
  const fire = (remote, idx, key) => tuyaRequest('POST',
    `/v2.0/infrareds/${blaster}/remotes/${remote}/${endpoint}`,
    { categoryId: dev.cat, remoteIndex: idx, key });
  let out;
  if (dev.kind === 'projector') {
    if (action === 'off') {
      const n = dev.offTimes || 1;
      for (let i = 0; i < n; i++) { out = await fire(dev.remote, dev.idx, dev.offKey); if (i < n - 1) await new Promise(r => setTimeout(r, 1200)); }
    } else out = await fire(dev.remote, dev.idx, dev.onKey);
  } else if (dev.kind === 'pair') {
    const side = action === 'off' ? dev.off : dev.on;
    out = await fire(side.remote, side.idx, side.key);
  } else { // toggle
    out = await fire(dev.remote, dev.idx, dev.toggleKey);
  }
  return out;
}

const _sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const _hmac = (s, secret) => crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex').toUpperCase();

async function tuyaRequest(method, path, body) {
  const id = process.env.TUYA_ACCESS_ID, secret = process.env.TUYA_SECRET;
  if (!id || !secret) throw new Error('Tuya not configured (TUYA_ACCESS_ID / TUYA_SECRET)');
  const isToken = path.startsWith('/v1.0/token');
  const access = isToken ? '' : await tuyaToken();
  const t = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const stringToSign = `${method}\n${_sha256(bodyStr)}\n\n${path}`;
  const sign = _hmac(id + access + t + stringToSign, secret);
  const headers = { client_id: id, sign, t, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json' };
  if (!isToken) headers.access_token = access;
  const r = await fetch(TUYA_HOST + path, { method, headers, body: bodyStr || undefined });
  return r.json();
}

async function tuyaToken() {
  if (_tuyaTok.token && Date.now() < _tuyaTok.exp) return _tuyaTok.token;
  const res = await tuyaRequest('GET', '/v1.0/token?grant_type=1', null);
  if (res && res.success && res.result) {
    _tuyaTok.token = res.result.access_token;
    _tuyaTok.exp = Date.now() + (res.result.expire_time - 60) * 1000;
    return _tuyaTok.token;
  }
  throw new Error('Tuya token failed: ' + JSON.stringify(res));
}

// DIAGNOSTIC (open in a browser): list the remotes under an IR blaster
app.get('/api/tuya/remotes/:blaster', async (req, res) => {
  try { res.json(await tuyaRequest('GET', `/v2.0/infrareds/${req.params.blaster}/remotes`, null)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// DIAGNOSTIC: list the keys (buttons) of one remote
app.get('/api/tuya/keys/:blaster/:remote', async (req, res) => {
  try { res.json(await tuyaRequest('GET', `/v2.0/infrareds/${req.params.blaster}/remotes/${req.params.remote}/keys`, null)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// SEND an IR key (gated by CONTROL_TOKEN). times=2 sends it twice (projector off).
app.post('/api/tuya/send', async (req, res) => {
  const { blaster, remote, key, category_id, remote_index, times, token } = req.body || {};
  const need = process.env.CONTROL_TOKEN || '';
  if (need && token !== need) return res.status(401).json({ error: 'unauthorized' });
  if (!blaster || !remote || !key) return res.status(400).json({ error: 'need blaster, remote, key' });
  const path = `/v2.0/infrareds/${blaster}/remotes/${remote}/command`;
  const payload = { key };
  if (category_id != null) payload.categoryId = category_id;
  if (remote_index != null) payload.remoteIndex = remote_index;
  try {
    const n = Math.max(1, Math.min(3, times || 1));
    let out;
    for (let i = 0; i < n; i++) {
      out = await tuyaRequest('POST', path, payload);
      if (i < n - 1) await new Promise(r => setTimeout(r, 500));
    }
    if (out && out.success === false) return res.status(502).json({ error: 'Tuya refused: ' + JSON.stringify(out) });
    res.json({ ok: true, tuya: out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// DIAGNOSTIC (open in a browser): fire one key, see if the device reacts
// optional query: ?cat=6&idx=12270  (categoryId and remoteIndex)
// optional query: ?raw=1  -> use the raw/command endpoint (for non-standard keys like some power toggles)
app.get('/api/tuya/fire/:blaster/:remote/:key', async (req, res) => {
  const { blaster, remote, key } = req.params;
  const body = { key };
  if (req.query.cat != null) body.categoryId = Number(req.query.cat);
  if (req.query.idx != null) body.remoteIndex = Number(req.query.idx);
  const endpoint = req.query.raw ? 'raw/command' : 'command';
  try {
    const out = await tuyaRequest('POST', `/v2.0/infrareds/${blaster}/remotes/${remote}/${endpoint}`, body);
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// LIST the IR devices for an apartment (for the panel)
app.get('/api/ir/:apt', (req, res) => {
  const grp = IR[req.params.apt];
  if (!grp) return res.json([]);
  res.json(grp.devices.map(d => ({ key: d.key, name: d.name, kind: d.kind })));
});

// CONTROL an IR device (gated by CONTROL_TOKEN). action: 'on' | 'off' | 'toggle'
app.post('/api/ir', async (req, res) => {
  const { apt, key, action, token } = req.body || {};
  const need = process.env.CONTROL_TOKEN || '';
  if (need && token !== need) return res.status(401).json({ error: 'unauthorized' });
  const grp = IR[apt];
  if (!grp) return res.status(404).json({ error: 'unknown apartment' });
  const dev = grp.devices.find(d => d.key === key);
  if (!dev) return res.status(404).json({ error: 'unknown device' });
  try {
    const out = await irSend(grp.blaster, dev, action);
    if (out && out.success === false) return res.status(502).json({ error: 'Tuya refused: ' + JSON.stringify(out) });
    res.json({ ok: true, tuya: out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/', (_req, res) => res.send('PentLux content API is running.'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('PentLux content API listening on ' + port));
