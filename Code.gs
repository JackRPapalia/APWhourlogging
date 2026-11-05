/**
 * APW Hours Log — an Apps Script web app, embedded in a Google Site.
 *
 * This file is Code.gs in the spreadsheet's Extensions → Apps Script project; the page is
 * the HTML file Index.html in the same project. Deploy → New deployment → Web app with
 * Execute as: Me and Who has access: Anyone within trevor.org, then embed the web app URL
 * in the Google Site. See README.md for the full steps.
 *
 * Google tells the script who is using the page (their signed-in school account), so there
 * is no separate login. Only people listed on a roster tab get in:
 *   - "Admins", "Section 1", "Section 2":  one email per row in column A (any header row,
 *                     blank rows and "mailto:" links are fine). Admins manage the class;
 *                     a student's section is the tab they're on.
 * Other data:
 *   - the first tab:  Username, Name, Week, Hours, Notes  (one row per student per week;
 *                     Username is the student's email, Week is the week's start date)
 *   - "Users":        Email, Name, Joined, Last login     (created automatically; names
 *                     come from people's Google accounts the first time they sign in)
 *   - "Weeks":        Id, Label, Start, End, Auto         (created automatically)
 * Before anyone can sign in, type at least one admin's email into the Admins tab by hand.
 */

// The school's Google Workspace domain. Only used in messages; the deployment setting
// "Who has access: Anyone within trevor.org" is what keeps other accounts out.
const SCHOOL_DOMAIN = 'trevor.org';

// The Google Sites page the app is embedded in, for the link in "log your hours" reminder
// emails. Leave blank to link to the web app's own URL instead.
const SITE_URL = '';

// Names come from the school directory when the optional Admin SDK service is turned on
// (see README); a looked-up name is remembered this long.
const NAME_CACHE_SECONDS = 6 * 60 * 60;

const HOURS_SHEET = ''; // blank = first tab
const USERS_SHEET = 'Users';
const ADMINS_SHEET = 'Admins';
const SECTIONS = ['Section 1', 'Section 2'];
const WEEKS_SHEET = 'Weeks';

const HOURS_HEADERS = ['Username', 'Name', 'Week', 'Hours', 'Notes', 'Updated', 'Updated by', 'Excused'];
const USERS_HEADERS = ['Email', 'Name', 'Joined', 'Last login'];
// Tabs the app manages itself: a missing column header is added instead of reported.
const OWN_TABS = [USERS_SHEET, 'Weeks', 'Settings'];
// Columns added by newer versions of the app; they're added to any tab that lacks them.
const OPTIONAL_HEADERS = ['Last login', 'Updated', 'Updated by', 'Excused', 'No class'];
const SETTINGS_SHEET = 'Settings';
const SETTINGS_HEADERS = ['Key', 'Value'];
// Students can change a week until this many days after it ends, unless the admin changes it.
const DEFAULT_GRACE_DAYS = 2;
// Opening the site again within this long doesn't rewrite the last-login time.
const LOGIN_EVERY_MS = 5 * 60 * 1000;
const WEEKS_HEADERS = ['Id', 'Label', 'Start', 'End', 'Auto', 'No class'];

// Serves the page. ALLOWALL lets a Google Site (or any page) show it in an embed.
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('APW Hours Log')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Actions that change the sheet. They take the script lock up front; everything else
// only reads, so many students can load the page at once without queueing.
const WRITE_ACTIONS = ['saveEntry', 'deleteEntry', 'excuseEntry', 'saveWeek', 'addWeeks', 'deleteWeek', 'addUsers', 'removeUser', 'saveSettings'];

// Per-request state: tab reads are remembered until something is written (each Sheets
// call is slow), and the lock is only held when this request needs to write.
let REQ = { memo: {}, lock: null };

// The page's only way in: it calls api({ action, ... }) through google.script.run.
// Any other top-level function without a trailing "_" could be called from the page too,
// so every helper's name ends in "_". Returns a JSON string, which avoids google.script.run's
// limits on what objects it can pass back.
function api(body) {
  let result;
  REQ = { memo: {}, lock: null };
  try {
    body = body && typeof body === 'object' ? body : {};
    const auth = currentUser_();
    if (WRITE_ACTIONS.indexOf(body.action) !== -1) lock_();
    result = route_(body, auth);
  } catch (err) {
    if (err && err.forUser) {
      result = { error: err.message };
    } else {
      // Unexpected errors can mention tab names or other internals: log them for the
      // script owner (Apps Script → Executions) and send the browser a plain message.
      console.error((err && err.stack) || err);
      result = { error: 'Something went wrong. Please try again, and tell your teacher if it keeps happening.' };
    }
  } finally {
    if (REQ.lock) REQ.lock.releaseLock();
  }
  return JSON.stringify(result);
}

function memo_(key, fn) {
  if (key in REQ.memo) return REQ.memo[key];
  const value = fn(); // may call changed_(), which replaces REQ.memo, so store afterwards
  REQ.memo[key] = value;
  return value;
}

// Call after any write so later reads in this request see it.
function changed_() {
  REQ.memo = {};
}

// Takes the script lock before a write. Returns true if it was only just taken, in which
// case another request may have written in the meantime and the caller should re-check.
function lock_() {
  if (REQ.lock) return false;
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    fail_('The server is busy. Please try again in a moment.');
  }
  REQ.lock = lock;
  changed_();
  return true;
}

function route_(body, auth) {
  // Loading the page ("me") counts as signing in; saves and other actions don't.
  const me = registerUser_(auth, body.action === 'me');
  const requireAdmin = () => { if (!me.is_admin) fail_('Admins only'); };
  switch (body.action) {
    case 'me': {
      const weeks = listWeeks_();
      const result = { user: me, weeks, entries: entriesFor_(me.email, weeks), settings: settings_(), site_url: siteUrl_(), app_url: appUrl_() };
      // Admins land on the admin panel, so send its data now and save a second (slow) round trip.
      if (me.is_admin && body.withOverview) result.overview = overview_();
      return result;
    }
    case 'saveEntry':
    case 'deleteEntry': {
      // Admins can correct anyone's week by passing their email.
      const target = entryTarget_(me, body);
      if (body.action === 'saveEntry') saveEntry_(me, target, body);
      else deleteEntry_(me, target, body);
      const result = { entries: entriesFor_(target.email, listWeeks_()) };
      if (target.email !== me.email) result.overview = overview_();
      return result;
    }
    case 'excuseEntry': {
      requireAdmin();
      const target = entryTarget_(me, body);
      excuseEntry_(me, target, body);
      return { entries: entriesFor_(target.email, listWeeks_()), overview: overview_() };
    }
    case 'addWeeks':
      requireAdmin();
      addWeeks_(body);
      return { weeks: listWeeks_(), overview: overview_() };
    case 'saveSettings':
      requireAdmin();
      saveSettings_(body);
      return { settings: settings_(), weeks: listWeeks_(), overview: overview_() };
    case 'overview':
      requireAdmin();
      return overview_();
    case 'userEntries':
      requireAdmin();
      return userEntries_(body.email);
    case 'saveWeek':
      requireAdmin();
      saveWeek_(body);
      return { weeks: listWeeks_(), overview: overview_() };
    case 'deleteWeek':
      requireAdmin();
      deleteWeek_(body.id);
      return { weeks: listWeeks_(), overview: overview_() };
    case 'addUsers':
      requireAdmin();
      return Object.assign(addUsers_(body), { overview: overview_() });
    case 'removeUser':
      requireAdmin();
      removeUser_(me, body);
      return { overview: overview_() };
  }
  fail_('Unknown action');
}

// ---------- auth ----------

// { email } of the person using the page, from the Google account they're signed in with.
// Google fills this in itself, so the page can't claim to be someone else. It's only
// available to people in the same Google Workspace domain as the script's owner, which is
// why the script must be owned by a @trevor.org account and deployed to "Anyone within
// trevor.org".
function currentUser_() {
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) {
    fail_(`Google didn't say who you are. Open this page while signed in to your @${SCHOOL_DOMAIN} Google account.`);
  }
  return { email };
}

// The person's name from the school directory, or '' if the optional Admin SDK service isn't
// turned on or the directory doesn't share it.
function directoryName_(email) {
  if (typeof AdminDirectory === 'undefined') return '';
  const cache = CacheService.getScriptCache();
  const key = 'name:' + email;
  const hit = cache.get(key);
  if (hit !== null) return JSON.parse(hit); // stored as JSON so a blank name is remembered too
  let name = '';
  try {
    // "domain_public" lets a non-admin script owner read the fields the domain shares.
    const user = AdminDirectory.Users.get(email, { viewType: 'domain_public', fields: 'name/fullName' });
    name = String((user && user.name && user.name.fullName) || '');
  } catch (e) {
    console.warn('Directory lookup failed for ' + email + ': ' + e);
  }
  cache.put(key, JSON.stringify(name), NAME_CACHE_SECONDS);
  return name;
}

// Where reminder emails send students: the Google Site if set, else this web app.
function siteUrl_() {
  return SITE_URL || appUrl_();
}

// This web app's own address (ends in /exec), for the page's "Open full screen" link.
function appUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

// Lets the user in only if they're on a roster tab, records their name the first time,
// and (when `signingIn`) when they last signed in.
function registerUser_(auth, signingIn) {
  // Admins are only ever added by hand in the sheet or by another admin: an empty Admins
  // tab never lets the next person to sign in become one.
  const access = access_(auth.email);
  if (!access.is_admin && !access.section) {
    fail_(`${auth.email} isn't on the class list yet. Ask your teacher to add you, then sign in again.`);
  }
  const find = () => table_(USERS_SHEET, USERS_HEADERS).rows.find(r => String(r.email).toLowerCase() === auth.email);
  let row = find();
  // Names come from the school directory, never from the page, and are only looked up for
  // someone new or whose name cell is blank. Admins can also type names into the Users tab.
  const cleanName = !row || !row.name ? directoryName_(auth.email).trim().slice(0, 80) : '';
  if (!row || (!row.name && cleanName)) {
    if (lock_()) row = find();
    const t = table_(USERS_SHEET, USERS_HEADERS);
    if (!row) writeRow_(t, null, { email: auth.email, name: cleanName || auth.email.split('@')[0], joined: today_() });
    else if (!row.name && cleanName) writeRow_(t, row._row, { name: cleanName });
    row = find();
  }
  if (signingIn && row) {
    const prev = loginMs_(row['last login']);
    if (!prev || Date.now() - prev > LOGIN_EVERY_MS) {
      // Only this person's own cell changes, so no lock is needed; the leading ' keeps it as text.
      const t = table_(USERS_SHEET, USERS_HEADERS);
      t.sh.getRange(row._row, t.cols['last login'] + 1).setValue("'" + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm'));
      changed_();
    }
  }
  return { email: auth.email, name: String((row && row.name) || auth.email), is_admin: access.is_admin, section: access.section };
}

// ---------- rosters ----------

// Tab by name (case and surrounding spaces ignored); blank means the first tab.
function sheetNamed_(name) {
  const tabs = memo_('tabs', () => {
    const list = SpreadsheetApp.getActiveSpreadsheet().getSheets();
    const byName = {};
    list.forEach(sh => { byName[sh.getName().trim().toLowerCase()] = sh; });
    return { first: list[0], byName };
  });
  return name ? tabs.byName[name.trim().toLowerCase()] || null : tabs.first;
}

function rosterSheet_(name) {
  const sh = sheetNamed_(name);
  if (sh) return sh;
  lock_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const created = ss.getSheetByName(name) || ss.insertSheet(name, ss.getNumSheets());
  if (!created.getLastRow()) {
    created.getRange(1, 1).setValue('Email').setFontWeight('bold');
    created.setFrozenRows(1);
  }
  changed_();
  return created;
}

function cleanEmail_(v) {
  return String(v || '').trim().replace(/^mailto:/i, '').trim().toLowerCase();
}

function isEmail_(s) {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);
}

// [{ email, row }] for every email in column A of a roster tab; headers and blanks are skipped.
function rosterRows_(name) {
  return memo_('roster:' + name, () => {
    return rosterSheet_(name).getDataRange().getValues()
      .map((r, i) => ({ email: cleanEmail_(r[0]), row: i + 1 }))
      .filter(r => isEmail_(r.email));
  });
}

function rosterEmails_(name) {
  return rosterRows_(name).map(r => r.email);
}

function appendToRoster_(name, emails) {
  if (!emails.length) return;
  const sh = rosterSheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, emails.length, 1).setValues(emails.map(e => [safe_(e)])); // never a formula
  changed_();
}

function removeFromRoster_(name, emails) {
  const sh = rosterSheet_(name);
  rosterRows_(name).filter(r => emails.indexOf(r.email) !== -1).map(r => r.row).sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  changed_();
}

// { is_admin, section } for one email, from the roster tabs.
function access_(email) {
  return {
    is_admin: rosterEmails_(ADMINS_SHEET).indexOf(email) !== -1,
    section: SECTIONS.find(s => rosterEmails_(s).indexOf(email) !== -1) || '',
  };
}

// Adds emails to Admins or a section. A student can only be in one section, so adding
// them to a section moves them out of the other one.
function addUsers_(body) {
  const group = String(body.group || '');
  if (group !== 'admin' && SECTIONS.indexOf(group) === -1) fail_('Pick Section 1, Section 2 or Admin');
  const emails = [...new Set((Array.isArray(body.emails) ? body.emails : String(body.emails || '').split(/[\s,;]+/)).map(cleanEmail_).filter(Boolean))];
  if (!emails.length) fail_('Enter at least one email address');
  if (emails.length > 300) fail_('Add at most 300 emails at a time');
  const invalid = emails.filter(e => !isEmail_(e));
  if (invalid.length) fail_(`These don't look like email addresses: ${invalid.slice(0, 5).join(', ')}`);
  const tab = group === 'admin' ? ADMINS_SHEET : group;
  const existing = rosterEmails_(tab);
  const others = {}; // other section's name -> its emails, read once
  if (group !== 'admin') SECTIONS.filter(s => s !== group).forEach(s => { others[s] = rosterEmails_(s); });
  const result = { added: [], moved: [], already: [] };
  const moves = {}; // other section -> emails leaving it
  emails.forEach(email => {
    if (existing.indexOf(email) !== -1) return result.already.push(email);
    const other = Object.keys(others).find(s => others[s].indexOf(email) !== -1);
    if (other) {
      (moves[other] = moves[other] || []).push(email);
      result.moved.push(email);
    } else {
      result.added.push(email);
    }
  });
  Object.keys(moves).forEach(s => removeFromRoster_(s, moves[s]));
  appendToRoster_(tab, result.added.concat(result.moved));
  return result;
}

function removeUser_(me, body) {
  const email = cleanEmail_(body.email);
  const group = String(body.group || '');
  if (group === 'admin') {
    if (email === me.email) fail_("You can't remove yourself from Admins");
    removeFromRoster_(ADMINS_SHEET, [email]);
  } else if (SECTIONS.indexOf(group) !== -1) {
    removeFromRoster_(group, [email]);
  } else {
    fail_('Unknown group');
  }
}

// ---------- weeks ----------

function toWeek_(r) {
  return {
    id: Number(r.id), label: String(r.label || ''), start: toIso_(r.start), end: toIso_(r.end),
    auto: String(r.auto) === '1' || r.auto === true, no_class: truthy_(r['no class']), _row: r._row,
  };
}

// "yes", "true", "1", "x" or a checked checkbox.
function truthy_(v) {
  return v === true || /^(yes|true|1|x)$/i.test(String(v == null ? '' : v).trim());
}

// The week an hours row belongs to: the week starting on its date, or else the week that
// contains it. Matching the start first keeps rows right even if two weeks share a day.
function weekFor_(weeks, iso) {
  return weeks.find(w => w.start === iso) ||
    weeks.filter(w => w.start <= iso && iso <= w.end).sort((a, b) => (a.start < b.start ? 1 : -1))[0] ||
    null;
}

function weekRows_(t) {
  return t.rows.filter(r => r.id !== '' && r.start && r.end).map(toWeek_);
}

function listWeeks_() {
  return memo_('weeks', () => {
    ensureCurrentWeek_();
    return weekRows_(table_(WEEKS_SHEET, WEEKS_HEADERS))
      .sort((a, b) => (a.start < b.start ? -1 : 1))
      .map(w => ({ id: w.id, label: w.label, start: w.start, end: w.end, due: dueDate_(w), no_class: w.no_class }));
  });
}

// Last day students can change a week (yyyy-mm-dd), or null when there's no deadline.
function dueDate_(week) {
  const grace = settings_().grace_days;
  return grace === null ? null : addDays_(week.end, grace);
}

function isClosed_(week) {
  return !!week.due && today_() > week.due;
}

// ---------- settings ----------

function settings_() {
  return memo_('settings', () => {
    const out = { grace_days: DEFAULT_GRACE_DAYS };
    table_(SETTINGS_SHEET, SETTINGS_HEADERS).rows.forEach(r => {
      if (String(r.key).trim().toLowerCase() !== 'grace_days') return;
      const v = String(r.value).trim().toLowerCase();
      const n = Math.round(Number(v));
      out.grace_days = v === '' || v === 'none' ? null : (isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_DAYS);
    });
    return out;
  });
}

function saveSettings_(body) {
  const v = body.grace_days;
  let value;
  if (v === null || v === 'none') value = 'none';
  else {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n < 0 || n > 60) fail_('Pick a number of days between 0 and 60');
    value = String(n);
  }
  const t = table_(SETTINGS_SHEET, SETTINGS_HEADERS);
  const row = t.rows.find(r => String(r.key).trim().toLowerCase() === 'grace_days');
  writeRow_(t, row ? row._row : null, { key: 'grace_days', value });
}

function nextId_(weeks) {
  return weeks.reduce((m, w) => Math.max(m, w.id || 0), 0) + 1;
}

// Make sure some week covers today, so students always have somewhere to log hours.
// Creates the Monday–Sunday week containing today, trimmed so it doesn't overlap
// any week the admin already set up. Admins can relabel or adjust it afterward.
function ensureCurrentWeek_() {
  const today = today_();
  let t = table_(WEEKS_SHEET, WEEKS_HEADERS);
  let weeks = weekRows_(t);
  const covered = () => weeks.some(w => w.start <= today && today <= w.end);
  if (covered()) return;
  if (lock_()) {
    // Another request may have added it while we waited for the lock.
    t = table_(WEEKS_SHEET, WEEKS_HEADERS);
    weeks = weekRows_(t);
    if (covered()) return;
  }
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

function cleanWeek_(w) {
  const label = String(w.label || '').trim();
  const start = String(w.start || '');
  const end = String(w.end || '');
  if (!isIsoDate_(start) || !isIsoDate_(end)) fail_('Pick a start and end date');
  if (end < start) fail_('End date must be on or after the start date');
  if (label.length > 60) fail_('Label is too long (60 characters max)');
  return { label, start, end, no_class: !!w.no_class };
}

// Existing weeks overlapping [start, end]. Admin-defined weeks may replace auto-created ones
// that nobody has logged hours in yet ("replaceable"); any other overlap is a "clash".
function overlaps_(weeks, start, end, exceptId) {
  const hourRows = table_(HOURS_SHEET, HOURS_HEADERS).rows;
  const overlapping = weeks.filter(w => w.id !== exceptId && w.start <= end && w.end >= start);
  const replaceable = overlapping.filter(w => w.auto && !hourRows.some(r => toIso_(r.week) >= w.start && toIso_(r.week) <= w.end));
  return { clash: overlapping.find(w => replaceable.indexOf(w) === -1), replaceable };
}

function clashMessage_(w, clash) {
  return `${w.label || w.start} overlaps ${clash.label || 'the week'} (${clash.start} to ${clash.end})`;
}

function saveWeek_(body) {
  const w = cleanWeek_(body);
  const id = body.id ? Number(body.id) : null;
  const t = table_(WEEKS_SHEET, WEEKS_HEADERS);
  const weeks = weekRows_(t);
  const editing = id ? weeks.find(x => x.id === id) : null;
  if (id && !editing) fail_('Week not found');
  const { clash, replaceable } = overlaps_(weeks, w.start, w.end, id);
  if (clash) fail_(`Overlaps ${clash.label || 'the week'} (${clash.start} to ${clash.end})`);
  const fields = { label: w.label, start: w.start, end: w.end, auto: 0, 'no class': w.no_class ? 'yes' : '' };
  if (editing) writeRow_(t, editing._row, fields);
  else writeRow_(t, null, Object.assign({ id: nextId_(weeks) }, fields));
  deleteRows_(t, replaceable.map(x => x._row));
}

// Adds many weeks at once (all or nothing): none may overlap each other or an existing week.
function addWeeks_(body) {
  const list = (Array.isArray(body.weeks) ? body.weeks : []).map(cleanWeek_).sort((a, b) => (a.start < b.start ? -1 : 1));
  if (!list.length) fail_('Add at least one week');
  if (list.length > 60) fail_('Add at most 60 weeks at a time');
  for (let i = 1; i < list.length; i++) {
    if (list[i].start <= list[i - 1].end) fail_(clashMessage_(list[i], list[i - 1]));
  }
  const t = table_(WEEKS_SHEET, WEEKS_HEADERS);
  const weeks = weekRows_(t);
  const replace = {};
  list.forEach(w => {
    const { clash, replaceable } = overlaps_(weeks, w.start, w.end, null);
    if (clash) fail_(clashMessage_(w, clash));
    replaceable.forEach(x => { replace[x._row] = true; });
  });
  let id = nextId_(weeks);
  appendRows_(t, list.map(w => ({ id: id++, label: w.label, start: w.start, end: w.end, auto: 0, 'no class': w.no_class ? 'yes' : '' })));
  deleteRows_(t, Object.keys(replace).map(Number));
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
    const week = weekFor_(weeks, toIso_(r.week));
    const hours = Number(r.hours);
    const excused = truthy_(r.excused);
    if (!email || !week) return;
    if (!excused && (r.hours === '' || !isFinite(hours))) return;
    const updated = loginMs_(r.updated);
    const updatedBy = String(r['updated by'] || '').trim().toLowerCase();
    const updatedDay = typeof r.updated === 'string' ? toIso_(r.updated.slice(0, 10)) : toIso_(r.updated);
    (out[email] = out[email] || {})[week.id] = {
      week_id: week.id, hours: excused ? 0 : hours, description: String(r.notes), excused,
      updated, updated_by: updatedBy || null,
      // Logged by the student after the week was over (during the grace period).
      late: !excused && !!updated && (!updatedBy || updatedBy === email) && updatedDay > week.end,
    };
  });
  return out;
}

function entriesFor_(email, weeks) {
  return hoursByUser_(weeks)[email] || {};
}

function userWeekRows_(t, email, week) {
  const weeks = listWeeks_();
  return t.rows
    .filter(r => String(r.username).toLowerCase() === email && (weekFor_(weeks, toIso_(r.week)) || {}).id === week.id)
    .map(r => r._row);
}

// Whose week is being changed: yourself, or (admins only) the student named by body.email.
function entryTarget_(me, body) {
  const email = cleanEmail_(body.email);
  if (!email || email === me.email) return me;
  if (!me.is_admin) fail_('Admins only');
  const access = access_(email);
  if (!access.is_admin && !access.section) fail_(`${email} isn't on the class list`);
  const row = table_(USERS_SHEET, USERS_HEADERS).rows.find(r => String(r.email).toLowerCase() === email);
  return { email, name: String((row && row.name) || email) };
}

function closedMessage_(week) {
  return `${week.label || 'That week'} closed on ${week.due}. Ask your teacher if it needs changing.`;
}

function stamp_() {
  return "'" + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm'); // leading ' keeps it as text
}

function saveEntry_(me, target, body) {
  const week = findWeek_(body.week_id);
  if (week.start > today_()) fail_("That week hasn't started yet");
  if (!me.is_admin && isClosed_(week)) fail_(closedMessage_(week));
  if (!me.is_admin && week.no_class) fail_(`There was no class ${week.label ? 'in ' + week.label : 'that week'}, so there's nothing to log.`);
  const hours = Math.round(Number(body.hours) * 100) / 100;
  if (!isFinite(hours) || hours <= 0 || hours > 100) fail_('Weekly hours must be between 0 and 100');
  const notes = String(body.description || '').trim();
  if (!notes) fail_('Describe what you worked on this week');
  if (notes.length > 2000) fail_('Description is too long (2000 characters max)');
  const t = table_(HOURS_SHEET, HOURS_HEADERS);
  const rows = userWeekRows_(t, target.email, week);
  writeRow_(t, rows[0] || null, {
    username: target.email, name: target.name, week: week.start, hours, notes,
    updated: stamp_(), 'updated by': me.email, excused: '', // logging hours replaces an excuse
  });
  deleteRows_(t, rows.slice(1)); // drop duplicates for the same week
}

// Admins: mark a student as excused from a week (no hours expected), with an optional reason.
function excuseEntry_(me, target, body) {
  const week = findWeek_(body.week_id);
  const reason = String(body.reason || '').trim().slice(0, 200);
  const t = table_(HOURS_SHEET, HOURS_HEADERS);
  const rows = userWeekRows_(t, target.email, week);
  writeRow_(t, rows[0] || null, {
    username: target.email, name: target.name, week: week.start, hours: '', notes: reason,
    updated: stamp_(), 'updated by': me.email, excused: 'yes',
  });
  deleteRows_(t, rows.slice(1));
}

function deleteEntry_(me, target, body) {
  const week = findWeek_(body.week_id);
  if (!me.is_admin && isClosed_(week)) fail_(closedMessage_(week));
  const t = table_(HOURS_SHEET, HOURS_HEADERS);
  deleteRows_(t, userWeekRows_(t, target.email, week));
}

// ---------- admin views ----------

// Everyone on a roster, with their hours. Students are the people in a section;
// admins who aren't in a section are included too, so the class list can show them.
function overview_() {
  const weeks = listWeeks_();
  // Descriptions are included so the admin page can open a student's weeks without another request.
  const hours = hoursByUser_(weeks);
  const names = {};
  const logins = {};
  table_(USERS_SHEET, USERS_HEADERS).rows.forEach(r => {
    const email = String(r.email).toLowerCase();
    names[email] = String(r.name || '');
    logins[email] = loginMs_(r['last login']);
  });
  const admins = rosterEmails_(ADMINS_SHEET);
  const people = {};
  const person = email => (people[email] = people[email] || { email, section: '', is_admin: false });
  SECTIONS.forEach(s => rosterEmails_(s).forEach(email => { if (!person(email).section) person(email).section = s; }));
  admins.forEach(email => { person(email).is_admin = true; });
  const students = Object.keys(people).map(email => {
    const per = {};
    let total = 0;
    Object.keys(hours[email] || {}).forEach(id => {
      per[id] = hours[email][id].hours;
      total += hours[email][id].hours;
    });
    return Object.assign(people[email], {
      name: names[email] || email,
      signed_in: email in names,
      last_login: logins[email] || null, // ms since 1970, or null if not recorded yet
      hours: per,
      entries: hours[email] || {},
      total: Math.round(total * 100) / 100,
    });
  });
  return { weeks, students, sections: SECTIONS, settings: settings_() };
}

function userEntries_(email) {
  email = cleanEmail_(email);
  const access = access_(email);
  if (!access.is_admin && !access.section) fail_('User not found');
  const row = table_(USERS_SHEET, USERS_HEADERS).rows.find(r => String(r.email).toLowerCase() === email);
  const weeks = listWeeks_();
  return {
    user: { email, name: String((row && row.name) || email), is_admin: access.is_admin, section: access.section, signed_in: !!row, last_login: row ? loginMs_(row['last login']) : null },
    weeks,
    entries: entriesFor_(email, weeks),
  };
}

// ---------- sheet helpers ----------

// Reads a tab (creating it with headers if missing) into { sh, cols, width, rows }.
// Each row is { _row, _raw, <lowercase header>: value }.
function table_(name, headers) {
  return memo_('table:' + name, () => readTable_(name, headers));
}

function readTable_(name, headers) {
  let sh = sheetNamed_(name);
  if (!sh) {
    lock_();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name, ss.getNumSheets());
      sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@'); // keep dates as plain text
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    changed_();
  }
  const values = sh.getDataRange().getValues(); // one read for the whole tab
  const width = Math.max(values[0].length, headers.length);
  values.forEach(r => { while (r.length < width) r.push(''); });
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const cols = {};
  const missing = headers.filter(h => header.indexOf(h.toLowerCase()) === -1);
  const ownTab = OWN_TABS.some(t => t.toLowerCase() === String(name).toLowerCase());
  if (missing.length && (ownTab || missing.every(h => OPTIONAL_HEADERS.indexOf(h) !== -1))) {
    // A newer version of the app added a column: add its header after the last used one.
    lock_();
    let used = header.length;
    while (used > 0 && header[used - 1] === '') used--;
    sh.getRange(1, used + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    changed_();
    return readTable_(name, headers);
  }
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
// Appends several rows in one write.
function appendRows_(t, list) {
  if (!list.length) return;
  const lines = list.map(fields => {
    const line = new Array(t.width).fill('');
    Object.keys(fields).forEach(k => { line[t.cols[k]] = safe_(fields[k]); });
    return line;
  });
  t.sh.getRange(t.sh.getLastRow() + 1, 1, lines.length, t.width).setValues(lines);
  changed_();
}

function writeRow_(t, row, fields) {
  const existing = row ? t.rows.find(r => r._row === row) : null;
  const line = existing ? existing._raw.slice() : new Array(t.width).fill('');
  Object.keys(fields).forEach(k => { line[t.cols[k]] = safe_(fields[k]); });
  t.sh.getRange(row || t.sh.getLastRow() + 1, 1, 1, t.width).setValues([line]);
  changed_();
}

// Text starting with = + - @ would be run as a formula; a leading ' keeps it as text.
function safe_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function deleteRows_(t, rows) {
  if (!rows.length) return;
  rows.slice().sort((a, b) => b - a).forEach(r => t.sh.deleteRow(r));
  changed_();
}

// ---------- misc ----------

// Stops the request with a message meant for the person using the site. Any other error
// is replaced by a generic message before it reaches the browser (see doPost).
function fail_(message) {
  const err = new Error(message);
  err.forUser = true;
  throw err;
}

function tz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
}

function today_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

// A "Last login" cell as ms since 1970, or null. Written as "yyyy-MM-dd HH:mm" text.
function loginMs_(v) {
  if (v === '' || v == null) return null;
  if (Object.prototype.toString.call(v) === '[object Date]' || typeof v.getTime === 'function') return v.getTime();
  const s = String(v).trim();
  for (const pattern of ['yyyy-MM-dd HH:mm', 'yyyy-MM-dd']) {
    try {
      const d = Utilities.parseDate(s, tz_(), pattern);
      if (d && !isNaN(d.getTime())) return d.getTime();
    } catch (e) { /* try the next pattern */ }
  }
  return null;
}

// Dates typed into the sheet by hand come in many shapes; turn the common ones into
// yyyy-mm-dd so they compare correctly as text ("2026-10-4" would sort after "2026-10-25").
function toIso_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' || (v && typeof v.getTime === 'function')) {
    return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  }
  const s = String(v == null ? '' : v).trim();
  const pad = n => String(n).padStart(2, '0');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // US month/day/year
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return s;
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
