/**
 * Store adapter for the hosted (Cloudflare Workers) build.
 *
 * The API code only needs `.db`, `.save()`, `.saveUpload()` and
 * `.deleteUpload()`. The whole database is one JSON document in D1, written
 * once per request with a revision check; uploads live in R2.
 */

const UPLOAD_NAME = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mcstructure|mcworld|zip)$/i;

const EXT_BY_KIND = {
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  file: ['.mcstructure', '.mcworld', '.zip']
};

export const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mcstructure': 'application/octet-stream',
  '.mcworld': 'application/zip',
  '.zip': 'application/zip'
};

export const UPLOAD_PATTERN = UPLOAD_NAME;

function extension(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return match ? `.${match[1].toLowerCase()}` : '';
}

export class EdgeStore {
  constructor({ db, rev, bucket }) {
    this.data = db;
    this.rev = rev;
    this.bucket = bucket;
    this.dirty = false;
    this.written = [];
    this.pendingDelete = [];
  }

  get db() {
    return this.data;
  }

  /** Marks the document as changed; the worker commits once per request. */
  async save() {
    this.dirty = true;
  }

  /** Decode and store a base64 upload in R2. */
  async saveUpload({ base64, name, kind }) {
    const cleanName = String(name || 'upload').replace(/[\r\n"]/g, '').slice(0, 120);
    let ext = extension(cleanName);
    const allowed = EXT_BY_KIND[kind] || EXT_BY_KIND.image;
    if (!ext && allowed.includes('.jpg')) ext = '.jpg';
    if (!allowed.includes(ext)) {
      throw new Error(`Unsupported file type for ${kind} uploads: ${ext || 'no extension'}.`);
    }

    const payload = String(base64 || '').replace(/^data:[^,]+,/, '');
    if (!payload) throw new Error('No file data received.');
    if (payload.length > 42 * 1024 * 1024) throw new Error('That file is too large.');

    const binary = atob(payload);
    if (!binary.length) throw new Error('No file data received.');
    if (binary.length > 30 * 1024 * 1024) throw new Error('That file is too large.');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

    const id = crypto.randomUUID();
    const filename = `${id}${ext}`;
    await this.bucket.put(filename, bytes, {
      httpMetadata: {
        contentType: CONTENT_TYPES[ext] || 'application/octet-stream',
        cacheControl: 'public, max-age=31536000, immutable'
      }
    });
    this.written.push(filename);
    return { id, name: cleanName, size: bytes.length, url: `/uploads/${filename}` };
  }

  /** Deletes are queued and only run after the database change is committed. */
  async deleteUpload(idOrUrl) {
    const base = String(idOrUrl || '').split('/').pop();
    if (!UPLOAD_NAME.test(base)) return false;
    this.pendingDelete.push(base);
    return true;
  }

  /** Run queued deletes (called after a successful commit). */
  async finalize() {
    const keys = this.pendingDelete.slice();
    this.pendingDelete = [];
    this.written = [];
    for (const key of keys) {
      try {
        await this.bucket.delete(key);
      } catch {
        /* a leftover file is harmless */
      }
    }
  }

  /** Drop files written by an attempt whose database write did not happen. */
  async discard() {
    const keys = this.written.slice();
    this.written = [];
    this.pendingDelete = [];
    this.dirty = false;
    for (const key of keys) {
      try {
        await this.bucket.delete(key);
      } catch {
        /* nothing to do */
      }
    }
  }
}
