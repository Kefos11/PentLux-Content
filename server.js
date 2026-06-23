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
    { key: 'living', name: 'Living room', deviceId: '8caab54c4cc3', channel: 0, type: 'light' },
    // add more 49 lights here as: { key: 'bedroom', name: 'Bedroom', deviceId: '...', channel: 0, type: 'light' },
  ],
  apt50: [
    // { key: 'living',  name: 'Living room', deviceId: 'PASTE_DEVICE_ID', channel: 0, type: 'relay' },
  ],
};

function findLight(apt, key) {
  return (LIGHTS[apt] || []).find(l => l.key === key);
}

// Each apartment is a separate Shelly account, so each has its own key + server.
// Set these in Railway Variables:
//   apt49 -> SHELLY_SERVER_49, SHELLY_AUTH_KEY_49
//   apt50 -> SHELLY_SERVER_50, SHELLY_AUTH_KEY_50
function shellyCreds(apt) {
  if (apt === 'apt49') return { server: process.env.SHELLY_SERVER_49, key: process.env.SHELLY_AUTH_KEY_49 };
  if (apt === 'apt50') return { server: process.env.SHELLY_SERVER_50, key: process.env.SHELLY_AUTH_KEY_50 };
  return {};
}

// Calls Shelly Cloud to switch a device on/off.
async function shellyControl(apt, dev, turnOn) {
  const { server, key } = shellyCreds(apt);
  if (!server || !key) throw new Error('Shelly not configured for ' + apt);
  const path = dev.type === 'light' ? '/device/light/control' : '/device/relay/control';
  const body = new URLSearchParams({
    id: dev.deviceId,
    channel: String(dev.channel ?? 0),
    turn: turnOn ? 'on' : 'off',
    auth_key: key,
  });
  const r = await fetch(server.replace(/\/+$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return r.json();
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
  res.json((LIGHTS[apt] || []).map(l => ({ key: l.key, name: l.name, type: l.type || 'relay' })));
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

app.get('/', (_req, res) => res.send('PentLux content API is running.'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('PentLux content API listening on ' + port));
