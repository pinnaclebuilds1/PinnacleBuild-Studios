import { hashPassword, verifyPassword, newToken, newId, verifyGoogleIdToken } from './auth.mjs';

const STATUSES = ['New', 'Reviewing', 'Quoted', 'Accepted', 'In progress', 'Done', 'Declined'];
const SETTING_KEYS = [
  'heroLine1', 'heroLine2', 'heroBy', 'lead', 'open', 'closedNote',
  'discord', 'youtube', 'x', 'notify', 'confirm'
];
const BUILD_FIELDS = ['title', 'category', 'tagline', 'story', 'time', 'blocks', 'size', 'finished', 'edition', 'link', 'pos'];
const COMMISSION_FIELDS = [
  'publicName', 'queuePosition', 'estimatedStart',
  'completedTitle', 'completedPrice', 'completedSize', 'completedBlocks', 'completedTime', 'completedDetails'
];
const OWNER_AVATAR = '';

const text = (value, max) => String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max);
const flag = (value) => value === true || value === 'true' || value === 1 || value === '1';
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
const now = () => new Date().toISOString();
const signedOut = (message) => Object.assign(new Error(message), { signedOut: true });
const publicCommunity = (item) => ({
  id: item.id,
  created: item.created,
  displayName: item.displayName,
  avatarUrl: item.avatarUrl,
  message: item.message,
  kind: item.kind
});

export class Api {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.rateBuckets = new Map();
    this.loginFailures = new Map();
  }

  /* ---------------------------------------------------------------- helpers */

  get db() {
    return this.store.db;
  }

  /** Simple sliding-window limiter so one visitor cannot flood the studio. */
  limit(key, max, windowMs) {
    const nowMs = Date.now();
    const hits = (this.rateBuckets.get(key) || []).filter((at) => nowMs - at < windowMs);
    if (hits.length >= max) {
      const err = new Error('Too many requests just now. Please wait a minute and try again.');
      err.status = 429;
      throw err;
    }
    hits.push(nowMs);
    this.rateBuckets.set(key, hits);
    if (this.rateBuckets.size > 5000) this.rateBuckets.clear();
  }

  liveSession(token, kind) {
    if (!token) return null;
    const session = (this.db.sessions || []).find((s) => s.token === token && s.kind === kind);
    if (!session) return null;
    if (Date.parse(session.expires || 0) <= Date.now()) return null;
    return session;
  }

  requireOwner(token) {
    const session = this.liveSession(token, 'owner');
    if (!session) throw signedOut('Your session expired. Please sign in again.');
    return session;
  }

  memberProfile(userToken) {
    const session = this.liveSession(userToken, 'member');
    if (!session) return null;
    return this.db.profiles.find((p) => p.id === session.sub) || null;
  }

  requireMember(userToken) {
    const profile = this.memberProfile(userToken);
    if (!profile) throw signedOut('Your sign-in expired. Please sign in again.');
    return profile;
  }

  pruneSessions() {
    const cutoff = Date.now();
    this.db.sessions = (this.db.sessions || []).filter((s) => Date.parse(s.expires || 0) > cutoff);
  }

  publicProfile(profile) {
    return {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      picture: profile.picture || '',
      displayName: profile.displayName || profile.name,
      discord: profile.discord || '',
      created: profile.created || ''
    };
  }

  /* ------------------------------------------------------------- projections */

  buildOut(build) {
    return {
      ...build,
      tags: Array.isArray(build.tags) ? build.tags.map(String) : [],
      gallery: Array.isArray(build.gallery) ? build.gallery : [],
      created: Number(build.created) || 0
    };
  }

  commissionOut(c) {
    const out = {
      id: c.id,
      received: c.received,
      status: c.status,
      quote: c.quote || '',
      notes: c.notes || '',
      read: !!c.read,
      archived: !!c.archived,
      thread: Array.isArray(c.thread) ? c.thread : [],
      ...(c.data || {})
    };
    for (const key of COMMISSION_FIELDS) if (c[key] !== undefined) out[key] = c[key];
    /* Never fall back to the private name: publicName is what may be published. */
    out.publicName = c.publicName || (c.data ? c.data.publicName : '') || '';
    out.completedGallery = Array.isArray(c.completedGallery) ? c.completedGallery : [];
    out.data = c.data || {};
    return out;
  }

  commissions() {
    const rows = this.db.commissions.map((c) => this.commissionOut(c));
    return rows.sort((a, b) => String(b.received).localeCompare(String(a.received)));
  }

  settingsOut() {
    const stored = this.db.settings || {};
    const out = {};
    for (const key of SETTING_KEYS) {
      if (stored[key] !== undefined && stored[key] !== null && String(stored[key]) !== '') out[key] = String(stored[key]);
    }
    return out;
  }

  site() {
    const featured = Array.isArray(this.db.settings.featured) ? this.db.settings.featured.map(String) : [];
    return {
      settings: this.settingsOut(),
      featured,
      builds: this.db.builds.filter((b) => !b.hidden).map((b) => this.buildOut(b)),
      community: {
        feedback: this.db.feedback.filter((f) => f.approved).map(publicCommunity),
        referrals: this.db.referrals.filter((f) => f.approved).map(publicCommunity)
      },
      googleClientId: this.config.googleClientId || ''
    };
  }

  publicCommissions() {
    const live = this.commissions().filter((c) => !c.archived);
    const done = live
      .filter((c) => String(c.status).toLowerCase() === 'done')
      .map((c) => ({
        id: String(c.id || ''),
        received: c.received || '',
        status: 'Done',
        /* A finished commission is public as a showcase: the studio's own write-up,
           pictures and the client's public handle — never the private brief,
           budget, deadline or contact details. */
        publicName: String(c.publicName || ''),
        avatarUrl: /^https:\/\//i.test(String(c.avatarUrl || '')) ? String(c.avatarUrl) : '',
        title: String(c.completedTitle || c.type || 'Minecraft build'),
        type: String(c.type || ''),
        platform: String(c.platform || ''),
        size: String(c.completedSize || c.size || ''),
        completedPrice: String(c.completedPrice || ''),
        completedBlocks: String(c.completedBlocks || ''),
        completedTime: String(c.completedTime || ''),
        completedDetails: String(c.completedDetails || ''),
        gallery: (c.completedGallery || [])
          .map((image) => ({ id: String(image.id || ''), url: String(image.url || '') }))
          .filter((image) => /^(https:\/\/|\/uploads\/)/i.test(image.url))
      }));

    const queue = live
      .filter((c) => c.queueVisible !== false && !['done', 'declined'].includes(String(c.status).toLowerCase()))
      .sort(
        (a, b) =>
          (Number(a.queuePosition) || 9999) - (Number(b.queuePosition) || 9999) ||
          String(a.received).localeCompare(String(b.received))
      )
      .map((c, index) => ({
        displayName: String(c.publicName || 'Private commission'),
        avatarUrl: /^https:\/\//i.test(String(c.avatarUrl || '')) ? String(c.avatarUrl) : '',
        position: Number(c.queuePosition) || index + 1,
        estimatedStart: String(c.estimatedStart || ''),
        status: String(c.status || 'Received'),
        type: String(c.type || 'Minecraft build')
      }));

    return { commissions: done, queue };
  }

  /* --------------------------------------------------------------- visitors */

  async createCommission(req, ctx) {
    if (text(req.hp, 40)) throw new Error('Request could not be accepted.');
    this.limit(`commission:${ctx.ip}`, 6, 10 * 60 * 1000);

    const input = req.data && typeof req.data === 'object' ? req.data : {};
    const profile = this.memberProfile(req.userToken);

    const name = text(input.name, 80);
    const email = text(input.email || input.gmail, 120).toLowerCase();
    const discord = text(input.discord, 60);
    const idea = text(input.idea, 4000);

    if (!name || !email || !discord || !idea) throw new Error('Please complete all required fields.');
    if (!isEmail(email)) throw new Error('Please use a valid email address so the studio can reply.');

    const record = {
      id: newId('PB'),
      received: now(),
      status: 'New',
      data: {
        name,
        gmail: email,
        email,
        discord,
        type: text(input.type, 80),
        platform: text(input.platform, 60),
        size: text(input.size, 160),
        budget: text(input.budget, 80),
        deadline: text(input.deadline, 40),
        idea,
        refs: text(input.refs, 1500),
        publicName: profile ? profile.displayName : text(input.publicName, 60),
        avatarUrl: profile && /^https:\/\//i.test(profile.picture || '') ? profile.picture : OWNER_AVATAR,
        profileId: profile ? profile.id : '',
        profileEmail: profile ? profile.email : ''
      },
      publicName: profile ? profile.displayName : text(input.publicName, 60),
      avatarUrl: profile && /^https:\/\//i.test(profile.picture || '') ? profile.picture : OWNER_AVATAR,
      queueVisible: true,
      queuePosition: 0,
      quote: '',
      notes: '',
      read: false,
      archived: false,
      thread: []
    };

    this.db.commissions.push(record);
    await this.store.save();
    return { ref: record.id, confirmed: false, email };
  }

  async saveCommunity(kind, req, ctx) {
    if (text(req.hp, 40)) throw new Error('Request could not be accepted.');
    this.limit(`community:${ctx.ip}`, 12, 10 * 60 * 1000);

    const input = req.data && typeof req.data === 'object' ? req.data : {};
    const profile = this.memberProfile(req.userToken);
    const displayName = profile ? profile.displayName : text(input.displayName, 60);
    const message = text(input.message, 1200);

    if (!message) throw new Error('Add a message first.');
    if (!displayName) throw new Error('Add your name first.');

    const collection = kind === 'feedback' ? this.db.feedback : this.db.referrals;
    const record = {
      id: newId(kind === 'feedback' ? 'FB' : 'RF'),
      created: now(),
      displayName,
      avatarUrl: profile && /^https:\/\//i.test(profile.picture || '') ? profile.picture : '',
      message,
      approved: false,
      profileId: profile ? profile.id : '',
      email: profile ? profile.email : '',
      kind
    };
    collection.push(record);
    await this.store.save();
    return { id: record.id, message: 'Thanks! Your submission was sent for review.' };
  }

  /* -------------------------------------------------------------------- auth */

  checkLoginLimit(ip) {
    const fails = (this.loginFailures.get(ip) || []).filter((at) => Date.now() - at < 10 * 60 * 1000);
    if (fails.length >= 8) {
      const err = new Error('Too many sign-in attempts. Wait ten minutes and try again.');
      err.status = 429;
      throw err;
    }
    this.loginFailures.set(ip, fails);
  }

  noteLoginFailure(ip) {
    const fails = this.loginFailures.get(ip) || [];
    fails.push(Date.now());
    this.loginFailures.set(ip, fails);
  }

  async startOwnerSession(email) {
    const token = newToken();
    this.pruneSessions();
    this.db.sessions.push({
      token,
      kind: 'owner',
      sub: email,
      created: now(),
      expires: new Date(Date.now() + this.config.sessionTtlMs).toISOString()
    });
    await this.store.save();
    return { token, email, role: 'owner', expires: new Date(Date.now() + this.config.sessionTtlMs).toISOString() };
  }

  async ownerLogin(req, ctx) {
    this.checkLoginLimit(ctx.ip);
    const email = text(req.email, 120).toLowerCase();
    const password = String(req.password || '');
    const admin = this.db.admin || {};
    const stored = String(admin.passwordHash || '');
    const sameEmail = !!email && email === String(admin.email || '').toLowerCase();

    let allowed = false;
    if (sameEmail && password && stored) allowed = await verifyPassword(password, stored);

    // The deployment's PB_ADMIN_PASSWORD was set or changed after the stored hash.
    if (!allowed && sameEmail && password && this.config.adminPassword && password === this.config.adminPassword) {
      admin.passwordHash = await hashPassword(password);
      await this.store.save();
      allowed = true;
    }

    if (!allowed) {
      this.noteLoginFailure(ctx.ip);
      if (!stored) {
        throw new Error('Manager sign-in is not set up yet. Add PB_ADMIN_PASSWORD to this deployment, then try again.');
      }
      throw new Error('That email and password do not match.');
    }

    this.loginFailures.delete(ctx.ip);
    return this.startOwnerSession(admin.email);
  }

  async ownerLogout(req) {
    const token = String(req.token || '');
    this.db.sessions = (this.db.sessions || []).filter((s) => s.token !== token);
    await this.store.save();
    return { signedOut: true };
  }

  async googleOwner(req) {
    const claims = await verifyGoogleIdToken(req.credential, this.config.googleClientId);
    const email = text(claims.email, 120).toLowerCase();
    const adminEmail = String((this.db.admin || {}).email || '').toLowerCase();
    if (email !== adminEmail) throw new Error('This Google account does not have owner access to this studio.');
    return this.startOwnerSession(adminEmail);
  }

  async memberLogin(req) {
    const claims = await verifyGoogleIdToken(req.credential, this.config.googleClientId);
    const sub = String(claims.sub || '');
    const email = text(claims.email, 120).toLowerCase();
    const name = text(claims.name || email, 80);
    const picture = /^https:\/\//i.test(String(claims.picture || '')) ? String(claims.picture) : '';

    let profile = this.db.profiles.find((p) => p.googleSub === sub);
    if (!profile) {
      profile = {
        id: newId('MB'),
        googleSub: sub,
        email,
        name,
        picture,
        displayName: name,
        discord: '',
        created: now(),
        updated: now()
      };
      this.db.profiles.push(profile);
    } else {
      profile.email = email;
      profile.name = name;
      profile.picture = picture || profile.picture;
      profile.updated = now();
    }

    const token = newToken();
    this.pruneSessions();
    this.db.sessions.push({
      token,
      kind: 'member',
      sub: profile.id,
      created: now(),
      expires: new Date(Date.now() + this.config.sessionTtlMs).toISOString()
    });
    await this.store.save();
    return { token, role: 'member', profile: this.publicProfile(profile) };
  }

  profileGet(userToken) {
    const profile = this.requireMember(userToken);
    const commissions = this.db.commissions
      .filter((c) => (c.data || {}).profileId === profile.id)
      .map((c) => ({ id: c.id, received: c.received, status: c.status, type: (c.data || {}).type || 'Minecraft build' }));
    const community = [...this.db.feedback, ...this.db.referrals]
      .filter((item) => item.profileId === profile.id)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        created: item.created,
        message: item.message,
        approved: !!item.approved
      }));
    return { profile: this.publicProfile(profile), commissions, community };
  }

  async profileUpdate(userToken, data) {
    const profile = this.requireMember(userToken);
    const displayName = text(data.displayName, 60);
    const discord = text(data.discord, 60);
    if (!displayName) throw new Error('Choose a display name first.');
    profile.displayName = displayName;
    profile.discord = discord;
    profile.updated = now();
    await this.store.save();
    return { profile: this.publicProfile(profile) };
  }

  /* ----------------------------------------------------------------- manager */

  findCommission(id) {
    return this.db.commissions.find((c) => String(c.id) === String(id)) || null;
  }

  findBuild(id) {
    return this.db.builds.find((b) => String(b.id) === String(id)) || null;
  }

  gmailComposeUrl(to, subject, body) {
    const params = new URLSearchParams({ view: 'cm', fs: '1', to, su: subject, body });
    return `https://mail.google.com/mail/?${params.toString()}`;
  }

  async admin(op, payload, ctx) {
    const p = payload && typeof payload === 'object' ? payload : {};

    if (op === 'load') return { site: this.site(), commissions: this.commissions() };
    if (op === 'commissions') return { commissions: this.commissions() };
    if (op === 'community') return { community: this.communitySubmissions() };
    if (op === 'profiles') return { profiles: this.profiles() };

    if (op === 'updateCommission') return this.updateCommission(p);
    if (op === 'deleteCommission') {
      const before = this.db.commissions.length;
      this.db.commissions = this.db.commissions.filter((c) => String(c.id) !== String(p.id));
      if (this.db.commissions.length === before) throw new Error('Commission not found.');
      await this.store.save();
      return { commissions: this.commissions() };
    }

    if (op === 'reply') {
      const commission = this.findCommission(p.id);
      if (!commission) throw new Error('Commission not found.');
      const to = text((commission.data || {}).email || (commission.data || {}).gmail, 160);
      if (!to) throw new Error('This request has no reply email address.');
      const message = text(p.message, 6000);
      if (!message) throw new Error('Write a message first.');
      const subject = text(p.subject, 150) || 'Your PinnacleBuilds commission';
      commission.thread = Array.isArray(commission.thread) ? commission.thread : [];
      commission.thread.push({ at: now(), subject, text: message });
      if (commission.status === 'New') commission.status = 'Reviewing';
      await this.store.save();
      return { commissions: this.commissions(), gmailUrl: this.gmailComposeUrl(to, subject, message) };
    }

    if (op === 'saveBuild') return this.saveBuild(p.build || {});
    if (op === 'deleteBuild') {
      const build = this.findBuild(p.id);
      if (!build) throw new Error('Build not found.');
      for (const item of [build.cover, build.structure, build.world, ...(build.gallery || [])]) {
        if (item && item.url) await this.store.deleteUpload(item.url);
      }
      this.db.builds = this.db.builds.filter((b) => String(b.id) !== String(p.id));
      await this.store.save();
      return { site: this.site() };
    }

    if (op === 'upload') return this.upload(p);
    if (op === 'removeFile') return this.removeFile(p);
    if (op === 'uploadCommissionImage') return this.uploadCommissionImage(p);
    if (op === 'removeCommissionImage') return this.removeCommissionImage(p);
    if (op === 'moderateCommunity') return this.moderateCommunity(p);

    if (op === 'saveSettings') {
      const settings = p.settings && typeof p.settings === 'object' ? p.settings : {};
      for (const [key, value] of Object.entries(settings)) {
        if (!SETTING_KEYS.includes(key)) continue;
        this.db.settings[key] = text(value, 4000);
      }
      await this.store.save();
      return { site: this.site() };
    }

    if (op === 'saveFeatured') {
      const ids = Array.isArray(p.ids) ? p.ids.map((id) => text(id, 60)).filter(Boolean).slice(0, 6) : [];
      this.db.settings.featured = ids;
      await this.store.save();
      return { site: this.site() };
    }

    if (op === 'backup') {
      /* A backup is a data export, not a spare key: drop the credential index and
         live sessions so a downloaded file cannot be used to sign in. */
      const { admin, sessions, ...rest } = this.db;
      return {
        backup: {
          ...rest,
          admin: { email: (admin && admin.email) || '', googleEmail: (admin && admin.googleEmail) || '' },
          sessions: []
        },
        exportedAt: now()
      };
    }

    throw new Error('Unknown manager action.');
  }

  communitySubmissions() {
    const rows = [...this.db.feedback, ...this.db.referrals];
    rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return { feedback: this.db.feedback, referrals: this.db.referrals, items: rows };
  }

  profiles() {
    const communityCount = (id) => [...this.db.feedback, ...this.db.referrals].filter((x) => x.profileId === id).length;
    const commissionCount = (id) => this.db.commissions.filter((c) => (c.data || {}).profileId === id).length;
    return this.db.profiles
      .slice()
      .sort((a, b) => String(b.created).localeCompare(String(a.created)))
      .map((profile) => ({
        ...this.publicProfile(profile),
        commissionCount: commissionCount(profile.id),
        communityCount: communityCount(profile.id)
      }));
  }

  async updateCommission(p) {
    const commission = this.findCommission(p.id);
    if (!commission) throw new Error('Commission not found.');

    if (p.status !== undefined) {
      const status = text(p.status, 40);
      if (!STATUSES.includes(status)) throw new Error('Unknown commission status.');
      commission.status = status;
    }
    if (p.quote !== undefined) commission.quote = text(p.quote, 80);
    if (p.notes !== undefined) commission.notes = text(p.notes, 4000);
    if (p.read !== undefined) commission.read = flag(p.read);
    if (p.archived !== undefined) commission.archived = flag(p.archived);

    for (const key of COMMISSION_FIELDS) {
      if (p[key] === undefined) continue;
      commission[key] = key === 'queuePosition' ? Math.max(0, Math.min(999, Number(p[key]) || 0)) : text(p[key], 5000);
    }
    if (p.queueVisible !== undefined) commission.queueVisible = flag(p.queueVisible);

    await this.store.save();
    return { commissions: this.commissions() };
  }

  async saveBuild(input) {
    const wanted = text(input.id, 80).toLowerCase();
    const existing = wanted ? this.findBuild(wanted) : null;
    /* Keep a client-supplied id when it is a plain slug and still free. The three
       showcase builds live in the page, so the manager edits them by id: without
       this the server minted a new row and the edit silently did nothing. */
    const build = existing || {
      id: wanted && /^[a-z0-9][a-z0-9-]{0,63}$/.test(wanted) ? wanted : newId('build').toLowerCase(),
      created: Date.now(),
      gallery: [],
      cover: null,
      structure: null,
      world: null
    };
    for (const key of BUILD_FIELDS) {
      if (input[key] === undefined) continue;
      build[key] = text(input[key], key === 'story' ? 12000 : 800);
    }
    if (input.tags !== undefined) {
      const tags = Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(',');
      build.tags = tags.map((tag) => text(tag, 40)).filter(Boolean).slice(0, 12);
    }
    if (input.hidden !== undefined) build.hidden = flag(input.hidden);
    if (input.link !== undefined && text(input.link, 500) && !/^https:\/\//i.test(String(input.link))) {
      throw new Error('Download links must start with https://');
    }
    if (!build.title) throw new Error('Give the build a title first.');

    if (!existing) this.db.builds.push(build);
    await this.store.save();
    return { id: build.id, site: this.site() };
  }

  async upload(p) {
    const build = this.findBuild(p.buildId);
    if (!build) throw new Error('Build not found. Save the build first.');

    const kind = String(p.kind || '');
    if (!['cover', 'gallery', 'structure', 'world'].includes(kind)) throw new Error('Unsupported file type.');
    const isImage = kind === 'cover' || kind === 'gallery';

    const item = await this.store.saveUpload({
      base64: p.data,
      name: p.name,
      kind: isImage ? 'image' : 'file'
    });

    if (kind === 'gallery') build.gallery = [...(build.gallery || []), item];
    else {
      if (build[kind] && build[kind].url) await this.store.deleteUpload(build[kind].url);
      build[kind] = item;
    }
    await this.store.save();
    return { site: this.site(), file: item };
  }

  async removeFile(p) {
    const build = this.findBuild(p.buildId);
    if (!build) throw new Error('Build not found.');

    if (p.kind === 'gallery') {
      const item = (build.gallery || []).find((g) => String(g.id) === String(p.fileId));
      build.gallery = (build.gallery || []).filter((g) => String(g.id) !== String(p.fileId));
      if (item) await this.store.deleteUpload(item.url);
    } else if (['cover', 'structure', 'world'].includes(p.kind)) {
      if (build[p.kind] && build[p.kind].url) await this.store.deleteUpload(build[p.kind].url);
      build[p.kind] = null;
    } else {
      throw new Error('Unsupported file type.');
    }
    await this.store.save();
    return { site: this.site() };
  }

  async uploadCommissionImage(p) {
    const commission = this.findCommission(p.id);
    if (!commission) throw new Error('Commission not found.');
    if (String(commission.status).toLowerCase() !== 'done') {
      throw new Error('Only completed commissions can have public pictures.');
    }
    const item = await this.store.saveUpload({ base64: p.data, name: p.name || 'completed-build.jpg', kind: 'image' });
    commission.completedGallery = [...(commission.completedGallery || []), item];
    await this.store.save();
    return { commissions: this.commissions() };
  }

  async removeCommissionImage(p) {
    const commission = this.findCommission(p.id);
    if (!commission) throw new Error('Commission not found.');
    const gallery = Array.isArray(commission.completedGallery) ? commission.completedGallery : [];
    const item = gallery.find((image) => String(image.id) === String(p.fileId));
    if (item) await this.store.deleteUpload(item.url);
    commission.completedGallery = gallery.filter((image) => String(image.id) !== String(p.fileId));
    await this.store.save();
    return { commissions: this.commissions() };
  }

  async moderateCommunity(p) {
    const collection = p.kind === 'referral' ? this.db.referrals : p.kind === 'feedback' ? this.db.feedback : null;
    if (!collection) throw new Error('Unknown submission type.');
    const index = collection.findIndex((item) => String(item.id) === String(p.id));
    if (index < 0) throw new Error('Submission not found.');
    if (flag(p.remove)) collection.splice(index, 1);
    else collection[index].approved = flag(p.approved);
    await this.store.save();
    return { community: this.communitySubmissions() };
  }

  /* ------------------------------------------------------------------ router */

  async handle(req, ctx) {
    const action = String(req.action || '').trim();
    switch (action) {
      case 'site':
        return this.site();
      case 'publicCommissions':
        return this.publicCommissions();
      case 'commission':
        return this.createCommission(req, ctx);
      case 'publicFeedback':
        return this.saveCommunity('feedback', req, ctx);
      case 'publicReferral':
        return this.saveCommunity('referral', req, ctx);
      case 'ownerLogin':
        return this.ownerLogin(req, ctx);
      case 'ownerLogout':
        return this.ownerLogout(req);
      case 'googleLogin':
        return this.googleOwner(req);
      case 'memberLogin':
        return this.memberLogin(req);
      case 'profileGet':
        return this.profileGet(req.userToken);
      case 'profileUpdate':
        return this.profileUpdate(req.userToken, req.data || {});
      case 'health':
        return { engine: this.config.runtime || 'node', time: now() };
      case 'admin':
        this.requireOwner(req.token);
        return this.admin(req.op, req.payload || {}, ctx);
      default:
        throw new Error('Unknown request.');
    }
  }
}

export { STATUSES, hashPassword };
