/**
 * APW Hours Log — backend for the GitHub Pages site.
 *
 * Paste this into the spreadsheet's Extensions → Apps Script editor, set FIREBASE_API_KEY,
 * then Deploy → Manage deployments → Edit → New version (or New deployment → Web app,
 * Execute as: Me, Who has access: Anyone). See README.md for the full steps.
 *
 * Every request must carry a Firebase ID token, which is checked with Google before
 * anything is read or written. Data lives in three tabs:
 *   - the first tab:  Username, Name, Week, Hours, Notes  (one row per student per week;
 *                     Username is the student's email, Week is the week's start date)
 *   - "Users":        Email, Name, Role, Joined           (created automatically)
 *   - "Weeks":        Id, Label, Start, End, Auto         (created automatically)
 * The first person to sign in becomes an admin.
 */

// Your Firebase project's Web API key (Firebase console → Project settings → General → Web API key).
const FIREBASE_API_KEY = 'AIzaSyBb8wcNriO5UCBHXG710Qz7Jo_Gba90Vq0';

const HOURS_SHEET = ''; // blank = first tab
const USERS_SHEET = 'Users';
const WEEKS_SHEET = 'Weeks';

const HOURS_HEADERS = ['Username', 'Name', 'Week', 'Hours', 'Notes'];
const USERS_HEADERS = ['Email', 'Name', 'Role', 'Joined'];
const WEEKS_HEADERS = ['Id', 'Label', 'Start', 'End', 'Auto'];

function doGet() {
  return json_({ ok: true, app: 'APW Hours Log' });
}

// Run this once from the Apps Script editor (select "authorize", click Run) to grant the
// permissions the web app needs: editing this spreadsheet and contacting Firebase.
function authorize() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/', { muteHttpExceptions: true });
  Logger.log('Authorized. The web app can now check Firebase logins.');
}

function doPost(e) {
  let result;
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    const auth = verifyToken_(body.idToken);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      result = route_(body, auth);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    result = { error: String((err && err.message) || err) };
  }
  return json_(result);
}

function route_(body, auth) {
  const me = registerUser_(auth, body.name);
  const requireAdmin = () => { if (!me.is_admin) fail_('Admins only'); };
  switch (body.action) {
    case 'me': {
      const weeks = listWeeks_();
      const result = { user: me, weeks, entries: entriesFor_(me.email, weeks) };
      // Admins land on the admin panel, so send its data now and save a second (slow) round trip.
      if (me.is_admin && body.withOverview) result.overview = overview_();
      return result;
    }
    case 'saveEntry':
      saveEntry_(me, body);
      return { entries: entriesFor_(me.email, listWeeks_()) };
    case 'deleteEntry':
      deleteEntry_(me, body);
      return { entries: entriesFor_(me.email, listWeeks_()) };
    case 'overview':
      requireAdmin();
      return overview_();
    case 'userEntries':
      requireAdmin();
      return userEntries_(body.email);
    case 'saveWeek':
      requireAdmin();
      saveWeek_(body);
      return { weeks: listWeeks_() };
    case 'deleteWeek':
      requireAdmin();
      deleteWeek_(body.id);
      return { weeks: listWeeks_() };
    case 'setRole':
      requireAdmin();
      setRole_(me, body);
      return { ok: true };
  }
  fail_('Unknown action');
}

// ---------- auth ----------

// Checks a Firebase ID token with Google and returns { uid, email, name }.
function verifyToken_(idToken) {
  if (FIREBASE_API_KEY.indexOf('PASTE') === 0) fail_('Set FIREBASE_API_KEY in the Apps Script first');
  if (!idToken) fail_('Please log in');
  const cache = CacheService.getScriptCache();
  const key = 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const res = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(FIREBASE_API_KEY),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken }), muteHttpExceptions: true }
  );
  const data = JSON.parse(res.getContentText() || '{}');
  const user = data.users && data.users[0];
  if (res.getResponseCode() !== 200 || !user || !user.email || user.disabled) fail_('Your login expired. Please log in again.');
  const auth = { uid: user.localId, email: String(user.email).toLowerCase(), name: user.displayName || '' };
  cache.put(key, JSON.stringify(auth), 600);
  return auth;
}

function registerUser_(auth, name) {
  const t = table_(USERS_SHEET, USERS_HEADERS);
  const row = t.rows.find(r => String(r.email).toLowerCase() === auth.email);
  const cleanName = String(name || auth.name || '').trim().slice(0, 80);
  if (!row) {
    const role = t.rows.some(r => r.email) ? 'student' : 'admin';
    const display = cleanName || auth.email.split('@')[0];
    writeRow_(t, null, { email: auth.email, name: display, role, joined: today_() });
    return { email: auth.email, name: display, is_admin: role === 'admin' };
  }
  if (!row.name && cleanName) writeRow_(t, row._row, { name: cleanName });
  return { email: auth.email, name: String(row.name || cleanName || auth.email), is_admin: isAdminRow_(row) };
}

function isAdminRow_(row) {
  return String(row.role).toLowerCase() === 'admin';
}

function setRole_(me, body) {
  const email = String(body.email || '').toLowerCase();
  if (email === me.email) fail_("You can't change your own role");
  const t = table_(USERS_SHEET, USERS_HEADERS);
  const row = t.rows.find(r => String(r.email).toLowerCase() === email);
  if (!row) fail_('User not found');
  writeRow_(t, row._row, { role: body.is_admin ? 'admin' : 'student' });
}

// ---------- weeks ----------

function toWeek_(r) {
  return { id: Number(r.id), label: String(r.label || ''), start: String(r.start), end: String(r.end), auto: String(r.auto) === '1' || r.auto === true, _row: r._row };
}

function weekRows_(t) {
  return t.rows.filter(r => r.id !== '' && r.start && r.end).map(toWeek_);
}

function listWeeks_() {
  ensureCurrentWeek_();
  return weekRows_(table_(WEEKS_SHEET, WEEKS_HEADERS))
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .map(w => ({ id: w.id, label: w.label, start: w.start, end: w.end }));
}

function nextId_(weeks) {
  return weeks.reduce((m, w) => Math.max(m, w.id || 0), 0) + 1;
}

// Make sure some week covers today, so students always have somewhere to log hours.
// Creates the Monday–Sunday week containing today, trimmed so it doesn't overlap
// any week the admin already set up. Admins can relabel or adjust it afterward.
function ensureCurrentWeek_() {
  const t = table_(WEEKS_SHEET, WEEKS_HEADERS);
  const weeks = weekRows_(t);
  const today = today_();
  if (weeks.some(w => w.start <= today && today <= w.end)) return;
  let start = addDays_(today, -weekday_(today));
  let end = addDays_(start, 6);
  const prevEnd = weeks.filter(w => w.end < today).map(w => w.end).sort().pop();
  const nextStart = weeks.filter(w => w.start > today).map(w => w.start).sort()[0];
  if (prevEnd && addDays_(prevEnd, 1) > start) start = addDays_(prevEnd, 1);
  if (nextStart && addDays_(nextStart, -1) < end) end = addDays_(nextStart, -1);
  writeRow_(t, null, { id: nextId_(weeks), label: '', start, end, auto: 1 });
}

function findWeek_(id) {
  const week = listWeeks_().find(w => w.id === Number(id));
  if (!week) fail_('Week not found');
  return week;
}

function saveWeek_(body) {
  const label = String(body.label || '').trim();
  const start = String(body.start || '');
  const end = String(body.end || '');
  if (!isIsoDate_(start) || !isIsoDate_(end)) fail_('Pick a start and end date');
  if (end < start) fail_('End date must be on or after the start date');
  if (label.length > 60) fail_('Label is too long (60 characters max)');
  const id = body.id ? Number(body.id) : null;
  const t = table_(WEEKS_SHEET, WEEKS_HEADERS);
  const weeks = weekRows_(t);
  const editing = id ? weeks.find(w => w.id === id) : null;
  if (id && !editing) fail_('Week not found');
  const overlapping = weeks.filter(w => w.id !== id && w.start <= end && w.end >= start);
  // Admin-defined weeks replace auto-created ones that nobody has logged hours in yet.
  const hourRows = table_(HOURS_SHEET, HOURS_HEADERS).rows;
  const replaceable = overlapping.filter(w => w.auto && !hourRows.some(r => r.week >= w.start && r.week <= w.end));
  const clash = overlapping.find(w => replaceable.indexOf(w) === -1);
  if (clash) fail_(`Overlaps ${clash.label || 'the week'} (${clash.start} to ${clash.end})`);
  if (editing) writeRow_(t, editing._row, { label, start, end, auto: 0 });
  else writeRow_(t, null, { id: nextId_(weeks), label, start, end, auto: 0 });
  deleteRows_(t, replaceable.map(w => w._row));
}

function deleteWeek_(id) {
  const t = table_(WEEKS_SHEET, WEEKS_HEADERS);
  const week = weekRows_(t).find(w => w.id === Number(id));
  if (!week) fail_('Week not found');
  deleteRows_(t, [week._row]);
}

// ---------- hours ----------

// { email: { weekId: { week_id, hours, description } } } — a row belongs to whichever
// week contains the date in its Week column.
function hoursByUser_(weeks) {
  const out = {};
  table_(HOURS_SHEET, HOURS_HEADERS).rows.forEach(r => {
    const email = String(r.username).toLowerCase();
    const week = weeks.find(w => w.start <= r.week && r.week <= w.end);
    const hours = Number(r.hours);
    if (!email || !week || r.hours === '' || !isFinite(hours)) return;
    (out[email] = out[email] || {})[week.id] = { week_id: week.id, hours, description: String(r.notes) };
  });
  return out;
}

function entriesFor_(email, weeks) {
  return hoursByUser_(weeks)[email] || {};
}

function userWeekRows_(t, email, week) {
  return t.rows
    .filter(r => String(r.username).toLowerCase() === email && r.week >= week.start && r.week <= week.end)
    .map(r => r._row);
}

function saveEntry_(me, body) {
  const week = findWeek_(body.week_id);
  if (week.start > today_()) fail_("That week hasn't started yet");
  const hours = Math.round(Number(body.hours) * 100) / 100;
  if (!isFinite(hours) || hours <= 0 || hours > 100) fail_('Weekly hours must be between 0 and 100');
  const notes = String(body.description || '').trim();
  if (!notes) fail_('Describe what you worked on this week');
  if (notes.length > 2000) fail_('Description is too long (2000 characters max)');
  const t = table_(HOURS_SHEET, HOURS_HEADERS);
  const rows = userWeekRows_(t, me.email, week);
  writeRow_(t, rows[0] || null, { username: me.email, name: me.name, week: week.start, hours, notes });
  deleteRows_(t, rows.slice(1)); // drop duplicates for the same week
}

function deleteEntry_(me, body) {
  const t = table_(HOURS_SHEET, HOURS_HEADERS);
  deleteRows_(t, userWeekRows_(t, me.email, findWeek_(body.week_id)));
}

// ---------- admin views ----------

function overview_() {
  const weeks = listWeeks_();
  const hours = hoursByUser_(weeks);
  const students = table_(USERS_SHEET, USERS_HEADERS).rows.filter(r => r.email).map(r => {
    const email = String(r.email).toLowerCase();
    const per = {};
    let total = 0;
    Object.keys(hours[email] || {}).forEach(id => {
      per[id] = hours[email][id].hours;
      total += hours[email][id].hours;
    });
    return { email, name: String(r.name || email), is_admin: isAdminRow_(r), hours: per, total: Math.round(total * 100) / 100 };
  });
  return { weeks, students };
}

function userEntries_(email) {
  email = String(email || '').toLowerCase();
  const row = table_(USERS_SHEET, USERS_HEADERS).rows.find(r => String(r.email).toLowerCase() === email);
  if (!row) fail_('User not found');
  const weeks = listWeeks_();
  return {
    user: { email, name: String(row.name || email), is_admin: isAdminRow_(row) },
    weeks,
    entries: entriesFor_(email, weeks),
  };
}

// ---------- sheet helpers ----------

// Reads a tab (creating it with headers if missing) into { sh, cols, width, rows }.
// Each row is { _row, _raw, <lowercase header>: value }.
function table_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = name ? ss.getSheetByName(name) : ss.getSheets()[0];
  if (!sh) {
    sh = ss.insertSheet(name, ss.getNumSheets());
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@'); // keep dates as plain text
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const width = Math.max(sh.getLastColumn(), headers.length);
  const values = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), width).getValues();
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const cols = {};
  headers.forEach(h => {
    const i = header.indexOf(h.toLowerCase());
    if (i === -1) fail_(`The "${sh.getName()}" tab is missing a "${h}" column header`);
    cols[h.toLowerCase()] = i;
  });
  const rows = values.slice(1).map((r, i) => {
    const row = { _row: i + 2, _raw: r };
    Object.keys(cols).forEach(k => { row[k] = cell_(r[cols[k]]); });
    return row;
  });
  return { sh, cols, width, rows };
}

function cell_(v) {
  // Date cells from getValues() don't always pass `instanceof Date`, so check the tag instead.
  if (Object.prototype.toString.call(v) === '[object Date]' || (v && typeof v.getTime === 'function')) {
    return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  }
  return typeof v === 'string' ? v.trim() : v;
}

// Writes fields into sheet row `row`, or appends a new row when `row` is null.
function writeRow_(t, row, fields) {
  const existing = row ? t.rows.find(r => r._row === row) : null;
  const line = existing ? existing._raw.slice() : new Array(t.width).fill('');
  Object.keys(fields).forEach(k => { line[t.cols[k]] = safe_(fields[k]); });
  t.sh.getRange(row || t.sh.getLastRow() + 1, 1, 1, t.width).setValues([line]);
}

// Text starting with = + - @ would be run as a formula; a leading ' keeps it as text.
function safe_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function deleteRows_(t, rows) {
  rows.slice().sort((a, b) => b - a).forEach(r => t.sh.deleteRow(r));
}

// ---------- misc ----------

function fail_(message) {
  throw new Error(message);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function tz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
}

function today_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function isIsoDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays_(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 0 = Monday … 6 = Sunday
function weekday_(iso) {
  return (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7;
}
