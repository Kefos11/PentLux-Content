-- PentLux hub media store
-- Run once in your Neon project (SQL editor) to create the table.

CREATE TABLE IF NOT EXISTS media (
  apt  TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the two apartments (no-op if they already exist)
INSERT INTO media (apt) VALUES ('apt49'), ('apt50')
ON CONFLICT (apt) DO NOTHING;

-- data shape (per apartment), filled in by the panel:
-- {
--   "oven":     { "photo": "https://res.cloudinary.com/.../oven.jpg", "ven": "ytIdEN", "vmk": "ytIdMK" },
--   "hottub":   { "photo": "", "ven": "ytIdEN", "vmk": "ytIdMK" },
--   ...
-- }
