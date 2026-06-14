/**
 * functions/[[catchall]].js
 * Cloudflare Pages Functions — Wedding Video Booth API
 *
 * Storage : Cloudflare R2  (file aktif, dipakai frontend)
 * Database: Cloudflare D1  (metadata + status arsip)
 * Arsip   : Google Drive   (dikelola worker-cron.js, bukan di sini)
 *
 * Endpoints:
 *   POST /api/submit          → upload media ke R2, simpan metadata ke D1
 *   GET  /api/gallery         → ambil entries dari D1 (dengan pagination)
 *   GET  /api/media/<key>     → proxy file dari R2 (fallback jika PUBLIC_URL tidak diset)
 *   GET  /api/stats           → statistik ringkas (total, pending arsip, dll)
 *   GET  /api/health          → cek koneksi R2 + D1
 *
 * Binding yang diperlukan (set di Cloudflare Pages Dashboard):
 *   R2  : MEDIA_BUCKET  → wedding-booth-media
 *   D1  : DB            → wedding-booth-db
 *   Var : PUBLIC_URL    → https://pub-xxxx.r2.dev  (R2 public bucket URL)
 */

// ─────────────────────────────────────────────────────────
// KONSTANTA
// ─────────────────────────────────────────────────────────
const MAX_MEDIA_SIZE  = 150 * 1024 * 1024; // 150 MB
const MAX_VN_SIZE     =   5 * 1024 * 1024; //   5 MB
const MAX_NAME_LEN    = 80;
const MAX_MSG_LEN     = 500;
const PAGE_SIZE       = 50;

const ALLOWED_MEDIA  = new Set(['video/webm','video/mp4','image/jpeg','image/png','image/webp']);
const ALLOWED_AUDIO  = new Set(['audio/webm','audio/ogg','audio/mpeg','audio/mp4']);

// ─────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────
export async function onRequest({ request, env }) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (path === '/api/submit'  && method === 'POST') return await handleSubmit(request, env);
    if (path === '/api/gallery' && method === 'GET')  return await handleGallery(request, env);
    if (path === '/api/stats'   && method === 'GET')  return await handleStats(env);
    if (path === '/api/health'  && method === 'GET')  return await handleHealth(env);
    if (path.startsWith('/api/media/') && method === 'GET') return await handleMedia(path, env);
    return new Response('Not found', { status: 404, headers: corsHeaders() });
  } catch (err) {
    console.error('API error:', err.stack || err.message);
    return jsonRes({ error: err.message || 'Internal server error' }, 500);
  }
}

// ─────────────────────────────────────────────────────────
// POST /api/submit
// Upload ke R2 → simpan ke D1 (Drive diurus cron terpisah)
// ─────────────────────────────────────────────────────────
async function handleSubmit(request, env) {
  if (!env.MEDIA_BUCKET) return jsonRes({ error: 'R2 bucket tidak terkonfigurasi' }, 503);
  if (!env.DB)           return jsonRes({ error: 'D1 database tidak terkonfigurasi' }, 503);

  let formData;
  try { formData = await request.formData(); }
  catch { return jsonRes({ error: 'Request body tidak valid' }, 400); }

  const name      = (formData.get('name')    || '').trim();
  const message   = (formData.get('message') || '').trim();
  const videoFile = formData.get('video');
  const photoFile = formData.get('photo');
  const vnFile    = formData.get('vn');
  const mediaFile = videoFile || photoFile;

  // ── Validasi ─────────────────────────────────────────
  if (!name)                       return jsonRes({ error: 'Nama tidak boleh kosong' }, 400);
  if (!mediaFile)                  return jsonRes({ error: 'File video atau foto diperlukan' }, 400);
  if (name.length > MAX_NAME_LEN)  return jsonRes({ error: `Nama maks ${MAX_NAME_LEN} karakter` }, 400);
  if (message.length > MAX_MSG_LEN)return jsonRes({ error: `Pesan maks ${MAX_MSG_LEN} karakter` }, 400);

  const mediaMime = mediaFile.type || '';
  if (!ALLOWED_MEDIA.has(mediaMime)) return jsonRes({ error: `Tipe file tidak didukung: ${mediaMime}` }, 400);

  const mediaBuffer = await mediaFile.arrayBuffer();
  if (mediaBuffer.byteLength === 0)              return jsonRes({ error: 'File kosong' }, 400);
  if (mediaBuffer.byteLength > MAX_MEDIA_SIZE)   return jsonRes({ error: 'File terlalu besar (maks 150 MB)' }, 413);

  const isPhoto  = !!photoFile;
  const ts       = new Date().toISOString();
  const epoch    = Date.now();
  const safeSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30);
  const prefix   = `entries/${safeSlug}/${epoch}`;
  const mediaExt = isPhoto ? 'jpg' : 'webm';
  const mediaKey = `${prefix}/media.${mediaExt}`;

  // ── Upload media ke R2 ───────────────────────────────
  await env.MEDIA_BUCKET.put(mediaKey, mediaBuffer, {
    httpMetadata: {
      contentType:  mediaMime,
      cacheControl: 'public, max-age=31536000',
    },
    customMetadata: { uploaderName: name, uploadedAt: ts },
  });

  const mediaUrl = r2PublicUrl(env, mediaKey);

  // ── Upload voice note ke R2 (opsional) ──────────────
  let vnKey = '', vnUrl = '';
  if (vnFile && vnFile.size > 0) {
    const vnMime = vnFile.type || 'audio/webm';
    if (ALLOWED_AUDIO.has(vnMime)) {
      const vnBuffer = await vnFile.arrayBuffer();
      if (vnBuffer.byteLength > 0 && vnBuffer.byteLength <= MAX_VN_SIZE) {
        vnKey = `${prefix}/voicenote.webm`;
        await env.MEDIA_BUCKET.put(vnKey, vnBuffer, {
          httpMetadata: { contentType: vnMime, cacheControl: 'public, max-age=31536000' },
          customMetadata: { uploaderName: name, uploadedAt: ts },
        });
        vnUrl = r2PublicUrl(env, vnKey);
      }
    }
  }

  // ── Simpan ke D1 ─────────────────────────────────────
  // drive_id, archived_at dll dibiarkan kosong — diisi cron nanti
  const row = await env.DB.prepare(`
    INSERT INTO entries
      (timestamp, name, message, media_key, media_url, media_type,
       vn_key, vn_url, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).bind(
    ts, name, message,
    mediaKey, mediaUrl, isPhoto ? 'photo' : 'video',
    vnKey, vnUrl,
    mediaBuffer.byteLength,
  ).first();

  const mediaFieldKey = isPhoto ? 'photo_url' : 'video_url';
  return jsonRes({
    success:          true,
    id:               row?.id ?? null,
    [mediaFieldKey]:  mediaUrl,
    vn_url:           vnUrl,
    timestamp:        ts,
  }, 201);
}

// ─────────────────────────────────────────────────────────
// GET /api/gallery?page=1&limit=50
// ─────────────────────────────────────────────────────────
async function handleGallery(request, env) {
  if (!env.DB) return jsonRes({ error: 'D1 tidak terkonfigurasi' }, 503);

  const url    = new URL(request.url);
  const page   = Math.max(1, parseInt(url.searchParams.get('page')  || '1',  10));
  const limit  = Math.min(PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get('limit') || String(PAGE_SIZE), 10)));
  const offset = (page - 1) * limit;

  const [countRes, dataRes] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS total FROM entries'),
    env.DB.prepare(`
      SELECT id, timestamp, name, message,
             media_url, media_type, vn_url,
             drive_url, vn_drive_url,
             archived_at, file_size
      FROM   entries
      ORDER  BY id DESC
      LIMIT  ? OFFSET ?
    `).bind(limit, offset),
  ]);

  const total   = countRes.results[0]?.total ?? 0;
  const entries = (dataRes.results || []).map(r => ({
    id:          r.id,
    timestamp:   r.timestamp,
    name:        r.name,
    message:     r.message,
    media_url:   r.media_url,
    media_type:  r.media_type,
    // alias backward-compat untuk frontend lama
    video_url:   r.media_type === 'video' ? r.media_url : '',
    photo_url:   r.media_type === 'photo' ? r.media_url : '',
    vn_url:      r.vn_url || '',
    // info arsip (opsional dipakai frontend)
    drive_url:   r.drive_url    || '',
    archived:    r.archived_at !== '',
    file_size:   r.file_size,
  }));

  return jsonRes({
    entries,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      has_next:    page * limit < total,
    },
  });
}

// ─────────────────────────────────────────────────────────
// GET /api/stats
// ─────────────────────────────────────────────────────────
async function handleStats(env) {
  if (!env.DB) return jsonRes({ error: 'D1 tidak terkonfigurasi' }, 503);
  const row = await env.DB.prepare('SELECT * FROM stats').first();
  return jsonRes(row ?? {});
}

// ─────────────────────────────────────────────────────────
// GET /api/media/<r2-key>
// Proxy R2 — hanya dipakai jika PUBLIC_URL tidak diset
// ─────────────────────────────────────────────────────────
async function handleMedia(path, env) {
  if (!env.MEDIA_BUCKET) return jsonRes({ error: 'R2 tidak terkonfigurasi' }, 503);

  const key = decodeURIComponent(path.replace(/^\/api\/media\//, ''));
  if (!key || key.includes('..')) return new Response('Invalid key', { status: 400 });

  const obj = await env.MEDIA_BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000');
  return new Response(obj.body, { headers });
}

// ─────────────────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────────────────
async function handleHealth(env) {
  const status = { db: false, r2: false, ts: new Date().toISOString() };
  try { await env.DB.prepare('SELECT 1').first(); status.db = true; }
  catch (e) { status.db_error = e.message; }
  try { await env.MEDIA_BUCKET.list({ limit: 1 }); status.r2 = true; }
  catch (e) { status.r2_error = e.message; }
  return jsonRes(status, status.db && status.r2 ? 200 : 503);
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
function r2PublicUrl(env, key) {
  if (env.PUBLIC_URL) return `${env.PUBLIC_URL.replace(/\/$/, '')}/${key}`;
  return `/api/media/${encodeURIComponent(key)}`;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
