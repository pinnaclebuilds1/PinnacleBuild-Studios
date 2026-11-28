import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { emptyDatabase } from './schema.mjs';

export { emptyDatabase };

const UPLOAD_NAME = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|gif|mcstructure|mcworld|zip)$/i;
const EXT_BY_KIND = {
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  file: ['.mcstructure', '.mcworld', '.zip']
};

/**
 * File-backed JSON database. Every mutation runs through update(), which is
 * serialised and written atomically, so two requests can never interleave.
 */
export class Store {
  #lock = Promise.resolve();

  constructor(dir) {
    this.dir = dir;
    this.uploadsDir = path.join(dir, 'uploads');
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.data = this.#read();
  }

  #read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...emptyDatabase(), ...raw };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a broken file instead of silently overwriting real data.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.copyFileSync(this.file, backup);
        } catch {}
        console.error(`[store] Could not read ${this.file}; moved a copy to ${backup}.`);
      }
      return emptyDatabase();
    }
  }

  get db() {
    return this.data;
  }

  #write() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    return fsp
      .writeFile(tmp, JSON.stringify(this.data, null, 1))
      .then(() => fsp.rename(tmp, this.file));
  }

  /** Save immediately (used after bootstrap changes). */
  save() {
    this.#lock = this.#lock.then(() => this.#write());
    return this.#lock;
  }

  /** Run a mutation with exclusive access to the database, then persist it. */
  async update(fn) {
    let release;
    const previous = this.#lock;
    this.#lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const result = await fn(this.data);
      await this.#write();
      return result;
    } finally {
      release();
    }
  }

  /**
   * Decode and store a base64 upload under data/uploads.
   * Returns { id, name, size, url } where url is a same-origin path.
   */
  saveUpload({ base64, name, kind }) {
    const cleanName = String(name || 'upload').replace(/[\r\n"]/g, '').slice(0, 120);
    let ext = path.extname(cleanName).toLowerCase();
    const allowed = EXT_BY_KIND[kind] || EXT_BY_KIND.image;
    if (!ext && allowed.includes('.jpg')) ext = '.jpg';
    if (!allowed.includes(ext)) {
      throw new Error(`Unsupported file type for ${kind} uploads: ${ext || 'no extension'}.`);
    }
    const payload = String(base64 || '').replace(/^data:[^,]+,/, '');
    if (!payload) throw new Error('No file data received.');
    if (payload.length > 42 * 1024 * 1024) throw new Error('That file is too large.');

    const bytes = Buffer.from(payload, 'base64');
    if (!bytes.length) throw new Error('No file data received.');
    if (bytes.length > 30 * 1024 * 1024) throw new Error('That file is too large.');

    const id = crypto.randomUUID();
    const filename = `${id}${ext}`;
    fs.writeFileSync(path.join(this.uploadsDir, filename), bytes);
    return { id, name: cleanName, size: bytes.length, url: `/uploads/${filename}` };
  }

  deleteUpload(idOrUrl) {
    const base = path.basename(String(idOrUrl || ''));
    if (!UPLOAD_NAME.test(base)) return false;
    try {
      fs.unlinkSync(path.join(this.uploadsDir, base));
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve a public /uploads/<name> path to a real file inside the data dir. */
  uploadPath(name) {
    const base = path.basename(String(name || ''));
    if (!UPLOAD_NAME.test(base)) return '';
    const full = path.join(this.uploadsDir, base);
    return fs.existsSync(full) ? full : '';
  }
}
