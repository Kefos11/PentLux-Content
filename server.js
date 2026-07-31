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
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
    { key: 'kitchen',    name: 'Kitchen',          deviceId: '8caab54c4cc3', type: 'light', room: 'Kitchen' },
    { key: 'hallway',    name: 'Hallway',          deviceId: '8caab54cf39f', type: 'light', room: 'Kitchen' },
    { key: 'bar',        name: 'Bar',              deviceId: '483fda9198d3', type: 'light', room: 'Kitchen' },
    { key: 'shower',     name: 'Shower',           deviceId: '8caab54cf67e', type: 'light', room: 'Spa' },
    { key: 'bed',        name: 'Bed lights',       deviceId: '30c9224b7fd0', type: 'light', room: 'Living room & bedroom' },
    { key: 'living',     name: 'Living room',      deviceId: '441793a852c0', type: 'light', room: 'Living room & bedroom' },
    { key: 'mainled',    name: 'Main LED',         deviceId: 'a5b52b',       type: 'light', room: 'Living room & bedroom' },
    { key: 'kitchenled', name: 'Kitchen LED',      deviceId: 'a68c2d',       type: 'light', room: 'Kitchen' },
    { key: 'mirrorled',  name: 'Mirror LED',       deviceId: 'a57450',       type: 'light', room: 'Kitchen' },
    { key: 'stairsled',  name: 'Stairs LED',       deviceId: 'a6afec',       type: 'light', room: 'Spa' },
    { key: 'logoled',    name: 'Logo LED',         deviceId: 'a5b535',       type: 'light', room: 'Living room & bedroom' },
    { key: 'saunaled',   name: 'Sauna LED',        deviceId: 'a56b06',       type: 'light', room: 'Spa' },
    { key: 'projector',  name: 'Projector screen', deviceId: '10061cfad170', type: 'cover', favPos: 51, room: 'Cinema' },
    { key: 'entrance',   name: 'Building entrance', deviceId: '8caab5560679', type: 'relay', acct: 'entrance', channel: 1, room: 'Entrance' },
  ],
  apt50: [
    { key: 'bar',          name: 'Bar lights',           deviceId: '8caab54cf1e5', type: 'light', room: 'Kitchen' },
    { key: 'living',       name: 'Living room lights',   deviceId: '483fda91a886', type: 'light', room: 'Living room' },
    { key: 'kitchenrad',   name: 'Kitchen radiator light', deviceId: '8caab54c5210', type: 'light', room: 'Kitchen' },
    { key: 'balcony',      name: 'Wall balcony lights',  deviceId: '8caab54cf1e3', type: 'light', room: 'Bedroom' },
    { key: 'bedroom',      name: 'Bedroom lights',       deviceId: '3494547aa257', type: 'switch', channel: 0, room: 'Bedroom' },
    { key: 'hottub',       name: 'Hot tub lights',       deviceId: '3494547aa257', type: 'switch', channel: 1, room: 'Spa' },
    { key: 'fireplaceled', name: 'Fireplace LED',        deviceId: 'a696dc', type: 'rgb', room: 'Living room' },
    { key: 'livingled',    name: 'Living room LED',       deviceId: 'a69425', type: 'rgb', room: 'Living room' },
    { key: 'mirrorled',    name: 'Mirror LED',            deviceId: 'a695b3', type: 'rgb', room: 'Living room' },
    { key: 'barled',       name: 'Bar LED',              deviceId: '6f4a9b', type: 'rgb', room: 'Kitchen' },
    { key: 'kitchenled',   name: 'Kitchen LED',          deviceId: 'a5b16e', type: 'rgb', room: 'Kitchen' },
    { key: 'bedroomled',   name: 'Bedroom LED',          deviceId: 'a57440', type: 'rgb', room: 'Bedroom' },
    { key: 'stairsled',    name: 'Stairs LED',           deviceId: 'e868e7f38cf4', type: 'rgb', room: 'Spa' },
    { key: 'saunaled',     name: 'Sauna LED',            deviceId: 'a56a3c', type: 'rgb', room: 'Spa' },
    { key: 'wardrobeled',  name: 'Wardrobe LED',         deviceId: 'a69c16', type: 'rgb', room: 'Bedroom' },
    { key: 'projector',    name: 'Projector screen',     deviceId: '34945477c20a', type: 'cover', favPos: 72, room: 'Cinema' },
    { key: 'entrance', name: 'Building entrance', deviceId: '8caab5560679', type: 'relay', acct: 'entrance', channel: 1, room: 'Entrance' },
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
// Returns an ARRAY of per-channel states for a device, each with its channel id,
// plus whether the device is online/reachable. This lets a single multi-channel
// device (e.g. an RGBW driving several LED strips) report every channel, and lets
// the hub show an "offline" state when a device is unreachable.
function parseDeviceState(dev) {
  const st = (dev && dev.status) || {};
  // Shelly's `online` flag is unreliable (cloud devices often report online:0 even
  // when returning fresh, valid status). So: a device is considered online if it
  // EITHER has online:1 OR returned real status data (it clearly just answered).
  const hasStatus = st && Object.keys(st).length > 0 && (
    st.lights || st.relays || st.rollers ||
    Object.keys(st).some(k => k.startsWith('switch:') || k.startsWith('light:') || k.startsWith('rgb') || k.startsWith('cover:'))
  );
  const flag = dev && (dev.online === undefined ? true : !!dev.online);
  const online = flag || !!hasStatus;
  const channels = [];

  for (const k of Object.keys(st)) {
    const c = st[k] || {};
    if (k.startsWith('cover:'))  channels.push({ kind: 'cover',  channel: c.id || 0, state: c.state, pos: c.current_pos, online });
    else if (k.startsWith('switch:')) channels.push({ kind: 'switch', channel: c.id || 0, on: !!c.output, online });
    else if (k.startsWith('rgbw:'))   channels.push({ kind: 'rgbw',   channel: c.id || 0, on: !!c.output, rgb: c.rgb, white: c.white, gain: c.gain, brightness: c.brightness, online });
    else if (k.startsWith('rgb:'))    channels.push({ kind: 'rgb',    channel: c.id || 0, on: !!c.output, rgb: c.rgb, gain: c.gain, brightness: c.brightness, online });
    else if (k.startsWith('light:'))  channels.push({ kind: 'light',  channel: c.id || 0, on: !!c.output, brightness: c.brightness, online });
  }

  // Gen1 shapes (arrays of relays / lights / rollers, indexed by channel)
  if (!channels.length) {
    if (Array.isArray(st.relays))  st.relays.forEach((r, i)  => channels.push({ kind: 'switch', channel: i, on: !!r.ison, online }));
    if (Array.isArray(st.lights))  st.lights.forEach((l, i)  => channels.push({ kind: (l.red !== undefined ? 'rgb' : 'light'), channel: i, on: !!l.ison, rgb: [l.red, l.green, l.blue], gain: l.gain, brightness: l.brightness, online }));
    if (Array.isArray(st.rollers)) st.rollers.forEach((ro, i) => channels.push({ kind: 'cover', channel: i, state: ro.state, pos: ro.current_pos, online }));
  }

  if (!channels.length) channels.push({ kind: 'unknown', channel: 0, online });
  return channels;
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

// ===== RESERVATIONS =====
const onlyDigits = s => String(s || '').replace(/[^\d]/g, '');
const TOKEN_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'; // no ambiguous 0/o/1/l
function makeToken(n = 7) {
  let t = '';
  for (let i = 0; i < n; i++) t += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
  return t;
}
const isAdmin = req => ADMIN_TOKEN && (req.headers.authorization === 'Bearer ' + ADMIN_TOKEN);

// hours offset helper for defaults
function defReveal(checkin) { return checkin ? new Date(new Date(checkin).getTime() - 3600e3) : null; }
function defUnveal(checkout) { return checkout ? new Date(new Date(checkout).getTime() + 3600e3) : null; }

// CREATE (admin)
app.post('/api/reservations', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const b = req.body || {};
  const apt = VALID_APTS.includes(b.apt) ? b.apt : 'apt49';
  const token = makeToken(7);
  const reveal = b.reveal_at || defReveal(b.checkin);
  const unveal = b.unveal_at || defUnveal(b.checkout);
  try {
    const { rows } = await pool.query(
      `INSERT INTO guest_links (token, guest_name, guest_phone, apt, checkin, checkout, reveal_at, unveal_at, door_code, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') RETURNING *`,
      [token, b.guest_name || '', onlyDigits(b.guest_phone), apt, b.checkin || null, b.checkout || null,
       reveal, unveal, b.door_code || '', b.notes || '']);
    res.json({ ok: true, reservation: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'database error' }); }
});

// EDIT (admin) — any subset of fields; recomputes reveal/unveal only if explicitly sent
app.put('/api/reservations/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const b = req.body || {};
  const fields = [], vals = []; let i = 1;
  const set = (col, val) => { fields.push(`${col} = $${i++}`); vals.push(val); };
  if (b.guest_name != null) set('guest_name', b.guest_name);
  if (b.guest_phone != null) set('guest_phone', onlyDigits(b.guest_phone));
  if (b.apt != null && VALID_APTS.includes(b.apt)) set('apt', b.apt);
  if (b.checkin != null) set('checkin', b.checkin || null);
  if (b.checkout != null) set('checkout', b.checkout || null);
  if (b.reveal_at != null) set('reveal_at', b.reveal_at || null);
  if (b.unveal_at != null) set('unveal_at', b.unveal_at || null);
  // If check-in/out changed but reveal/unveal weren't explicitly provided, recompute them
  // from the new dates — otherwise the hub keeps reading the OLD gate times (e.g. a past
  // unveal makes an edited-to-future reservation still show the "ended / thank you" state).
  if (b.checkin != null && b.reveal_at == null)  set('reveal_at', b.checkin  ? defReveal(b.checkin)   : null);
  if (b.checkout != null && b.unveal_at == null) set('unveal_at', b.checkout ? defUnveal(b.checkout) : null);
  if (b.door_code != null) set('door_code', b.door_code);
  if (b.notes != null) set('notes', b.notes);
  if (b.status != null) set('status', b.status === 'cancelled' ? 'cancelled' : 'active');
  if (!fields.length) return res.json({ ok: true, unchanged: true });
  vals.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE guest_links SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, reservation: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'database error' }); }
});

// LIST (admin)
app.get('/api/reservations', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { rows } = await pool.query('SELECT * FROM guest_links ORDER BY checkin DESC NULLS LAST, created_at DESC');
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'database error' }); }
});

// GUEST PORTAL read (public, by link token) — time-gated, never leaks code early
app.get('/api/reservation/:token', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM guest_links WHERE token = $1', [req.params.token]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    const now = Date.now();
    const cancelled = r.status === 'cancelled';
    const revealed = !cancelled && r.reveal_at && r.unveal_at &&
      now >= new Date(r.reveal_at).getTime() && now <= new Date(r.unveal_at).getTime();
    const expired = r.unveal_at && now > new Date(r.unveal_at).getTime();
    res.json({
      guest_name: r.guest_name, apt: r.apt,
      checkin: r.checkin, checkout: r.checkout,
      reveal_at: r.reveal_at, unveal_at: r.unveal_at,
      status: r.status, cancelled, revealed, expired,
      door_code: revealed ? r.door_code : null,
      controls: revealed,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'database error' }); }
});

// LARA read (by phone) — returns context for the bot. Protected by ADMIN_TOKEN.
app.get('/api/reservation/by-phone/:phone', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const phone = onlyDigits(req.params.phone);
    const { rows } = await pool.query(
      `SELECT * FROM guest_links WHERE guest_phone = $1 AND status = 'active'
       ORDER BY checkin DESC NULLS LAST LIMIT 1`, [phone]);
    const r = rows[0];
    if (!r) return res.json({ found: false });
    res.json({ found: true, guest_name: r.guest_name, apt: r.apt,
      checkin: r.checkin, checkout: r.checkout, door_code: r.door_code, notes: r.notes, token: r.token });
  } catch (e) { console.error(e); res.status(500).json({ error: 'database error' }); }
});

// --- LIGHTS: list what's configured for an apartment (public; just names) ---
app.get('/api/lights/:apt', (req, res) => {
  const apt = req.params.apt;
  if (!VALID_APTS.includes(apt)) return res.status(404).json({ error: 'unknown apartment' });
  res.json((LIGHTS[apt] || []).map(l => ({ key: l.key, name: l.name, id: l.deviceId, type: l.type || 'switch', fav: l.favPos, room: l.room || 'Other', channel: l.channel })));
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
// DEBUG: returns the RAW Shelly response for one apartment so we can map the exact shape.
// Safe to leave in — returns device status only, same data as /api/status.
app.get('/api/status-raw/:apt', async (req, res) => {
  const apt = req.params.apt;
  if (!VALID_APTS.includes(apt)) return res.status(404).json({ error: 'unknown apartment' });
  const devs = LIGHTS[apt] || [];
  const byAcct = {};
  devs.forEach(d => { const a = d.acct || apt; (byAcct[a] = byAcct[a] || []).push(d.deviceId); });
  try {
    const dump = {};
    for (const acct of Object.keys(byAcct)) {
      const ids = byAcct[acct];
      const { server, key } = shellyCreds(acct);
      if (!server || !key) { dump[acct] = { error: 'account not configured' }; continue; }
      const batch = ids.slice(0, 3); // just first few devices to keep it small
      const resp = await shellyV2(acct, '/v2/devices/api/get', { ids: batch, select: ['status'] });
      dump[acct] = { requestedIds: batch, responseType: Array.isArray(resp) ? 'array' : typeof resp, raw: resp };
    }
    res.json(dump);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

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
        // Shelly may return an array OR an object keyed by device id. Normalize to an array of {id, status, online}.
        let arr;
        if (Array.isArray(resp)) {
          arr = resp;
        } else if (resp && Array.isArray(resp.data)) {
          arr = resp.data;
        } else if (resp && Array.isArray(resp.devices)) {
          arr = resp.devices;
        } else if (resp && typeof resp === 'object') {
          // object keyed by device id -> [{id, ...fields}]
          arr = Object.keys(resp).map(id => {
            const v = resp[id] || {};
            // some shapes nest under .status already; keep id attached
            return Object.assign({ id }, v);
          });
        } else {
          arr = [];
        }
        const seen = new Set();
        arr.forEach(d => {
          const devId = d.id || d.device_id || d._id;
          if (!devId) return;
          seen.add(devId);
          const chans = parseDeviceState(d);        // array, one per channel
          chans.forEach(cs => {
            out[devId] = out[devId] || cs;             // back-compat: bare id = first channel
            out[devId + ':' + cs.channel] = cs;        // precise: id:channel
          });
        });
        // any requested device that didn't come back = unreachable/offline
        batch.forEach(id => { if (!seen.has(id)) out[id] = { kind: 'unknown', channel: 0, online: false }; });
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
async function controlDevice(apt, opts) {
  const { id, kind, on, channel, color, cover, pulse } = opts || {};
  if (!VALID_APTS.includes(apt)) { const e = new Error('unknown apartment'); e.status = 404; throw e; }
  if (!id) { const e = new Error('missing device id'); e.status = 400; throw e; }
  const devRec = (LIGHTS[apt] || []).find(x => x.deviceId === id);
  const acct = (devRec && devRec.acct) || apt;
  const ch = (devRec && Number.isInteger(devRec.channel)) ? devRec.channel
           : (Number.isInteger(channel) ? channel : 0);
  let resp;
  if (kind === 'cover') {
    resp = await shellyV2(acct, '/v2/devices/api/set/cover', { id, channel: ch, position: cover });
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
  } else {
    const body = { id, channel: ch, on: !!on };
    if (pulse) body.toggle_after = pulse;
    resp = await shellyV2(acct, '/v2/devices/api/set/switch', body);
  }
  if (resp && resp.isok === false) { const e = new Error('Shelly refused: ' + JSON.stringify(resp.errors || resp)); e.status = 502; throw e; }
  let state = null;
  try {
    await new Promise(r => setTimeout(r, 1100));
    const fresh = await shellyV2(acct, '/v2/devices/api/get', { ids: [id], select: ['status'] });
    const arr = Array.isArray(fresh) ? fresh : (fresh.data || fresh.devices || []);
    if (arr[0]) state = parseDeviceState(arr[0]);
  } catch (_) { /* best effort */ }
  return { ok: true, state };
}

app.post('/api/control', async (req, res) => {
  const { token } = req.body || {};
  const need = process.env.CONTROL_TOKEN || '';
  if (need && token !== need) return res.status(401).json({ error: 'unauthorized' });
  try {
    const out = await controlDevice(req.body.apt, req.body);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: String(e.message || e) });
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
      { key: 'fireplace', name: 'Fireplace', kind: 'diy', remote: 'eb63a3783f3f9f702aqsnl',
        onCode: 'fd22e211f4015102f4017102d4017102f4015202f3017102f4015102f4017102f4015102f401d506d501f406d501d506f401d506d501f406d501f406d501d506f401d506d4019002f401b606f4017102d401f506f4015102f4015102f4017102f4015102f401d606f3017102d501d506f4017102f301d606d401d506d501f506f301d606f301439ec7222709f4013075',
        offCode: '7e220312d60190029501b002b5019102b501b002b6019102d3017302d401b002b5017202b5011607d401f606d501f506b601160795011607d401f606b501f606b60155079501f606b501b102b501900296011507f4017102b601b002b5019102b601ce0297019002b601f606b5011507b6019102d401150797013507b501f60695011707d3015e9ead222909d4013075' },
    ],
  },
  apt50: {
    blaster: 'eb876e291c2bb888944hxa',
    devices: [
      { key: 'projector', name: 'Projector', kind: 'projector', remote: 'ebb070a5474d6159eftm9x', cat: 6, idx: 5595, onKey: 'PowerOn', offKey: 'PowerOff', offTimes: 2 },
      { key: 'surround', name: 'Surround', kind: 'toggle', remote: 'eb4c91cca43cfcbc5fd8y5', cat: 7, idx: 10282, toggleKey: 'power', raw: true },
      { key: 'fireplace_living', name: 'Living room fireplace', kind: 'diy', remote: 'eb747321792483fb6f4zln',
        onCode: 'fc22a81133023302f30173021302320214025202f4015202f4017102f3015502120232021502b7061202b8061402b806f401b5061402b606f501d806f401d606f401b806f401710212029906130252021302b806f4015102f40152021402510216023202f401b50614027102f401b80614025102f401d606f501b7061302b706f401d706f4013c9e0a230909f4013075',
        offCode: '2023871132025402f4015102f40153021302530215023202f4017102f4015202f40153021502b7061302b706f401d70614029906f401d606f501d6061602b606f501b706f401b80613027202f5015002f601d60614023302f4017102f5015202f4015202130252021502b806f401b8061202530213029a061202b806f401d8061202b806f401429e0823e908f4013075' },
      { key: 'fireplace_bedroom', name: 'Bedroom fireplace', kind: 'diy', blaster: 'eb872d016fa30912d5a912', remote: 'eb4e047b055307dba6ku23',
        onCode: '1a23881112025302120253021202320215027102d3015302f401710213023202f3017302f301b7061302d606f501b60632029706f401b8061402b50633029806f301d606140233021202b706150230021402b706f5017102d301710233023202d6017102f401d406f4015202f401d70612025302f301b6061502b506330278061502d506f401509e2a23c90812023075',
        offCode: '1c23c311f40153021202530212023302f3017202f40153021202320215025002f50150021502b5061402b7061202b706f401b7061402b506f401d706f301d6061302b706d601d4061302520213023202330299061202320232023302130232021502500215025002f401b8061202b70613025202f401b7061202b70615029506330297061302539e2723c908f4013075' },
    ],
  },
};

async function irSend(blaster, dev, action) {
  const bl = dev.blaster || blaster;
  const endpoint = dev.raw ? 'raw/command' : 'command';
  const fire = (remote, idx, key) => tuyaRequest('POST',
    `/v2.0/infrareds/${bl}/remotes/${remote}/${endpoint}`,
    { categoryId: dev.cat, remoteIndex: idx, key });
  let out;
  if (dev.kind === 'projector') {
    if (action === 'off') {
      const n = dev.offTimes || 1;
      for (let i = 0; i < n; i++) { out = await fire(dev.remote, dev.idx, dev.offKey); if (i < n - 1) await new Promise(r => setTimeout(r, 1200)); }
    } else out = await fire(dev.remote, dev.idx, dev.onKey);
  } else if (dev.kind === 'diy') {
    const code = action === 'off' ? dev.offCode : dev.onCode;
    out = await tuyaRequest('POST', `/v2.0/infrareds/${bl}/remotes/${dev.remote}/learning-codes`, { code });
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

// DIAGNOSTIC: list learned codes for a DIY remote (category 999)
app.get('/api/tuya/learn/:blaster/:remote', async (req, res) => {
  try { res.json(await tuyaRequest('GET', `/v2.0/infrareds/${req.params.blaster}/remotes/${req.params.remote}/learning-codes`, null)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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

// BROWSER TEST: fire an IR device through the full logic (DIY/projector/surround handled).
// e.g. /api/irtest/apt49/fireplace/on  ·  /api/irtest/apt50/projector/off
app.get('/api/irtest/:apt/:key/:action', async (req, res) => {
  const grp = IR[req.params.apt];
  if (!grp) return res.status(404).json({ error: 'unknown apartment' });
  const dev = grp.devices.find(d => d.key === req.params.key);
  if (!dev) return res.status(404).json({ error: 'unknown device', available: grp.devices.map(d => d.key) });
  try {
    const out = await irSend(grp.blaster, dev, req.params.action);
    res.json({ ok: !(out && out.success === false), tuya: out });
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

// ===== GUEST CONTROL (authorized by reservation token, time-gated) =====
// A guest's link token becomes their control key — but only while the stay is live.
async function liveReservation(token) {
  if (!token) return null;
  const { rows } = await pool.query('SELECT * FROM guest_links WHERE token = $1', [token]);
  const r = rows[0];
  if (!r || r.status === 'cancelled') return null;
  const now = Date.now();
  const reveal = r.reveal_at ? new Date(r.reveal_at).getTime() : null;
  const unveal = r.unveal_at ? new Date(r.unveal_at).getTime() : null;
  if (reveal && now < reveal) return null;          // before reveal
  if (unveal && now > unveal) return null;          // after unveal
  return r;                                          // live → controllable
}

// which devices count as colour LEDs (rgb), and movie-night picks per apt
const isLed = l => l.type === 'rgb' || l.type === 'rgbw' || /led$/i.test(l.key);
const MOVIE_LEDS = { apt49: ['logoled', 'mainled', 'stairsled'], apt50: ['fireplaceled', 'livingled', 'mirrorled'] };
const TURQUOISE = { r: 64, g: 224, b: 208 };

// run a scene for an apartment. Shelly's 1 req/sec limit means this takes a little while.
async function runScene(apt, scene, opts = {}) {
  const lights = (LIGHTS[apt] || []).filter(l => l.key !== 'entrance' && l.type !== 'cover');
  const leds = lights.filter(isLed);
  const whites = lights.filter(l => !isLed(l));
  const gap = () => new Promise(r => setTimeout(r, 1100)); // respect rate limit
  const setDev = async (l, body) => { try { await controlDevice(apt, Object.assign({ id: l.deviceId, channel: l.channel }, body)); } catch (e) { /* keep going */ } await gap(); };
  const irFire = async (key, action) => {
    const grp = IR[apt]; if (!grp) return;
    const dev = grp.devices.find(d => d.key === key); if (!dev) return;
    try { await irSend(grp.blaster, dev, action); } catch (e) { /* keep going */ }
    await gap();
  };

  if (scene === 'all_off' || scene === 'all_on') {
    const on = scene === 'all_on';
    for (const l of lights) await setDev(l, { kind: isLed(l) ? 'rgb' : (l.type === 'light' ? 'light' : 'switch'), on });
  } else if (scene === 'leds_off' || scene === 'leds_on') {
    const on = scene === 'leds_on';
    for (const l of leds) await setDev(l, { kind: 'rgb', on });
  } else if (scene === 'leds_set') {
    const color = { r: opts.r, g: opts.g, b: opts.b, gain: opts.gain != null ? opts.gain : 100 };
    for (const l of leds) await setDev(l, { kind: 'rgb', on: true, color });
  } else if (scene === 'movie') {
    const picks = (MOVIE_LEDS[apt] || []);
    const movieLeds = leds.filter(l => picks.includes(l.key));
    // 1) all whites + non-movie LEDs off
    for (const l of whites) await setDev(l, { kind: l.type === 'light' ? 'light' : 'switch', on: false });
    for (const l of leds.filter(l => !picks.includes(l.key))) await setDev(l, { kind: 'rgb', on: false });
    // 2) movie LEDs → turquoise @ 50%
    for (const l of movieLeds) await setDev(l, { kind: 'rgb', on: true, color: { r: TURQUOISE.r, g: TURQUOISE.g, b: TURQUOISE.b, gain: 50 } });
    // 3) projector on, surround on
    await irFire('projector', 'on');
    await irFire('surround', 'toggle');
    // 4) projector screen down to favourite position
    const screen = (LIGHTS[apt] || []).find(l => l.type === 'cover');
    if (screen) { try { await controlDevice(apt, { id: screen.deviceId, kind: 'cover', cover: screen.favPos != null ? screen.favPos : 50 }); } catch (e) {} }
  } else {
    const e = new Error('unknown scene'); e.status = 400; throw e;
  }
  return { ok: true };
}

// GUEST: control one device (token = reservation token)
app.post('/api/guest/control', async (req, res) => {
  try {
    const r = await liveReservation((req.body || {}).token);
    if (!r) return res.status(403).json({ error: 'reservation not active' });
    const out = await controlDevice(r.apt, req.body);
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
});

// GUEST: fire an IR device
app.post('/api/guest/ir', async (req, res) => {
  try {
    const r = await liveReservation((req.body || {}).token);
    if (!r) return res.status(403).json({ error: 'reservation not active' });
    const grp = IR[r.apt]; if (!grp) return res.status(404).json({ error: 'no IR' });
    const dev = grp.devices.find(d => d.key === (req.body || {}).key);
    if (!dev) return res.status(404).json({ error: 'unknown device' });
    const out = await irSend(grp.blaster, dev, (req.body || {}).action);
    if (out && out.success === false) return res.status(502).json({ error: 'Tuya refused' });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
});

// GUEST: run a scene
app.post('/api/guest/scene', async (req, res) => {
  try {
    const r = await liveReservation((req.body || {}).token);
    if (!r) return res.status(403).json({ error: 'reservation not active' });
    const out = await runScene(r.apt, (req.body || {}).scene, req.body || {});
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
});

// MASTER: run a scene from the admin panel (CONTROL_TOKEN)
app.post('/api/scene', async (req, res) => {
  const need = process.env.CONTROL_TOKEN || '';
  if (need && (req.body || {}).token !== need) return res.status(401).json({ error: 'unauthorized' });
  try {
    const out = await runScene((req.body || {}).apt, (req.body || {}).scene, req.body || {});
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
});

// ── TRANSLATION (free Google endpoint, in-memory cached) ──────────────
// The hub sends an array of English strings + a target language; we translate
// and cache so only the first guest per language waits. No API key needed.
const _trCache = {}; // { lang: { sourceText: translated } }

async function gTranslate(text, to) {
  // Google's free web endpoint — no key. Returns translated text for one string.
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=' +
    encodeURIComponent(to) + '&dt=t&q=' + encodeURIComponent(text);
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('translate http ' + r.status);
  const data = await r.json();
  // data[0] is an array of [translatedChunk, originalChunk, ...]; join the chunks.
  return (data[0] || []).map(seg => seg[0]).join('');
}

app.post('/api/translate', async (req, res) => {
  try {
    const { lang, texts } = req.body || {};
    if (!lang || !Array.isArray(texts)) return res.status(400).json({ error: 'lang and texts[] required' });
    if (lang === 'en') return res.json({ lang, translations: texts }); // no-op
    _trCache[lang] = _trCache[lang] || {};
    const cache = _trCache[lang];
    const out = new Array(texts.length);
    const todo = [];
    texts.forEach((t, idx) => {
      const key = (t || '').trim();
      if (!key) { out[idx] = t; }
      else if (cache[key] != null) { out[idx] = cache[key]; }
      else { todo.push({ idx, key }); }
    });
    // Translate the uncached ones (sequential to be gentle on the free endpoint)
    for (const item of todo) {
      try {
        const tr = await gTranslate(item.key, lang);
        cache[item.key] = tr;
        out[item.idx] = tr;
      } catch (e) {
        out[item.idx] = texts[item.idx]; // fall back to English on any failure
      }
    }
    res.json({ lang, translations: out });
  } catch (e) {
    console.error('[translate]', e.message);
    res.status(500).json({ error: 'translate error' });
  }
});

app.get('/', (_req, res) => res.send('PentLux content API is running.'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('PentLux content API listening on ' + port));
