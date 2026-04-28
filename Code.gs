/**
 * Family Calendar — Google Apps Script backend
 *
 * Setup:
 *  1. Create a new Google Sheet. Rename it e.g. "Family Calendar Data".
 *  2. Extensions → Apps Script. Paste this whole file in (replace Code.gs).
 *  3. Deploy → New deployment → Type: Web app
 *       Execute as: Me
 *       Who has access: Anyone
 *     Click Deploy. Copy the Web app URL.
 *  4. Paste that URL into the app's Settings tab → "Sync URL".
 *
 * The script auto-creates two sheets (Events, Bills) on first run with the right headers.
 * Don't rename the columns — the script reads them by header name.
 */

const EVENTS_SHEET = 'Events';
const BILLS_SHEET = 'Bills';
const REMINDERS_SHEET = 'Reminders'; // legacy, kept for migration

const EVENT_HEADERS = ['id', 'date', 'time', 'title', 'assignee', 'recurring', 'recur_until', 'exceptions', 'done', 'auto_roll', 'notes', 'created_at', 'updated_at'];
const BILL_HEADERS  = ['id', 'date', 'title', 'amount', 'assignee', 'recurring', 'recur_until', 'exceptions', 'paid', 'notes', 'created_at', 'updated_at'];
const REMINDER_HEADERS_LEGACY = ['id', 'date', 'time', 'title', 'assignee', 'recurring', 'auto_roll', 'done', 'notes', 'created_at', 'updated_at'];

/**
 * One-time helper: copies any rows from a legacy Reminders sheet into the Events sheet
 * as events with `done` set, then drops the Reminders sheet. Safe to run multiple times.
 * Run this manually from the Apps Script editor (Run → migrateReminders) once after deploying.
 */
function migrateReminders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const oldSh = ss.getSheetByName(REMINDERS_SHEET);
  if (!oldSh) return 'No Reminders sheet — nothing to migrate.';
  const last = oldSh.getLastRow();
  if (last < 2) {
    ss.deleteSheet(oldSh);
    return 'Empty Reminders sheet removed.';
  }
  const lastCol = oldSh.getLastColumn();
  const header = oldSh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const rows = oldSh.getRange(2, 1, last - 1, lastCol).getValues();
  const eventsSh = getSheet_(EVENTS_SHEET, EVENT_HEADERS);
  let moved = 0;
  rows.forEach(row => {
    if (!row[header.indexOf('id')]) return;
    const item = {};
    REMINDER_HEADERS_LEGACY.forEach(h => {
      const i = header.indexOf(h);
      if (i >= 0) item[h] = row[i];
    });
    if (item.date instanceof Date) item.date = Utilities.formatDate(item.date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    appendRowByHeaders_(eventsSh, item);
    moved++;
  });
  ss.deleteSheet(oldSh);
  return 'Migrated ' + moved + ' reminders into Events. Reminders sheet removed.';
}

// ---------- Web app entry points ----------

function doGet(e) {
  try {
    return jsonOut({
      ok: true,
      events: readSheet_(EVENTS_SHEET, EVENT_HEADERS),
      bills:  readSheet_(BILLS_SHEET, BILL_HEADERS),
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;
    let result;

    switch (action) {
      case 'add':    result = addRow_(body.kind, body.item); break;
      case 'update': result = updateRow_(body.kind, body.item); break;
      case 'delete': result = deleteRow_(body.kind, body.id); break;
      case 'bulk':   result = bulkApply_(body.changes); break;
      default: throw new Error('Unknown action: ' + action);
    }

    return jsonOut({
      ok: true,
      result: result,
      events: readSheet_(EVENTS_SHEET, EVENT_HEADERS),
      bills:  readSheet_(BILLS_SHEET, BILL_HEADERS),
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// ---------- Sheet helpers ----------

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  // Existing sheet: ensure all expected headers are present, append missing ones to the right.
  const existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  const missing = headers.filter(h => existing.indexOf(h) === -1);
  if (missing.length) {
    sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    sh.getRange(1, 1, 1, existing.length + missing.length).setFontWeight('bold');
  }
  return sh;
}

// Read by header name regardless of column order, so adding new columns is safe.
function readSheet_(name, headers) {
  const sh = getSheet_(name, headers);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const lastCol = sh.getLastColumn();
  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const values = sh.getRange(2, 1, last - 1, lastCol).getValues();
  return values
    .filter(row => row[headerRow.indexOf('id')]) // must have id
    .map(row => {
      const obj = {};
      headers.forEach(h => {
        const idx = headerRow.indexOf(h);
        let v = idx >= 0 ? row[idx] : '';
        if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
        obj[h] = v;
      });
      return obj;
    });
}

function findRowById_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const lastCol = sh.getLastColumn();
  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const idCol = headerRow.indexOf('id');
  if (idCol < 0) return -1;
  const ids = sh.getRange(2, idCol + 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

// Write a row by header name, so column order in the sheet doesn't matter.
function writeRow_(sh, rowIdx, item) {
  const lastCol = sh.getLastColumn();
  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const out = headerRow.map(h => (item[h] === undefined || item[h] === null) ? '' : item[h]);
  sh.getRange(rowIdx, 1, 1, lastCol).setValues([out]);
}
function appendRowByHeaders_(sh, item) {
  const lastCol = sh.getLastColumn();
  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const out = headerRow.map(h => (item[h] === undefined || item[h] === null) ? '' : item[h]);
  sh.appendRow(out);
}

function addRow_(kind, item) {
  const { sh, headers } = sheetFor_(kind);
  if (!item.id) item.id = Utilities.getUuid();
  const now = new Date().toISOString();
  if (!item.created_at) item.created_at = now;
  item.updated_at = now;
  appendRowByHeaders_(sh, item);
  return item;
}

function updateRow_(kind, item) {
  const { sh, headers } = sheetFor_(kind);
  const row = findRowById_(sh, item.id);
  if (row < 0) throw new Error('Not found: ' + item.id);
  item.updated_at = new Date().toISOString();
  if (!item.created_at) {
    const lastCol = sh.getLastColumn();
    const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    const ci = headerRow.indexOf('created_at');
    if (ci >= 0) {
      const existing = sh.getRange(row, ci + 1).getValue();
      item.created_at = existing || item.updated_at;
    } else {
      item.created_at = item.updated_at;
    }
  }
  writeRow_(sh, row, item);
  return item;
}

function deleteRow_(kind, id) {
  const { sh } = sheetFor_(kind);
  const row = findRowById_(sh, id);
  if (row < 0) return { id: id, deleted: false };
  sh.deleteRow(row);
  return { id: id, deleted: true };
}

function bulkApply_(changes) {
  const out = [];
  (changes || []).forEach(c => {
    if (c.action === 'add')    out.push(addRow_(c.kind, c.item));
    if (c.action === 'update') out.push(updateRow_(c.kind, c.item));
    if (c.action === 'delete') out.push(deleteRow_(c.kind, c.id));
  });
  return out;
}

function sheetFor_(kind) {
  if (kind === 'events')    return { sh: getSheet_(EVENTS_SHEET, EVENT_HEADERS), headers: EVENT_HEADERS };
  if (kind === 'bills')     return { sh: getSheet_(BILLS_SHEET,  BILL_HEADERS),  headers: BILL_HEADERS  };
  throw new Error('Unknown kind: ' + kind);
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
