/**
 * worker-cron.js
 * Cloudflare Worker — Cron Job: Sync R2 → Google Drive
 *
 * Berjalan setiap 5 menit (diatur di wrangler.toml).
 * Tugasnya murni arsip — tidak menyentuh frontend sama sekali.
 *
 * Alur per run:
 *   1. Query D1: ambil entry yang belum diarsip (archived_at = '')
 *      dan masih dalam batas retry (archive_attempts < MAX_ARCHIVE_ATTEMPTS)
 *   2. Per entry: ambil file dari R2 → upload ke Google Drive
 *   3. Update D1: isi drive_id, drive_url, archived_at
 *   4. Jika gagal: increment archive_attempts + catat archive_error
 *
 * Secrets (set via: npx wrangler secret put <KEY>):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  → email service account GCP
 *   GOOGLE_PRIVATE_KEY            → private key PEM (newline sebagai \n)
 *   GOOGLE_DRIVE_FOLDER_ID        → ID folder Drive tujuan arsip
 *
 * Bindings (di wrangler.toml):
 *   DB           → D1 database
 *   MEDIA_BUCKET → R2 bucket
 */

// ─────────────────────────────────────────────────────────
// ENTRY POINT — dipanggil Cloudflare sesuai jadwal cron
// ─────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runArchiveCycle(env));
  },

  // Handler HTTP — untuk trigger manual via curl saat testing
  // Hapus / proteksi dengan secret header sebelum production
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run' && request.method === 'POST') {
      const result = await runArchiveCycle(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Wedding Booth Cron Worker — OK', { status: 200 });
  },
};

// ─────────────────────────────────────────────────────────
// MAIN: satu siklus archiving
// ─────────────────────────────────────────────────────────
async function runArchiveCycle(env) {
  const maxAttempts = parseInt(env.MAX_ARCHIVE_ATTEMPTS || '5', 10);
  const batchSize   = parseInt(env.ARCHIVE_BATCH_SIZE   || '10', 10);

  const summary = {
    started_at:  new Date().toISOString(),
    processed:   0,
    succeeded:   0,
    failed:      0,
    skipped:     0,
    finished_at: null,
  };

  // ── Ambil entry yang belum diarsip ───────────────────
  const { results: pending } = await env.DB.prepare(`
    SELECT id, name, timestamp,
           media_key, media_type,
           vn_key,
           archive_attempts
    FROM   entries
    WHERE  archived_at        = ''
      AND  archive_attempts   < ?
    ORDER  BY id ASC
    LIMIT  ?
  `).bind(maxAttempts, batchSize).all();

  if (!pending || pending.length === 0) {
    summary.finished_at = new Date().toISOString();
    console.log('Cron: tidak ada entry yang perlu diarsip.');
    return summary;
  }

  console.log(`Cron: memproses ${pending.length} entry...`);

  // ── Dapatkan Google OAuth token (sekali untuk semua entry) ──
  let token;
  try {
    token = await getGoogleToken(env);
  } catch (err) {
    console.error('Cron: Google auth gagal:', err.message);
    summary.finished_at = new Date().toISOString();
    summary.failed = pending.length;
    return summary;
  }

  // ── Buat subfolder Drive per tanggal (agar tidak semua masuk 1 folder) ──
  // Format folder: YYYY-MM-DD
  const today = new Date().toISOString().slice(0, 10);
  let dateFolderId;
  try {
    dateFolderId = await getOrCreateDateFolder(token, env.GOOGLE_DRIVE_FOLDER_ID, today);
  } catch (err) {
    console.error('Cron: gagal buat folder Drive:', err.message);
    summary.finished_at = new Date().toISOString();
    summary.failed = pending.length;
    return summary;
  }

  // ── Proses setiap entry ──────────────────────────────
  for (const entry of pending) {
    summary.processed++;
    try {
      await archiveEntry(entry, token, dateFolderId, env);
      summary.succeeded++;
      console.log(`Cron: entry ${entry.id} (${entry.name}) berhasil diarsip.`);
    } catch (err) {
      summary.failed++;
      console.error(`Cron: entry ${entry.id} gagal:`, err.message);

      // Catat error ke D1 agar bisa diinvestigasi
      await env.DB.prepare(`
        UPDATE entries
        SET    archive_attempts = archive_attempts + 1,
               archive_error   = ?
        WHERE  id = ?
      `).bind(err.message.slice(0, 500), entry.id).run();
    }
  }

  summary.finished_at = new Date().toISOString();
  console.log('Cron selesai:', JSON.stringify(summary));
  return summary;
}

// ─────────────────────────────────────────────────────────
// ARCHIVE SATU ENTRY: R2 → Drive → update D1
// ─────────────────────────────────────────────────────────
async function archiveEntry(entry, token, folderId, env) {
  // ── Ambil file media dari R2 ─────────────────────────
  const mediaObj = await env.MEDIA_BUCKET.get(entry.media_key);
  if (!mediaObj) throw new Error(`File R2 tidak ditemukan: ${entry.media_key}`);

  const mediaBuffer = await mediaObj.arrayBuffer();
  const mediaMime   = mediaObj.httpMetadata?.contentType
    || (entry.media_type === 'photo' ? 'image/jpeg' : 'video/webm');
  const mediaName   = `${entry.name}_${entry.id}.${entry.media_type === 'photo' ? 'jpg' : 'webm'}`;

  // ── Upload media ke Drive ────────────────────────────
  const driveId  = await uploadToDrive(token, folderId, mediaName, mediaBuffer, mediaMime);
  const driveUrl = `https://drive.google.com/file/d/${driveId}/view`;

  // ── Upload voice note ke Drive (jika ada) ────────────
  let vnDriveId = '', vnDriveUrl = '';
  if (entry.vn_key) {
    const vnObj = await env.MEDIA_BUCKET.get(entry.vn_key);
    if (vnObj) {
      const vnBuffer = await vnObj.arrayBuffer();
      const vnMime   = vnObj.httpMetadata?.contentType || 'audio/webm';
      const vnName   = `${entry.name}_${entry.id}_voicenote.webm`;
      vnDriveId  = await uploadToDrive(token, folderId, vnName, vnBuffer, vnMime);
      vnDriveUrl = `https://drive.google.com/file/d/${vnDriveId}/view`;
    }
  }

  // ── Update D1: tandai sudah diarsip ──────────────────
  await env.DB.prepare(`
    UPDATE entries
    SET    drive_id         = ?,
           drive_url        = ?,
           vn_drive_id      = ?,
           vn_drive_url     = ?,
           archived_at      = ?,
           archive_attempts = archive_attempts + 1,
           archive_error    = ''
    WHERE  id = ?
  `).bind(
    driveId, driveUrl,
    vnDriveId, vnDriveUrl,
    new Date().toISOString(),
    entry.id,
  ).run();
}

// ─────────────────────────────────────────────────────────
// GOOGLE DRIVE HELPERS
// ─────────────────────────────────────────────────────────

/** Cari subfolder tanggal di Drive, buat jika belum ada */
async function getOrCreateDateFolder(token, parentId, dateStr) {
  // Cari dulu
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?` +
    `q=${encodeURIComponent(`name='${dateStr}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)}` +
    `&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const searchData = await searchRes.json();
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }
  // Buat baru
  return await createDriveFolder(token, parentId, dateStr);
}

/** Buat folder di Google Drive */
async function createDriveFolder(token, parentId, name) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents:  [parentId],
    }),
  });
  if (!res.ok) throw new Error('Buat folder gagal: ' + await res.text());
  return (await res.json()).id;
}

/** Upload file ke Google Drive via multipart upload */
async function uploadToDrive(token, folderId, filename, buffer, mimeType) {
  const boundary   = 'WeddingBoothBoundary271828';
  const delimiter  = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;
  const enc        = new TextEncoder();

  const metadata = JSON.stringify({ name: filename, parents: [folderId] });

  const parts = [
    enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}`),
    enc.encode(delimiter + `Content-Type: ${mimeType}\r\n\r\n`),
    new Uint8Array(buffer),
    enc.encode(closeDelim),
  ];

  const totalLen = parts.reduce((a, p) => a + p.length, 0);
  const body     = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`,
      },
      body: body.buffer,
    }
  );

  if (!res.ok) throw new Error('Upload Drive gagal: ' + await res.text());
  const { id } = await res.json();
  return id;
}

// ─────────────────────────────────────────────────────────
// GOOGLE AUTH — Service Account JWT (sama seperti kode lama)
// ─────────────────────────────────────────────────────────
async function getGoogleToken(env) {
  const email      = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  if (!email || !privateKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL atau GOOGLE_PRIVATE_KEY belum diset');
  }

  const scope = 'https://www.googleapis.com/auth/drive';
  const now   = Math.floor(Date.now() / 1000);

  const headerB64 = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimB64  = b64url(JSON.stringify({
    iss: email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const sigInput = `${headerB64}.${claimB64}`;
  const key      = await importPemKey(privateKey);
  const sig      = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(sigInput),
  );
  const jwt = `${sigInput}.${bufToB64url(sig)}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Google auth gagal: ' + JSON.stringify(json));
  return json.access_token;
}

async function importPemKey(pem) {
  const b64    = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(b64);
  const buf    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    'pkcs8', buf.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
}

function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function bufToB64url(buf) {
  let binary = '';
  new Uint8Array(buf).forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
