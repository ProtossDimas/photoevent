-- schema.sql
-- Jalankan SEKALI untuk inisialisasi database D1:
--   npx wrangler d1 execute wedding-booth-db --remote --file=schema.sql
--
-- Untuk development lokal:
--   npx wrangler d1 execute wedding-booth-db --local --file=schema.sql

-- ─────────────────────────────────────────────────────────
-- Tabel utama: entries
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Identitas tamu
  name         TEXT    NOT NULL,
  message      TEXT    NOT NULL DEFAULT '',

  -- Waktu upload (ISO 8601)
  timestamp    TEXT    NOT NULL,

  -- ── R2 (storage aktif untuk web) ──────────────────────
  media_key    TEXT    NOT NULL,   -- R2 object key: entries/slug/epoch/media.webm
  media_url    TEXT    NOT NULL,   -- URL publik R2 (dipakai frontend)
  media_type   TEXT    NOT NULL CHECK (media_type IN ('video','photo')),

  -- Voice note (opsional)
  vn_key       TEXT    NOT NULL DEFAULT '',
  vn_url       TEXT    NOT NULL DEFAULT '',

  -- Ukuran file (bytes) — untuk monitor quota R2
  file_size    INTEGER NOT NULL DEFAULT 0,

  -- ── Google Drive (arsip permanen, dikelola cron) ───────
  drive_id          TEXT NOT NULL DEFAULT '',   -- file ID di Drive (media utama)
  drive_url         TEXT NOT NULL DEFAULT '',   -- URL viewer Drive
  vn_drive_id       TEXT NOT NULL DEFAULT '',   -- file ID voice note di Drive
  vn_drive_url      TEXT NOT NULL DEFAULT '',
  archived_at       TEXT NOT NULL DEFAULT '',   -- timestamp saat berhasil diarsip
  archive_attempts  INTEGER NOT NULL DEFAULT 0, -- jumlah percobaan (untuk retry logic)
  archive_error     TEXT NOT NULL DEFAULT ''    -- pesan error terakhir jika gagal
);

-- Index untuk gallery (ORDER BY id DESC)
CREATE INDEX IF NOT EXISTS idx_entries_id_desc   ON entries (id DESC);

-- Index untuk cron: cari yang belum diarsip
CREATE INDEX IF NOT EXISTS idx_entries_unarchived ON entries (archived_at)
  WHERE archived_at = '';

-- Index pencarian nama (admin)
CREATE INDEX IF NOT EXISTS idx_entries_name       ON entries (name);

-- ─────────────────────────────────────────────────────────
-- View: statistik ringkas (untuk admin / monitoring)
-- ─────────────────────────────────────────────────────────
CREATE VIEW IF NOT EXISTS stats AS
SELECT
  COUNT(*)                                                AS total_entries,
  SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END)  AS total_videos,
  SUM(CASE WHEN media_type = 'photo' THEN 1 ELSE 0 END)  AS total_photos,
  SUM(CASE WHEN vn_key   != '' THEN 1 ELSE 0 END)        AS total_voice_notes,
  SUM(CASE WHEN archived_at != '' THEN 1 ELSE 0 END)     AS total_archived,
  SUM(CASE WHEN archived_at  = '' THEN 1 ELSE 0 END)     AS pending_archive,
  ROUND(SUM(file_size) / 1048576.0, 2)                   AS total_r2_mb,
  MIN(timestamp)                                          AS first_entry,
  MAX(timestamp)                                          AS last_entry
FROM entries;
