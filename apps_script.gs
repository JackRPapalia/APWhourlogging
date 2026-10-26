/**
 * APW Hours Log — Google Sheets bridge.
 *
 * Paste this into the sheet's Extensions → Apps Script editor, set TOKEN below,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * See README.md for the full steps.
 *
 * The sheet's first row must contain the headers: Username, Name, Week, Hours, Notes
 * (any order). "Week" holds the week's start date.
 */

// Must match "sheet_token" in the app's config.json. Use a long random string.
const TOKEN = 'CHANGE-ME';

// Leave blank to use the first tab in the spreadsheet.
const SHEET_NAME = '';

const HEADERS = ['username', 'name', 'week', 'hours', 'notes'];

function doGet(e) {
  return handle_(() => {
    checkToken_(e.parameter.token);
    return { rows: readRows_() };
  });
}

function doPost(e) {
  return handle_(() => {
    const body = JSON.parse(e.postData.contents);
    checkToken_(body.token);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (body.action === 'upsert') return upsert_(body);
      if (body.action === 'delete') return remove_(body);
      throw new Error('Unknown action');
    } finally {
      lock.releaseLock();
    }
  });
}

function handle_(fn) {
  let result;
  try {
    result = fn();
  } catch (err) {
    result = { error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  if (TOKEN === 'CHANGE-ME') throw new Error('Set TOKEN in the Apps Script first');
  if (token !== TOKEN) throw new Error('Bad token');
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
  if (!sh) throw new Error('Sheet tab not found: ' + SHEET_NAME);
  return sh;
}

// Map of header name -> 0-based column index.
function columns_(sh) {
  const header = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]
    .map(h => String(h).trim().toLowerCase());
  const cols = {};
  HEADERS.forEach(h => {
    const i = header.indexOf(h);
    if (i === -1) throw new Error('Missing column header: ' + h);
    cols[h] = i;
  });
  return cols;
}

function isoDate_(value) {
  // Date cells from getValues() don't always pass `instanceof Date`, so check the tag instead.
  if (Object.prototype.toString.call(value) === '[object Date]' || (value && typeof value.getTime === 'function')) {
    return Utilities.formatDate(value, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  return String(value).trim();
}

function readRows_() {
  const sh = sheet_();
  const cols = columns_(sh);
  const values = sh.getDataRange().getValues().slice(1);
  return values
    .map(r => ({
      username: String(r[cols.username]).trim(),
      name: String(r[cols.name]),
      week: isoDate_(r[cols.week]),
      hours: Number(r[cols.hours]),
      notes: String(r[cols.notes]),
    }))
    .filter(r => r.username);
}

// 1-based sheet row numbers for this user's rows whose Week date falls in [start, end].
function matchingRows_(sh, cols, body) {
  const values = sh.getDataRange().getValues();
  const user = String(body.username).toLowerCase();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const wk = isoDate_(r[cols.week]);
    if (String(r[cols.username]).trim().toLowerCase() === user && wk >= body.start && wk <= body.end) rows.push(i + 1);
  }
  return rows;
}

function upsert_(body) {
  const sh = sheet_();
  const cols = columns_(sh);
  const width = Math.max(sh.getLastColumn(), HEADERS.length);
  const rows = matchingRows_(sh, cols, body);
  const target = rows.length ? rows[0] : sh.getLastRow() + 1;
  const line = rows.length ? sh.getRange(target, 1, 1, width).getValues()[0] : new Array(width).fill('');
  line[cols.username] = body.username;
  line[cols.name] = body.name;
  line[cols.week] = body.start;
  line[cols.hours] = Number(body.hours);
  line[cols.notes] = body.notes;
  sh.getRange(target, 1, 1, width).setValues([line]);
  rows.slice(1).reverse().forEach(r => sh.deleteRow(r)); // drop duplicates for the same week
  return { ok: true };
}

function remove_(body) {
  const sh = sheet_();
  const cols = columns_(sh);
  matchingRows_(sh, cols, body).reverse().forEach(r => sh.deleteRow(r));
  return { ok: true };
}
