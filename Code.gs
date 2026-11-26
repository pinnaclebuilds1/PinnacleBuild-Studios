/**
 * PinnacleBuild-Studios backend for Google Apps Script.
 * Attach this script to a Google Sheet, run setupSite(), setManagerPassword(),
 * then deploy as a Web app (Execute as: Me; access: Anyone).
 */

const PB = {
  COMMISSIONS: 'Commissions',
  BUILDS: 'Builds',
  SETTINGS: 'Settings',
  FOLDER: 'PinnacleBuild-Studios Uploads',
  TOKEN_TTL: 3600,
  OWNER_EMAIL: 'pinnaclebuilds1@gmail.com'
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('PinnacleBuild-Studios')
    .addItem('1. Set up the site', 'setupSite')
    .addItem('2. Set Google OAuth client ID', 'setGoogleClientId')
    .addToUi();
}

function setupSite() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from a Google Sheet, then run setupSite again.');
  ensureSheet_(ss, PB.COMMISSIONS, ['id','received','status','data','quote','notes','read','archived','thread']);
  ensureSheet_(ss, PB.BUILDS, ['id','data']);
  ensureSheet_(ss, PB.SETTINGS, ['key','value']);
  const props = PropertiesService.getScriptProperties();
  props.setProperty('PB_SPREADSHEET_ID', ss.getId());

  let folderId = props.getProperty('PB_FOLDER_ID');
  let folder;
  if (folderId) {
    try { folder = DriveApp.getFolderById(folderId); } catch (e) {}
  }
  if (!folder) {
    folder = DriveApp.createFolder(PB.FOLDER);
    props.setProperty('PB_FOLDER_ID', folder.getId());
  }
  const settings = readSettings_();
  if (!settings.confirm) writeSetting_('confirm', 'true');
  SpreadsheetApp.getUi().alert('Setup complete. Next choose PinnacleBuild-Studios → 2. Set manager password.');
}

function setGoogleClientId() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Set Google OAuth client ID',
    'Paste the OAuth Client ID ending in .apps.googleusercontent.com. Do not paste a client secret.',
    ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const clientId = response.getResponseText().trim();
  if (!/^[0-9A-Za-z._-]+\\.apps\\.googleusercontent\\.com$/.test(clientId)) {
    ui.alert('That does not look like a Google OAuth Web Client ID. Nothing was changed.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('PB_GOOGLE_CLIENT_ID', clientId);
  ui.alert('Google OAuth Client ID saved. The website will read it automatically.');
}

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'site') return json_(Object.assign({ok:true}, publicSite_()));
  return json_({ok:true, service:'PinnacleBuild-Studios'});
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const req = JSON.parse(raw);
    const result = route_(req || {});
    return json_(Object.assign({ok:true}, result || {}));
  } catch (err) {
    return json_({ok:false, error: safeError_(err)});
  }
}

function route_(req) {
  if (req.action === 'commission') return createCommission_(req);
  if (req.action === 'googleLogin') return googleLogin_(req.credential);
  // Public read-only feed: exposes completed project details only, never customer contact data.
  if (req.action === 'publicCommissions') return publicCommissions_();
  if (req.action === 'admin') {
    requireAuth_(req.token);
    return admin_(req.op, req.payload || {});
  }
  if (req.action === 'site') return publicSite_();
  throw new Error('Unknown request.');
}

function createCommission_(req) {
  const d = req.data || {};
  if (String(req.hp || '').trim()) throw new Error('Request could not be accepted.');
  ['name','gmail','discord','idea'].forEach(k => {
    if (!String(d[k] || '').trim()) throw new Error('Please complete all required fields.');
  });
  if (!/^[a-z0-9._%+-]+@(gmail|googlemail)\.com$/i.test(String(d.gmail))) {
    throw new Error('Please use a Gmail address.');
  }
  const id = 'PB-' + Utilities.getUuid().slice(0,8).toUpperCase();
  const received = new Date().toISOString();
  const row = [id, received, 'New', JSON.stringify(d), '', '', false, false, '[]'];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet_(PB.COMMISSIONS).appendRow(row);
  } finally { lock.releaseLock(); }

  const settings = readSettings_();
  const owner = String(settings.notify || Session.getEffectiveUser().getEmail() || '').trim();
  const subject = 'New PinnacleBuild-Studios commission: ' + d.name;
  const body = [
    'A new commission request was submitted.',
    '',
    'Reference: ' + id,
    'Name: ' + d.name,
    'Gmail: ' + d.gmail,
    'Discord: ' + d.discord,
    'Build type: ' + (d.type || ''),
    'Platform: ' + (d.platform || ''),
    'Size: ' + (d.size || ''),
    'Budget: ' + (d.budget || ''),
    'Deadline: ' + (d.deadline || ''),
    '',
    'Idea:',
    d.idea || '',
    '',
    'References:',
    d.refs || ''
  ].join('\n');
  if (owner) MailApp.sendEmail(owner, subject, body);

  let confirmed = false;
  if (String(settings.confirm || 'true') === 'true') {
    MailApp.sendEmail(String(d.gmail), 'We received your build request — PinnacleBuild-Studios',
      'Hi ' + d.name + ',\n\nYour commission request has been received. Your reference is ' + id +
      '. The studio will review your idea and reply by email.\n\nThanks,\nPinnacleBuild-Studios');
    confirmed = true;
  }
  return {ref:id, confirmed:confirmed};
}

function googleLogin_(credential) {
  const props = PropertiesService.getScriptProperties();
  const clientId = String(props.getProperty('PB_GOOGLE_CLIENT_ID') || '').trim();
  if (!clientId) throw new Error('Google sign-in is not configured yet. Set the Google OAuth client ID from the spreadsheet menu.');
  const idToken = String(credential || '').trim();
  if (!idToken || idToken.length > 12000) throw new Error('Google sign-in did not return a valid credential.');
  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
  const response = UrlFetchApp.fetch(url, {muteHttpExceptions:true});
  if (response.getResponseCode() !== 200) throw new Error('Google could not verify this sign-in. Please try again.');
  let claims;
  try { claims = JSON.parse(response.getContentText()); }
  catch (e) { throw new Error('Google returned an unreadable sign-in response.'); }
  const email = String(claims.email || '').trim().toLowerCase();
  const issuer = String(claims.iss || '');
  const expiry = Number(claims.exp || 0);
  const now = Math.floor(Date.now() / 1000);
  const verified = claims.email_verified === true || String(claims.email_verified) === 'true';
  if (claims.aud !== clientId || !['accounts.google.com','https://accounts.google.com'].includes(issuer) ||
      !claims.sub || !verified || !expiry || expiry <= now) {
    throw new Error('Google sign-in could not be validated. Please try again.');
  }
  if (email !== PB.OWNER_EMAIL) throw new Error('This Google account does not have owner access to Pinnacle Builds.');
  const token = Utilities.getUuid() + Utilities.getUuid();
  const ttl = Math.max(60, Math.min(PB.TOKEN_TTL, expiry - now));
  CacheService.getScriptCache().put('PB_TOKEN_' + token, email, ttl);
  return {token:token, email:email};
}

function requireAuth_(token) {
  if (!token || CacheService.getScriptCache().get('PB_TOKEN_' + token) !== PB.OWNER_EMAIL) {
    const err = new Error('Your session expired. Please sign in again.');
    err.signedOut = true;
    throw err;
  }
}

function admin_(op, p) {
  if (op === 'load') return {site:siteData_(), commissions:commissions_()};
  if (op === 'commissions') return {commissions:commissions_()};
  if (op === 'updateCommission') {
    const c = findCommission_(p.id);
    if (!c) throw new Error('Commission not found.');
    if (p.status !== undefined) c.status = p.status;
    if (p.quote !== undefined) c.quote = p.quote;
    if (p.notes !== undefined) c.notes = p.notes;
    if (p.read !== undefined) c.read = !!p.read;
    if (p.archived !== undefined) c.archived = !!p.archived;
    saveCommission_(c);
    return {commissions:commissions_()};
  }
  if (op === 'deleteCommission') {
    const sh = sheet_(PB.COMMISSIONS), values = sh.getDataRange().getValues();
    for (let i=1;i<values.length;i++) if (String(values[i][0]) === String(p.id)) { sh.deleteRow(i+1); break; }
    return {commissions:commissions_()};
  }
  if (op === 'reply') {
    const c = findCommission_(p.id);
    if (!c) throw new Error('Commission not found.');
    const to = String(c.data.gmail || '');
    if (!to) throw new Error('This request has no reply email address.');
    const subject = String(p.subject || 'Your PinnacleBuild-Studios commission');
    const message = String(p.message || '');
    if (!message.trim()) throw new Error('Write a message first.');
    GmailApp.sendEmail(to, subject, message);
    c.thread.push({at:new Date().toISOString(), subject:subject, text:message});
    if (c.status === 'New') c.status = 'Reviewing';
    saveCommission_(c);
    return {commissions:commissions_()};
  }
  if (op === 'saveBuild') {
    const b = p.build || {};
    const id = b.id || ('build-' + Utilities.getUuid().slice(0,8));
    const current = findBuild_(id) || {id:id, created:Date.now(), gallery:[]};
    Object.keys(b).forEach(k => { current[k] = b[k]; });
    current.id = id;
    current.tags = Array.isArray(current.tags) ? current.tags : String(current.tags || '').split(',').map(x=>x.trim()).filter(Boolean);
    saveBuild_(current);
    return {id:id, site:siteData_()};
  }
  if (op === 'deleteBuild') {
    deleteBuild_(p.id);
    return {site:siteData_()};
  }
  if (op === 'upload') return upload_(p);
  if (op === 'removeFile') return removeFile_(p);
  if (op === 'saveSettings') {
    Object.keys(p.settings || {}).forEach(k => writeSetting_(k, p.settings[k]));
    return {site:siteData_()};
  }
  if (op === 'saveFeatured') {
    writeSetting_('featured', JSON.stringify(p.ids || []));
    return {site:siteData_()};
  }
  if (op === 'changePassword') {
    const props = PropertiesService.getScriptProperties();
    const salt = props.getProperty('PB_PASSWORD_SALT') || '';
    if (hash_(salt + String(p.current || '')) !== props.getProperty('PB_PASSWORD_HASH')) throw new Error('Current password is incorrect.');
    if (String(p.next || '').length < 10) throw new Error('New password must be at least 10 characters.');
    const nextSalt = Utilities.getUuid();
    props.setProperties({PB_PASSWORD_SALT:nextSalt, PB_PASSWORD_HASH:hash_(nextSalt + p.next)});
    return {};
  }
  throw new Error('Unknown manager action.');
}

function upload_(p) {
  const b = findBuild_(p.buildId);
  if (!b) throw new Error('Build not found. Save the build first.');
  const data = String(p.data || '');
  if (!data) throw new Error('No file data received.');
  const bytes = Utilities.base64Decode(data);
  const blob = Utilities.newBlob(bytes, mimeFor_(p.name), String(p.name || 'upload'));
  const file = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('PB_FOLDER_ID')).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const id = file.getId();
  const isImage = ['cover','gallery'].includes(p.kind);
  const item = {id:id, name:String(p.name || 'File'), size:Number(p.size || bytes.length),
    url:isImage ? 'https://drive.google.com/uc?export=view&id=' + id : file.getUrl()};
  if (p.kind === 'gallery') b.gallery = (b.gallery || []).concat([item]);
  else if (['cover','structure','world'].includes(p.kind)) b[p.kind] = item;
  else throw new Error('Unsupported file type.');
  saveBuild_(b);
  return {site:siteData_()};
}

function removeFile_(p) {
  const b = findBuild_(p.buildId);
  if (!b) throw new Error('Build not found.');
  if (p.kind === 'gallery') {
    b.gallery = (b.gallery || []).filter(x => x.id !== p.fileId);
  } else if (['cover','structure','world'].includes(p.kind)) {
    const old = b[p.kind];
    if (old && old.id) { try { DriveApp.getFileById(old.id).setTrashed(true); } catch(e) {} }
    b[p.kind] = null;
  }
  saveBuild_(b);
  return {site:siteData_()};
}

function publicSite_() {
  const s = siteData_();
  const settings = s.settings || {};
  return {settings:settings, featured:s.featured || [], builds:(s.builds || []).filter(b => !b.hidden),
    googleClientId:String(PropertiesService.getScriptProperties().getProperty('PB_GOOGLE_CLIENT_ID') || '')};
}

function siteData_() {
  const settings = readSettings_();
  let featured = [];
  try { featured = JSON.parse(settings.featured || '[]'); } catch(e) {}
  return {settings:settings, featured:featured, builds:allBuilds_()};
}

function allBuilds_() {
  const sh = sheet_(PB.BUILDS), values = sh.getDataRange().getValues(), out=[];
  for (let i=1;i<values.length;i++) {
    if (!values[i][0] || !values[i][1]) continue;
    try { out.push(JSON.parse(values[i][1])); } catch(e) {}
  }
  return out;
}

function commissions_() {
  const sh = sheet_(PB.COMMISSIONS), values = sh.getDataRange().getValues(), out=[];
  for (let i=1;i<values.length;i++) {
    const r=values[i]; if (!r[0]) continue;
    let data={}, thread=[];
    try { data=JSON.parse(r[3] || '{}'); } catch(e) {}
    try { thread=JSON.parse(r[8] || '[]'); } catch(e) {}
    out.push({id:r[0], received:r[1], status:r[2], ...data, data:data,
      quote:r[4] || '', notes:r[5] || '', read:r[6] === true || r[6] === 'true',
      archived:r[7] === true || r[7] === 'true', thread:thread});
  }
  return out.reverse();
}

// Safe public projection of completed commissions. Do not return name, Gmail,
// Discord, private notes, quote, email thread, or the original data object.
function publicCommissions_() {
  return {commissions: commissions_()
    .filter(c => String(c.status).toLowerCase() === 'done' && !c.archived)
    .map(c => ({
      id: String(c.id || ''),
      received: c.received || '',
      status: 'Done',
      type: String(c.type || ''),
      platform: String(c.platform || ''),
      size: String(c.size || ''),
      budget: String(c.budget || ''),
      deadline: String(c.deadline || ''),
      idea: String(c.idea || ''),
      refs: String(c.refs || '')
    }))};
}

function findCommission_(id) {
  return commissions_().find(c => String(c.id) === String(id)) || null;
}
function saveCommission_(c) {
  const sh=sheet_(PB.COMMISSIONS), values=sh.getDataRange().getValues();
  for (let i=1;i<values.length;i++) if (String(values[i][0])===String(c.id)) {
    sh.getRange(i+1,1,1,9).setValues([[c.id,c.received,c.status,JSON.stringify(c.data || {
      name:c.name,gmail:c.gmail,discord:c.discord,type:c.type,platform:c.platform,size:c.size,budget:c.budget,deadline:c.deadline,idea:c.idea,refs:c.refs
    }),c.quote || '',c.notes || '',!!c.read,!!c.archived,JSON.stringify(c.thread || [])]]);
    return;
  }
}

function findBuild_(id) { return allBuilds_().find(b => String(b.id)===String(id)) || null; }
function saveBuild_(b) {
  const sh=sheet_(PB.BUILDS), values=sh.getDataRange().getValues();
  for (let i=1;i<values.length;i++) if (String(values[i][0])===String(b.id)) {
    sh.getRange(i+1,1,1,2).setValues([[b.id,JSON.stringify(b)]]); return;
  }
  sh.appendRow([b.id,JSON.stringify(b)]);
}
function deleteBuild_(id) {
  const sh=sheet_(PB.BUILDS), values=sh.getDataRange().getValues();
  for (let i=1;i<values.length;i++) if (String(values[i][0])===String(id)) { sh.deleteRow(i+1); return; }
}

function readSettings_() {
  const sh=sheet_(PB.SETTINGS), values=sh.getDataRange().getValues(), out={};
  for (let i=1;i<values.length;i++) if (values[i][0]) out[String(values[i][0])] = String(values[i][1] == null ? '' : values[i][1]);
  return out;
}
function writeSetting_(key,value) {
  const sh=sheet_(PB.SETTINGS), values=sh.getDataRange().getValues();
  for (let i=1;i<values.length;i++) if (String(values[i][0])===String(key)) { sh.getRange(i+1,2).setValue(String(value)); return; }
  sh.appendRow([key,String(value)]);
}
function sheet_(name) {
  const id=PropertiesService.getScriptProperties().getProperty('PB_SPREADSHEET_ID');
  if (!id) throw new Error('Run setupSite from the Google Sheet first.');
  const sh=SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sh) throw new Error('Missing sheet tab: ' + name + '. Run setupSite again.');
  return sh;
}
function ensureSheet_(ss,name,headers) {
  let sh=ss.getSheetByName(name);
  if (!sh) sh=ss.insertSheet(name);
  if (sh.getLastRow()===0) sh.appendRow(headers);
  return sh;
}
function hash_(value) {
  const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8);
  return bytes.map(b => ('0'+((b+256)%256).toString(16)).slice(-2)).join('');
}
function mimeFor_(name) {
  const n=String(name||'').toLowerCase();
  if (/\.(jpg|jpeg)$/.test(n)) return 'image/jpeg';
  if (/\.png$/.test(n)) return 'image/png';
  if (/\.webp$/.test(n)) return 'image/webp';
  if (/\.gif$/.test(n)) return 'image/gif';
  if (/\.mcstructure$/.test(n)) return 'application/octet-stream';
  if (/\.mcworld$/.test(n)) return 'application/zip';
  if (/\.zip$/.test(n)) return 'application/zip';
  return 'application/octet-stream';
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function safeError_(err) {
  const msg = err && err.message ? String(err.message) : 'Unexpected server error.';
  return msg.slice(0,300);
}
