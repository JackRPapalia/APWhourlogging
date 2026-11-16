// Tests for Code.gs. They run it against in-memory stand-ins for the Google services it
// uses (the spreadsheet, the signed-in user, the lock, the cache), so nothing real is touched.
//
// Run from the repo folder on a Mac (no installs needed):
//
//   osascript -l JavaScript tests/backend_test.js
//
// It prints PASS or FAIL per check and ends with "ALL PASSED" or the number that failed.
ObjC.import('Foundation');
const read = p => $.NSString.stringWithContentsOfFileEncodingError(p, 4, null).js;
const log = (...a) => console.log(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

// ---------- a clock the tests can set ----------
const RealDate = Date;
let NOW = 0;
Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const setNow = (y, m, d, h = 12) => { NOW = new RealDate(y, m - 1, d, h, 0).getTime(); };
const day = (y, m, d) => new RealDate(y, m - 1, d);

// ---------- stand-in spreadsheet ----------
// Cells hold values; a cell can also hold a formula ({ f: '=...', v: shownValue }), which
// getValues() reads as its value and any write replaces — like the real thing.
const calls = { tz: 0, format: 0, parse: 0, reads: 0, writes: 0 };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const shown = c => (c && typeof c === 'object' && 'f' in c ? c.v : c);
class Sheet {
  constructor(name, data) { this.name = name; this.data = data; this.text = false; }
  getName() { return this.name; }
  getLastRow() { let n = 0; this.data.forEach((r, i) => { if (r.some(v => v !== '' && v != null)) n = i + 1; }); return n; }
  getLastColumn() { let n = 0; this.data.forEach(r => r.forEach((v, j) => { if (v !== '' && v != null) n = Math.max(n, j + 1); })); return n; }
  getMaxRows() { return 1000; }
  setFrozenRows() {}
  deleteRow(r) { this.data.splice(r - 1, 1); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getRangeList(a1s) {
    const cells = a1s.map(a => { const m = /^([A-Z]+)(\d+)$/.exec(a); return [Number(m[2]), [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)]; });
    return { setValue: v => { calls.writes++; cells.forEach(([r, c]) => this.put(r, c, v)); } };
  }
  put(r, c, val) {
    while (this.data.length < r) this.data.push([]);
    if (typeof val === 'string' && val[0] === "'") val = val.slice(1); // a leading ' forces text
    else if (!this.text && typeof val === 'string' && ISO.test(val)) { const [y, m, d] = val.split('-').map(Number); val = day(y, m, d); }
    this.data[r - 1][c - 1] = val;
  }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      getValues() {
        calls.reads++;
        return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
          const v = shown((sh.data[r - 1 + i] || [])[c - 1 + j]);
          return v === undefined ? '' : v;
        }));
      },
      setValues(v) { calls.writes++; v.forEach((line, i) => line.forEach((val, j) => sh.put(r + i, c + j, val))); return this; },
      setValue(v) { return this.setValues([[v]]); },
      setNumberFormat(f) { if (f === '@') sh.text = true; return this; },
      setFontWeight() { return this; },
    };
  }
}
let sheets = [];
const ss = {
  getSheets: () => sheets,
  getSheetByName: n => sheets.find(s => s.name === n) || null,
  insertSheet: (n, i) => { const s = new Sheet(n, []); sheets.splice(i, 0, s); return s; },
  getNumSheets: () => sheets.length,
  getSpreadsheetTimeZone: () => { calls.tz++; return 'America/New_York'; },
};
const pad = n => String(n).padStart(2, '0');
let ACTIVE = '';
let cache = {};
Object.assign(this, {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  Session: { getActiveUser: () => ({ getEmail: () => ACTIVE }) },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
  Utilities: {
    formatDate: (d, tz, f) => { calls.format++; return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` + (f.includes('HH') ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''); },
    parseDate: (s, tz, f) => { calls.parse++; const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m || f !== 'yyyy-MM-dd') throw new Error('Unparseable'); return day(+m[1], +m[2], +m[3]); },
  },
  CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
});

const here = ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath);
(0, eval)(read(here + '/Code.gs'));

// ---------- helpers ----------
const T = 'teacher@trevor.org', A = 'alice@trevor.org', B = 'bob@trevor.org';
const call = (who, action, data = {}) => { ACTIVE = who; return JSON.parse(api({ ...data, action })); };
const HOURS = ['Username', 'Name', 'Week', 'Hours', 'Notes', 'Updated', 'Updated by', 'Excused', 'Late'];
// A class on Sunday–Saturday weeks: Week 1 Oct 4–10, Week 2 Oct 11–17, Week 3 Oct 18–24.
function fresh(weeks) {
  cache = {};
  const wk = new Sheet('Weeks', [['Id', 'Label', 'Start', 'End', 'Auto', 'No class'], ...(weeks || [
    ['1', 'Week 1', '2026-10-04', '2026-10-10', '0', ''],
    ['2', 'Week 2', '2026-10-11', '2026-10-17', '0', ''],
    ['3', 'Week 3', '2026-10-18', '2026-10-24', '0', '']])]);
  wk.text = true;
  const settings = new Sheet('Settings', [['Key', 'Value'], ['grace_days', 'none']]);
  settings.text = true;
  sheets = [
    new Sheet('Sheet1', [HOURS.slice()]),
    new Sheet('Admins', [[T]]),
    new Sheet('Section 1', [['Email'], [A], [B]]),
    new Sheet('Section 2', [['Email']]),
    wk, settings,
  ];
}
const hoursRows = () => sheets[0].data.slice(1);
const weekTab = () => sheets.find(s => s.name === 'Weeks').data.slice(1);
let fails = 0, passes = 0;
const check = (name, ok, detail) => { if (ok) passes++; else fails++; log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); };

// ---------- who gets in ----------
fresh(); setNow(2026, 10, 21);
check('someone not on the class list is turned away', /isn't on the class list/.test(call('stranger@trevor.org', 'me').error));
check('no Google account is turned away', /didn't say who you are/.test(call('', 'me').error));
check('a student gets their own page', call(A, 'me').user.section === 'Section 1' && call(A, 'me').user.is_admin === false);
check('a student cannot open the admin overview', call(A, 'overview').error === 'Admins only');
check('a student cannot change weeks', call(A, 'saveWeek', { start: '2026-12-01', end: '2026-12-07' }).error === 'Admins only');
check('a student cannot save hours for someone else', call(A, 'saveEntry', { email: B, week_id: 3, hours: 1, description: 'x' }).error === 'Admins only');
check('an empty Admins tab makes nobody an admin', (() => { sheets[1].data = [['Email']]; const r = call(A, 'me'); sheets[1].data = [[T]]; return r.user && r.user.is_admin === false; })());

// ---------- saving hours ----------
fresh(); setNow(2026, 10, 21);
let r = call(A, 'saveEntry', { week_id: 3, hours: 1.5, description: '=SUM(1,2)' });
check('hours are saved', r.entries[3] && r.entries[3].hours === 1.5, r);
check('formula-like notes are stored as plain text', hoursRows()[0][4] === '=SUM(1,2)' && typeof hoursRows()[0][4] === 'string');
r = call(A, 'saveEntry', { week_id: 3, hours: 2, description: 'updated' });
check('saving the same week again updates the one row', hoursRows().length === 1 && r.entries[3].hours === 2, hoursRows());
call(T, 'addWeeks', { weeks: [{ label: 'Later', start: '2026-12-06', end: '2026-12-12' }] });
check('a week that has not started is refused', /hasn't started/.test(call(A, 'saveEntry', { week_id: 4, hours: 1, description: 'x' }).error));

// ---------- E1: a week's hours follow it when its dates change ----------
fresh(); setNow(2026, 10, 21);
call(A, 'saveEntry', { week_id: 2, hours: 3, description: 'week two' });
call(A, 'saveEntry', { week_id: 3, hours: 1, description: 'week three' });
call(B, 'saveEntry', { week_id: 2, hours: 4, description: 'bob week two' });
r = call(T, 'saveWeek', { id: 2, label: 'Week 2', start: '2026-10-12', end: '2026-10-17' });
check('moving a week\'s start later is saved', !r.error, r.error);
const afterMove = call(A, 'me').entries;
check('...and its hours stay with it', afterMove[2] && afterMove[2].hours === 3 && call(B, 'me').entries[2].hours === 4, afterMove);
check('...and other weeks are untouched', afterMove[3] && afterMove[3].hours === 1, afterMove);
check('...and the rows carry the new start date', hoursRows().filter(x => x[2].getTime() === day(2026, 10, 12).getTime()).length === 2, hoursRows().map(x => x[2]));

// ---------- E2: the auto-created week follows the class's pattern ----------
fresh(); setNow(2026, 10, 26); // Monday; Week 3 ended Saturday Oct 24
let weeks = call(A, 'me').weeks;
let made = weeks[weeks.length - 1];
check('Sunday–Saturday weeks are followed by a Sunday–Saturday week', made.start === '2026-10-25' && made.end === '2026-10-31', made);
check('...labeled with the next number', made.label === 'Week 4', made.label);
check('...and no day is left out', weeks.some(w => w.start <= '2026-10-25' && '2026-10-25' <= w.end));
check('opening the page again does not add another week', call(A, 'me').weeks.length === 4);

fresh(); setNow(2026, 11, 10); // two full weeks went by with nobody opening the app
weeks = call(A, 'me').weeks; made = weeks[weeks.length - 1];
check('after a quiet spell the week still lines up, with no guessed number', made.start === '2026-11-08' && made.end === '2026-11-14' && made.label === '', made);

fresh([['1', 'week7', '2026-11-01', '2026-11-07', '0', '']]); setNow(2026, 11, 9);
made = call(A, 'me').weeks.slice(-1)[0];
check('a hand-typed "week7" is followed by "Week 8"', made.label === 'Week 8' && made.start === '2026-11-08', made);

fresh([['1', 'Week 1', '2026-10-05', '2026-10-09', '0', ''], ['2', 'Week 2', '2026-10-12', '2026-10-16', '0', '']]);
setNow(2026, 10, 17); // Saturday between Monday–Friday weeks
check('a weekend between Monday–Friday weeks adds no week', call(A, 'me').weeks.length === 2);
setNow(2026, 10, 19);
made = call(A, 'me').weeks.slice(-1)[0];
check('Monday–Friday weeks are followed by a Monday–Friday week', made.start === '2026-10-19' && made.end === '2026-10-23' && made.label === 'Week 3', made);

fresh([]); setNow(2026, 10, 21); // Wednesday, no weeks at all
made = call(A, 'me').weeks[0];
check('with no weeks yet, this Monday–Sunday is used', made.start === '2026-10-19' && made.end === '2026-10-25', made);

fresh([['1', 'Week 1', '2026-10-04', '2026-10-10', '0', ''], ['2', 'Later', '2026-10-15', '2026-10-21', '0', '']]);
setNow(2026, 10, 12);
made = call(A, 'me').weeks.find(w => w.start === '2026-10-11');
check('the new week stops before one the admin already set up', made && made.end === '2026-10-14', made);

// ---------- E5: "late" is decided when hours are first logged ----------
const withGrace = () => { fresh(); sheets.find(s => s.name === 'Settings').data[1][1] = '2'; };
withGrace(); setNow(2026, 10, 16); // Friday of Week 2
r = call(A, 'saveEntry', { week_id: 2, hours: 2, description: 'on time' });
check('hours logged during the week are not late', r.entries[2].late === false);
setNow(2026, 10, 18); // Sunday, inside the 2-day grace period
r = call(A, 'saveEntry', { week_id: 2, hours: 2, description: 'fixed a typo' });
check('fixing a typo during the grace period does not turn it late', r.entries[2].late === false, r.entries[2]);
r = call(B, 'saveEntry', { week_id: 2, hours: 1, description: 'first logged after the week' });
check('hours first logged after the week ended are late', r.entries[2].late === true, r.entries[2]);
r = call(B, 'saveEntry', { week_id: 2, hours: 1.5, description: 'edited again' });
check('...and stay late when edited', r.entries[2].late === true);
setNow(2026, 10, 30);
r = call(T, 'saveEntry', { email: A, week_id: 1, hours: 1, description: 'entered by the teacher' });
check('hours an admin enters for a student are never late', r.entries[1].late === false, r.entries[1]);
check('a closed week still refuses the student', /closed on/.test(call(A, 'saveEntry', { week_id: 1, hours: 2, description: 'x' }).error));
fresh(); setNow(2026, 10, 21);
sheets[0].data.push([A, 'Alice', day(2026, 10, 4), 2, 'old row', '2026-10-12 09:00', A, '', '']);
check('rows from before the Late column still use their update time', call(A, 'me').entries[1].late === true);
sheets[0].data[1][8] = 'no';
check('...and a teacher can overrule it in the sheet', call(A, 'me').entries[1].late === false);

// ---------- E6: columns the app doesn't own are left alone ----------
fresh(); setNow(2026, 10, 21);
sheets[0].data[0].push('Grade');
call(A, 'saveEntry', { week_id: 3, hours: 1, description: 'first' });
call(B, 'saveEntry', { week_id: 3, hours: 2, description: 'bob' });
sheets[0].data[1][9] = { f: '=D2*10', v: 10 };
sheets[0].data[2][9] = { f: '=D3*10', v: 20 };
call(A, 'saveEntry', { week_id: 3, hours: 3, description: 'second' });
check('a teacher\'s formula column survives a save', (sheets[0].data[1][9] || {}).f === '=D2*10' && (sheets[0].data[2][9] || {}).f === '=D3*10', sheets[0].data.slice(1).map(x => x[9]));
check('...and the save itself went through', call(A, 'me').entries[3].hours === 3);
call(T, 'excuseEntry', { email: B, week_id: 3, reason: 'sick' });
check('...and survives an excuse', (sheets[0].data[2][9] || {}).f === '=D3*10');

// ---------- E4: admins get a fresh overview with their own saves ----------
fresh(); setNow(2026, 10, 21);
sheets[2].data.push([T]); // the teacher is also in Section 1
r = call(T, 'saveEntry', { week_id: 3, hours: 2, description: 'my own hours' });
const mine = r.overview && r.overview.students.find(s => s.email === T);
check('an admin\'s own save comes back with an up-to-date overview', mine && mine.hours[3] === 2, r.overview && r.overview.students);
check('a student\'s save does not include the overview', call(A, 'saveEntry', { week_id: 3, hours: 1, description: 'x' }).overview === undefined);

// ---------- E7: the work per request doesn't grow with every row ----------
function load(students) {
  fresh(); setNow(2026, 10, 21);
  for (let i = 0; i < students; i++) {
    sheets[2].data.push([`s${i}@trevor.org`]);
    for (const [m, d] of [[10, 4], [10, 11], [10, 18]]) sheets[0].data.push([`s${i}@trevor.org`, `S ${i}`, day(2026, m, d), 2, 'notes', `2026-10-${pad(10 + (i % 10))} 09:${pad(i % 60)}`, `s${i}@trevor.org`, '', 'no']);
  }
  call(T, 'me', { withOverview: true }); // first sign-in writes a Users row
  Object.keys(calls).forEach(k => { calls[k] = 0; });
  const out = call(T, 'me', { withOverview: true });
  return { rows: students * 3, students: out.overview.students.length, services: calls.tz + calls.format + calls.parse, reads: calls.reads };
}
const small = load(28), big = load(336);
log('     admin page load:', small, 'and with a year of rows:', big);
check('a year of rows needs no more service calls than a month', big.services <= small.services + 5 && big.services < 40, [small, big]);
check('...and no more sheet reads', big.reads === small.reads && big.reads <= 8, [small, big]);
check('...and everyone is still in the overview', big.students === 339);

// ---------- the Class tab ----------
fresh(); setNow(2026, 10, 21);
call(A, 'saveEntry', { week_id: 2, hours: 3, description: 'built a parser' });
r = call(B, 'classmates');
const mates = JSON.stringify(r.students);
const aliceRow = r.students.find(s => s.entries[2]);
check('students can see what classmates logged', aliceRow && aliceRow.entries[2].hours === 3 && aliceRow.entries[2].description === 'built a parser', r.students);
check('...but not their emails or sign-in times', !mates.includes('@') && !mates.includes('last_login'), mates);
check('...and someone off the class list cannot', /isn't on the class list/.test(call('stranger@trevor.org', 'classmates').error));

log(fails ? `${fails} FAILED, ${passes} passed` : `ALL PASSED (${passes} checks)`);
