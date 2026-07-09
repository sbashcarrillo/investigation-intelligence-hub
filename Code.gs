/* =========================================================================
   FPI Intelligence Hub — Google Apps Script backend (Code.gs)
   =========================================================================
   Serves the app via HtmlService and reads/writes the Google Sheet.

   ┌─────────────────────────────────────────────────────────────────────┐
   │ ONLY ONE THING TO DO IN THIS FILE:                                  │
   │  ① Paste your Google Sheet ID into CONFIG.SHEET_ID below.          │
   │ Tab names live in CONFIG if yours differ. Then deploy as a Web App  │
   │ (see README → "Deploying").                                         │
   └─────────────────────────────────────────────────────────────────────┘

   GOOGLE SHEET STRUCTURE (v1 data architecture)
   ─────────────────────────────────────────────
   Tabs: Queries | Repositories | Categories | User Favorites |
         Change Log | Admin Settings

   Queries — THE master table. One query per row. Header row 1:
     Query ID | Repository | Status | Version | Category | Query Name |
     Description | Link | Last Updated | Remarks | Inputs | Returns |
     Data Sources | Tags | SQL | Use Cases | Updated By
   Optional audit columns (stamped automatically when present):
     Created By | Created Date  — set once by createQuery()
     Approved By | Approved Date — set by saveQuery() whenever Status
     moves INTO Production from any non-Production status (that Status
     change is logged with Action = Approved)

     • Repository determines which repo page the query appears on
       (ORG / LE / SUB / any future code — must match a Repositories row).
     • Status controls visibility: only rows where Status = "Production"
       are served to users. Anything else (Draft, Review, Deprecated, …)
       is invisible to the app.
     • Version is the CURRENT version of the query — the Queries sheet is
       the source of truth. Initialize new rows to 1.0; saveQuery() bumps
       it (1.0 → 1.1 → …) on every save that changed at least one field.
       A blank cell reads as 1.0.
     • Multi-value cells (Inputs, Returns, Data Sources, Tags, Use Cases):
       one item per line inside the cell (Alt+Enter / Ctrl+Enter), or
       separate items with semicolons. Both work.

   Repositories — one row per repository card on the landing page:
     Repository | Name | Full Name | Description | Accent Color | Sort Order
     (Accent Color = hex like #60a5fa. Sort Order controls card order.)

   Categories — controls filter pill order and icon/list colors:
     Repository | Category | Color | Sort Order
     (If a repo has no rows here, categories are derived from its
     production queries and given default colors automatically.)

   User Favorites — written by toggleFavorite(), one row per favorite:
     User Email | Repository | Query ID | Favorited Date

   Change Log — the APPEND-ONLY audit trail. saveQuery() appends one row
   per changed field on every in-app edit; humans read it, the app never
   does (the current version lives in the Queries sheet, not here).
   Created automatically with these columns if missing:
     Timestamp | Query ID | User | Action | Field | Old Value | New Value | Version
   (Version in a log row = the Queries-sheet version that save produced;
   all rows from one save share it.)

   Admin Settings — who may use the Create/Edit drawer:
     Email | Name | Role | Active
     Role is "Admin" or "User"; only Role = Admin AND Active = TRUE rows
     grant editing (matching is case-insensitive and trims spaces). If the
     tab is missing entirely, CONFIG.ADMIN_EMAILS below is the emergency
     fallback.

   COLUMN LOOKUP IS DYNAMIC
   ────────────────────────
   No column numbers are hardcoded anywhere in this file. Each tab's
   header row (row 1) is read at runtime and columns are located by
   header NAME (case-insensitive, extra spaces ignored, a few synonyms
   accepted — see the *_HEADERS specs below). You can add, remove, or
   reorder columns freely; unknown columns are simply ignored.
   ========================================================================= */

var CONFIG = {
  SHEET_ID: '1KSACu2FctRL9TnbTYjApSKFHiQ0jP0oBwXxQ--y5hxU',   // ← ① the ID from your sheet's URL

  QUERIES_TAB: 'Queries',
  REPOSITORIES_TAB: 'Repositories',
  CATEGORIES_TAB: 'Categories',
  FAVORITES_TAB: 'User Favorites',
  CHANGE_LOG_TAB: 'Change Log',           // audit trail — appended to by saveQuery()/createQuery(), never read by the catalog
  ADMIN_SETTINGS_TAB: 'Admin Settings',   // who may edit: Email | Name | Role | Active

  // EMERGENCY FALLBACK ONLY: used when the Admin Settings tab does not
  // exist. Normal admin management is rows in the Admin Settings tab
  // (Role = Admin, Active = TRUE) — no code changes, no redeploys.
  // Enforced SERVER-SIDE — hiding buttons in the UI is not the gate.
  ADMIN_EMAILS: [],

  // Only queries with this Status value are served (compared
  // case-insensitively). Rows with any other status — or a blank one —
  // never leave the server.
  PRODUCTION_STATUS: 'Production',

  // Catalog reads are cached so every click doesn't hit the Sheet.
  // After editing the Sheet, changes appear within this window.
  CACHE_SECONDS: 300
};

/* =========================================================================
   HEADER SPECS — model key → accepted header names, first name canonical.
   Matching is case-insensitive and whitespace-tolerant, so "query id",
   "Query ID " and "QUERY_ID" all resolve to queryId. Add a synonym here
   if you rename a column in the Sheet and want the old code to keep
   working — never add column numbers.
   ========================================================================= */

var QUERY_HEADERS = {
  queryId:      ['Query ID', 'ID'],
  repository:   ['Repository', 'Repo'],
  status:       ['Status'],
  version:      ['Version'],
  createdBy:    ['Created By'],
  createdDate:  ['Created Date'],
  approvedBy:   ['Approved By'],
  approvedDate: ['Approved Date'],
  category:    ['Category'],
  name:        ['Query Name', 'Name', 'Title'],
  description: ['Description'],
  link:        ['Link', 'URL'],
  lastUpdated: ['Last Updated', 'Last Modified'],
  remarks:     ['Remarks', 'Notes'],
  inputs:      ['Inputs'],
  returns:     ['Returns', 'Outputs'],
  dataSources: ['Data Sources'],
  tags:        ['Tags'],
  sql:         ['SQL'],
  useCases:    ['Use Cases'],
  updatedBy:   ['Updated By']
};

var REPOSITORY_HEADERS = {
  code:        ['Repository', 'Repository Code', 'Repo', 'Code'],
  name:        ['Name', 'Repository Name'],
  fullName:    ['Full Name'],
  description: ['Description'],
  accent:      ['Accent Color', 'Accent', 'Color'],
  sortOrder:   ['Sort Order', 'Order']
};

var CATEGORY_HEADERS = {
  repository:  ['Repository', 'Repo'],
  name:        ['Category', 'Category Name', 'Name'],
  color:       ['Color', 'Accent Color', 'Accent'],
  sortOrder:   ['Sort Order', 'Order']
};

var FAVORITE_HEADERS = {
  email:       ['User Email', 'Email'],
  repository:  ['Repository', 'Repo'],
  queryId:     ['Query ID', 'ID'],
  date:        ['Favorited Date', 'Date']
};

var ADMIN_SETTINGS_HEADERS = {
  email:  ['Email', 'User Email'],
  name:   ['Name'],
  role:   ['Role'],
  active: ['Active']
};

var CHANGE_LOG_HEADERS = {
  timestamp:   ['Timestamp', 'Date'],
  queryId:     ['Query ID'],
  user:        ['User', 'Changed By'],
  action:      ['Action'],
  field:       ['Field', 'Field Changed'],
  oldValue:    ['Old Value'],
  newValue:    ['New Value'],
  version:     ['Version']
};

/* Query fields the Edit drawer may change. Query ID and Repository are
   identity — never editable (favorites, recents, and deep links key on
   Query ID). Last Updated / Updated By / Version are managed automatically
   on save — Version lives in the Queries sheet (source of truth) and is
   never user-edited. */
var EDITABLE_KEYS = ['name', 'description', 'category', 'status', 'link',
                     'remarks', 'inputs', 'returns', 'dataSources', 'tags',
                     'sql', 'useCases'];

/* Query columns split into arrays (one item per line, or semicolons). */
var LIST_KEYS = ['inputs', 'returns', 'dataSources', 'tags', 'useCases'];

var DEFAULT_ACCENT_PALETTE = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#22d3ee'];
var DEFAULT_CATEGORY_PALETTE = ['#a78bfa', '#60a5fa', '#22d3ee', '#fbbf24', '#fb7185', '#34d399'];

/* =========================== Web app entry =========================== */

/** Serves the app. The 'index' HTML template inlines the CSS/JS partials
    (css-styles / js-config / js-data-adapter / js-app) via include()
    because HtmlService cannot serve static assets from relative paths. */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('FPI Intelligence Hub')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Template helper — inlines another Apps Script HTML file's raw content. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* =========================== Server API ===========================
   These functions are the entire contract with the client (called from
   js-data-adapter via google.script.run): the original seven read/favorite
   functions plus saveQuery(), the single write path for query edits.     */

/** Repo metadata + counts + categories. Called once at app boot.
    Cards come from the Repositories tab; counts from production queries. */
function getRepositorySummary() {
  var catalog = getCatalog_();
  return catalog.repos.map(function (r) {
    var queries = queriesForRepo_(catalog, r.code);
    return {
      code: r.code,
      name: r.name,
      fullName: r.fullName,
      description: r.description,
      accent: r.accent,
      queryCount: queries.length,
      categories: categoriesFor_(catalog, r.code, queries)
    };
  });
}

/** All production queries for one repository. Called once per repo at boot. */
function getQueriesByRepo(repoName) {
  var catalog = getCatalog_();
  assertRepo_(catalog, repoName);
  return queriesForRepo_(catalog, repoName);
}

/** One query by ID (not used by the current UI — it keeps the full catalog
    in memory — but available for deep-link or lazy-load setups). */
function getQueryDetail(repoName, queryId) {
  var catalog = getCatalog_();
  assertRepo_(catalog, repoName);
  var rows = queriesForRepo_(catalog, repoName);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].queryId === queryId) return rows[i];
  }
  return null;
}

/** Server-side search across all production queries (same ranking as the
    client). Not used by the current UI (client searches its in-memory
    catalog), but ready if the catalog outgrows shipping to the browser. */
function searchQueries(term) {
  var t = String(term || '').trim().toLowerCase();
  if (!t) return [];
  var results = [];
  getCatalog_().queries.forEach(function (q) {
    var name = String(q.name || '').toLowerCase();
    var hay = [q.name, q.description, q.category, q.remarks, q.queryId,
               (q.useCases || []).join(' '), (q.tags || []).join(' ')].join(' ').toLowerCase();
    var score = -1;
    if (name.indexOf(t) === 0) score = 0;
    else if (name.indexOf(t) >= 0) score = 1;
    else if (String(q.description || '').toLowerCase().indexOf(t) >= 0) score = 2;
    else if (hay.indexOf(t) >= 0) score = 3;
    if (score >= 0) results.push({ repository: q.repository, score: score, query: q });
  });
  results.sort(function (a, b) { return a.score - b.score; });
  return results.slice(0, 25);
}

/** The signed-in user's Google email + admin flag. Works for users in your
    Workspace domain when the web app is deployed with domain access. */
function getCurrentUser() {
  var email = Session.getActiveUser().getEmail() || '';
  return { email: email, isAdmin: isAdmin_(email) };
}

/**
 * THE single write path for query edits (the Edit drawer) — replaces
 * editing the Google Sheet directly.
 *
 * saveQuery(queryId, edits) where edits = { name?, description?, category?,
 * status?, link?, remarks?, inputs?, returns?, dataSources?, tags?, sql?,
 * useCases? } — all plain strings; multi-value fields keep their
 * one-item-per-line convention.
 *
 * On save it: diffs the edits against the current sheet row, writes only
 * the changed cells, stamps Last Updated / Updated By, bumps the Version
 * column in the Queries row (1.0 → 1.1 → 1.2 …; the Queries sheet is the
 * source of truth for the current version), and appends ONE Change Log
 * row PER changed field (Timestamp, Query ID, User, Action, Field,
 * Old Value, New Value, Version) — every row from one save carries the
 * same new version. No changes → no version bump, no log rows.
 *
 * Returns { saved, version, changedFields, query } — query is the updated
 * row in the same shape the catalog serves, so the client can refresh its
 * in-memory copy without a full reload.
 */
function saveQuery(queryId, edits) {
  var email = Session.getActiveUser().getEmail() || '';
  if (!isAdmin_(email)) {
    throw new Error('Not authorized: editing queries requires an administrator account.');
  }
  if (!queryId || !edits) throw new Error('saveQuery needs a query ID and an edits object.');

  var lock = LockService.getScriptLock();   // one writer at a time
  lock.waitLock(10000);
  try {
    var sheet = spreadsheet_().getSheetByName(CONFIG.QUERIES_TAB);
    if (!sheet) throw new Error('Sheet tab not found: "' + CONFIG.QUERIES_TAB + '"');
    var values = sheet.getDataRange().getDisplayValues();
    var map = headerMap_(values[0], QUERY_HEADERS);
    if (map.queryId === undefined) throw new Error('"' + CONFIG.QUERIES_TAB + '" tab has no "Query ID" header.');

    var rowIndex = -1;                       // 0-based index into values
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][map.queryId]).trim() === String(queryId).trim()) { rowIndex = i; break; }
    }
    if (rowIndex < 0) throw new Error('Query not found: ' + queryId);

    /* Diff: only editable keys, only columns that exist in the sheet.
       List fields are compared canonically (split on newlines/semicolons,
       trimmed) so "a;b" vs "a\nb" — the same list — is not a change. */
    var changes = [];
    EDITABLE_KEYS.forEach(function (key) {
      if (!(key in edits) || map[key] === undefined) return;
      var oldValue = String(values[rowIndex][map[key]] || '').trim();
      var newValue = String(edits[key] === null || edits[key] === undefined ? '' : edits[key]).trim();
      var isList = LIST_KEYS.indexOf(key) >= 0;
      var same = isList
        ? splitList_(oldValue).join('\n') === splitList_(newValue).join('\n')
        : oldValue === newValue;
      if (!same) {
        changes.push({ key: key, header: QUERY_HEADERS[key][0], oldValue: oldValue, newValue: newValue });
      }
    });

    /* Current version comes from the Queries row itself — the sheet is the
       source of truth; the Change Log is append-only and never scanned. */
    var currentVersion = normalizeVersion_(map.version === undefined ? '' : values[rowIndex][map.version]);

    if (!changes.length) {
      return { saved: false, version: currentVersion, changedFields: [], query: rowObject_(values, map, rowIndex) };
    }

    /* Approval detection: Status moving INTO Production from any
       non-Production status. That one change is logged as Action =
       Approved (other fields in the same save stay Action = Update)
       and stamps Approved By / Approved Date. */
    var production = CONFIG.PRODUCTION_STATUS.toLowerCase();
    var isApproval = false;
    changes.forEach(function (c) {
      if (c.key === 'status' &&
          c.newValue.toLowerCase() === production &&
          c.oldValue.toLowerCase() !== production) {
        c.action = 'Approved';
        isApproval = true;
      }
    });

    var version = bumpVersion_(currentVersion);
    var sheetRow = rowIndex + 1;             // sheet rows are 1-based
    var auditEmail = auditUser_();
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

    /* Writes a cell (if its column exists) and keeps the local row copy in
       sync so the returned query object reflects everything written. */
    var write = function (key, val) {
      if (map[key] === undefined) return;
      sheet.getRange(sheetRow, map[key] + 1).setValue(val);
      values[rowIndex][map[key]] = val;
    };

    changes.forEach(function (c) { write(c.key, c.newValue); });
    write('version', version);

    /* Bookkeeping columns — updated automatically, not change-logged. */
    write('lastUpdated', today);
    write('updatedBy', auditEmail);
    if (isApproval) {
      write('approvedBy', auditEmail);
      write('approvedDate', today);
    }

    appendChangeLog_(queryId, auditEmail, 'Update', changes, version);

    /* Bust the catalog cache so every user sees the edit immediately. */
    try { CacheService.getScriptCache().remove(CATALOG_CACHE_KEY); } catch (e) { /* ignore */ }

    return {
      saved: true,
      version: version,
      changedFields: changes.map(function (c) { return c.header; }),
      query: rowObject_(values, map, rowIndex)
    };
  } finally {
    lock.releaseLock();
  }
}

/** Favorites for the current user, from the User Favorites tab. */
function getUserFavorites() {
  var email = Session.getActiveUser().getEmail() || '';
  if (!email) return [];
  var values = favoritesSheet_().getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  var map = headerMap_(values[0], FAVORITE_HEADERS);
  if (map.email === undefined || map.queryId === undefined) return [];
  var favorites = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i][map.email] === email) {
      favorites.push({
        repository: map.repository === undefined ? '' : values[i][map.repository],
        queryId: values[i][map.queryId]
      });
    }
  }
  return favorites;
}

/** Add or remove a favorite row for the current user.
    Returns { favorited: true|false } (the new state). */
function toggleFavorite(repoName, queryId) {
  var email = Session.getActiveUser().getEmail() || '';
  if (!email) throw new Error('Could not identify user — favorites need a signed-in Workspace account.');

  var lock = LockService.getScriptLock();   // avoid double-toggle races
  lock.waitLock(5000);
  try {
    var sheet = favoritesSheet_();
    var values = sheet.getDataRange().getDisplayValues();
    var map = headerMap_(values[0], FAVORITE_HEADERS);
    if (map.email === undefined || map.queryId === undefined) {
      throw new Error('User Favorites tab is missing a "User Email" or "Query ID" header.');
    }
    for (var i = 1; i < values.length; i++) {
      if (values[i][map.email] === email && values[i][map.queryId] === queryId) {
        sheet.deleteRow(i + 1);              // sheet rows are 1-based
        return { favorited: false };
      }
    }
    // Build the new row by header position so column order never matters.
    var row = [];
    for (var c = 0; c < values[0].length; c++) row.push('');
    row[map.email] = email;
    if (map.repository !== undefined) row[map.repository] = repoName;
    row[map.queryId] = queryId;
    if (map.date !== undefined) row[map.date] = new Date();
    sheet.appendRow(row);
    return { favorited: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Create a new query row — the write path for the drawer's Create mode
 * (separate from saveQuery, which only updates existing rows).
 *
 * createQuery(fields) where fields = { repository (required), name,
 * description, category, status?, link, remarks, inputs, returns,
 * dataSources, tags, sql, useCases } — plain strings, lists one item
 * per line.
 *
 * The server: validates the repository code, generates the next
 * sequential Query ID within that repository (ORG_0017 → ORG_0018),
 * defaults Status to Draft, initializes Version to 1.0, stamps
 * Last Updated / Updated By, appends the row, writes one Change Log
 * entry with Action = Created, and busts the catalog cache.
 *
 * Returns { created, queryId, version, status, query } — query in the
 * same shape the catalog serves.
 */
function createQuery(fields) {
  var email = Session.getActiveUser().getEmail() || '';
  if (!isAdmin_(email)) {
    throw new Error('Not authorized: creating queries requires an administrator account.');
  }
  if (!fields || !String(fields.repository || '').trim()) {
    throw new Error('createQuery needs a repository.');
  }

  var lock = LockService.getScriptLock();   // serialize ID generation
  lock.waitLock(10000);
  try {
    var sheet = spreadsheet_().getSheetByName(CONFIG.QUERIES_TAB);
    if (!sheet) throw new Error('Sheet tab not found: "' + CONFIG.QUERIES_TAB + '"');
    var values = sheet.getDataRange().getDisplayValues();
    var map = headerMap_(values[0], QUERY_HEADERS);
    if (map.queryId === undefined || map.repository === undefined) {
      throw new Error('"' + CONFIG.QUERIES_TAB + '" tab needs "Query ID" and "Repository" headers.');
    }

    var repoCode = String(fields.repository).trim().toUpperCase();
    assertRepoExists_(repoCode);

    /* Next sequential ID within the repository: max numeric suffix + 1. */
    var idPattern = new RegExp('^' + repoCode + '_(\\d+)$');
    var maxNum = 0;
    for (var i = 1; i < values.length; i++) {
      var m = String(values[i][map.queryId]).trim().match(idPattern);
      if (m && Number(m[1]) > maxNum) maxNum = Number(m[1]);
    }
    var num = String(maxNum + 1);
    while (num.length < 4) num = '0' + num;
    var queryId = repoCode + '_' + num;

    var status = String(fields.status || '').trim() || 'Draft';
    var auditEmail = auditUser_();
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

    /* Build the row by header position — column order never matters. */
    var row = [];
    for (var c = 0; c < values[0].length; c++) row.push('');
    var set = function (key, val) { if (map[key] !== undefined) row[map[key]] = val; };
    set('queryId', queryId);
    set('repository', repoCode);
    set('status', status);
    set('version', '1.0');
    set('createdBy', auditEmail);
    set('createdDate', today);
    set('lastUpdated', today);
    set('updatedBy', auditEmail);
    EDITABLE_KEYS.forEach(function (key) {
      if (key === 'status') return;   // handled above (Draft default)
      if (key in fields) set(key, String(fields[key] === null || fields[key] === undefined ? '' : fields[key]).trim());
    });
    sheet.appendRow(row);

    appendChangeLog_(queryId, auditEmail, 'Created',
      [{ header: '—', oldValue: '', newValue: String(fields.name || queryId).trim() }], '1.0');

    try { CacheService.getScriptCache().remove(CATALOG_CACHE_KEY); } catch (e) { /* ignore */ }

    values.push(row);
    return {
      created: true,
      queryId: queryId,
      version: '1.0',
      status: status,
      query: rowObject_(values, map, values.length - 1)
    };
  } finally {
    lock.releaseLock();
  }
}

/* =========================== Internals =========================== */

function spreadsheet_() {
  if (CONFIG.SHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') {
    throw new Error('Set CONFIG.SHEET_ID in Code.gs to your Google Sheet ID.');
  }
  return SpreadsheetApp.openById(CONFIG.SHEET_ID);
}

function assertRepo_(catalog, repoName) {
  var known = catalog.repos.some(function (r) { return r.code === repoName; });
  if (!known) throw new Error('Unknown repository: ' + repoName);
}

/* ---------- dynamic header mapping ---------- */

/** "  Query ID " / "query_id" / "QUERY ID" → "query id". */
function normalizeHeader_(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

/** Header row + spec → { modelKey: columnIndex } for every header found.
    Keys whose header is absent are simply missing from the map. */
function headerMap_(headerRow, spec) {
  var normalized = (headerRow || []).map(normalizeHeader_);
  var map = {};
  Object.keys(spec).forEach(function (key) {
    for (var a = 0; a < spec[key].length; a++) {
      var idx = normalized.indexOf(normalizeHeader_(spec[key][a]));
      if (idx >= 0) { map[key] = idx; return; }
    }
  });
  return map;
}

/** Read a whole tab into objects keyed by the spec's model keys.
    Returns { map, rows } or null if the tab doesn't exist. */
function readTab_(tabName, spec) {
  var sheet = spreadsheet_().getSheetByName(tabName);
  if (!sheet) return null;
  var values = sheet.getDataRange().getDisplayValues();
  if (!values.length) return { map: {}, rows: [] };
  var map = headerMap_(values[0], spec);
  var keys = Object.keys(map);
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    var hasData = false;
    for (var k = 0; k < keys.length; k++) {
      var raw = String(values[i][map[keys[k]]] || '').trim();
      if (raw) hasData = true;
      obj[keys[k]] = raw;
    }
    if (hasData) rows.push(obj);
  }
  return { map: map, rows: rows };
}

/* ---------- catalog (Queries + Repositories + Categories, cached) ---------- */

/** The full production catalog, read once per cache window:
    { repos: [{code,name,fullName,description,accent}],
      categoriesByRepo: {CODE: [{name,color,sort}]},
      queries: [normalized production query rows] }                       */
var CATALOG_CACHE_KEY = 'fpi.catalog.v2';

function getCatalog_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CATALOG_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  var queries = readProductionQueries_();
  var catalog = {
    repos: readRepositories_(queries),
    categoriesByRepo: readCategories_(),
    queries: queries
  };

  try { cache.put(CATALOG_CACHE_KEY, JSON.stringify(catalog), CONFIG.CACHE_SECONDS); } catch (e) { /* >100KB — skip cache */ }
  return catalog;
}

/** Master Queries tab → normalized rows, filtered to Status = Production.
    If the tab has no Status header at all, every row is served (so the
    app degrades gracefully rather than going blank). */
function readProductionQueries_() {
  var table = readTab_(CONFIG.QUERIES_TAB, QUERY_HEADERS);
  if (!table) throw new Error('Sheet tab not found: "' + CONFIG.QUERIES_TAB + '"');
  if (table.map.queryId === undefined) {
    throw new Error('"' + CONFIG.QUERIES_TAB + '" tab has no "Query ID" header in row 1.');
  }

  var hasStatus = table.map.status !== undefined;
  var production = CONFIG.PRODUCTION_STATUS.toLowerCase();
  var rows = [];

  table.rows.forEach(function (row) {
    if (!row.queryId) return;
    if (hasStatus && String(row.status || '').toLowerCase() !== production) return;
    row.repository = String(row.repository || '').toUpperCase();
    LIST_KEYS.forEach(function (key) { row[key] = splitList_(row[key]); });
    rows.push(row);
  });
  return rows;
}

/** Repositories tab → ordered repo card definitions. If the tab is missing
    or empty, repos are derived from the distinct Repository values in the
    production queries so the app still renders. */
function readRepositories_(queries) {
  var table = readTab_(CONFIG.REPOSITORIES_TAB, REPOSITORY_HEADERS);
  var defs = [];

  if (table && table.rows.length) {
    table.rows.forEach(function (row, i) {
      if (!row.code) return;
      var code = String(row.code).toUpperCase();
      defs.push({
        code: code,
        name: row.name || code,
        fullName: row.fullName || row.name || code,
        description: row.description || '',
        accent: row.accent || DEFAULT_ACCENT_PALETTE[i % DEFAULT_ACCENT_PALETTE.length],
        sort: row.sortOrder === '' || row.sortOrder === undefined ? 999 : Number(row.sortOrder) || 999
      });
    });
    defs.sort(function (a, b) { return a.sort - b.sort; });
  } else {
    var seen = [];
    queries.forEach(function (q) {
      if (q.repository && seen.indexOf(q.repository) < 0) seen.push(q.repository);
    });
    defs = seen.map(function (code, i) {
      return {
        code: code, name: code, fullName: code, description: '',
        accent: DEFAULT_ACCENT_PALETTE[i % DEFAULT_ACCENT_PALETTE.length], sort: i
      };
    });
  }

  return defs.map(function (d) {
    return { code: d.code, name: d.name, fullName: d.fullName, description: d.description, accent: d.accent };
  });
}

/** Categories tab → {REPO_CODE: [{name, color, sort}]}. */
function readCategories_() {
  var table = readTab_(CONFIG.CATEGORIES_TAB, CATEGORY_HEADERS);
  var byRepo = {};
  if (!table) return byRepo;
  table.rows.forEach(function (row) {
    if (!row.repository || !row.name) return;
    var code = String(row.repository).toUpperCase();
    if (!byRepo[code]) byRepo[code] = [];
    byRepo[code].push({
      name: row.name,
      color: row.color || DEFAULT_CATEGORY_PALETTE[byRepo[code].length % DEFAULT_CATEGORY_PALETTE.length],
      sort: row.sortOrder === '' || row.sortOrder === undefined ? 999 : Number(row.sortOrder) || 999
    });
  });
  Object.keys(byRepo).forEach(function (code) {
    byRepo[code].sort(function (a, b) { return a.sort - b.sort; });
  });
  return byRepo;
}

function queriesForRepo_(catalog, code) {
  return catalog.queries.filter(function (q) { return q.repository === code; });
}

/** Categories for a repo: from the Categories tab if rows exist there,
    otherwise derived from the repo's production queries with default colors. */
function categoriesFor_(catalog, code, queries) {
  var fromTab = catalog.categoriesByRepo[code];
  if (fromTab && fromTab.length) {
    return fromTab.map(function (c) { return { name: c.name, color: c.color }; });
  }
  var seen = [];
  queries.forEach(function (q) {
    if (q.category && seen.indexOf(q.category) < 0) seen.push(q.category);
  });
  return seen.map(function (name, i) {
    return { name: name, color: DEFAULT_CATEGORY_PALETTE[i % DEFAULT_CATEGORY_PALETTE.length] };
  });
}

/* ---------- editing / change log ---------- */

/** The email to write into audit stamps and Change Log rows. Apps Script
    can't always resolve the active user's email (consumer accounts,
    some cross-domain deployments) — never leave the audit trail blank. */
function auditUser_() {
  return Session.getActiveUser().getEmail() || 'Unknown User';
}

/** A repository code is valid if the Repositories tab lists it (or if the
    tab is missing/empty, in which case any non-blank code is accepted —
    same fallback the catalog uses). */
function assertRepoExists_(code) {
  var table = readTab_(CONFIG.REPOSITORIES_TAB, REPOSITORY_HEADERS);
  if (!table || !table.rows.length) return;
  var known = table.rows.some(function (r) {
    return String(r.code || '').trim().toUpperCase() === code;
  });
  if (!known) throw new Error('Unknown repository: ' + code);
}

/** True when the Admin Settings tab has a row for this email with
    Role = Admin and Active = TRUE (all matching case-insensitive,
    whitespace-trimmed). If the tab is MISSING, CONFIG.ADMIN_EMAILS is the
    emergency fallback; if the tab exists but a row/flag doesn't qualify,
    the answer is simply no — the fallback is never consulted. A missing
    Active column counts as active (so an Email|Role-only tab still works);
    a blank Active cell does not. */
function isAdmin_(email) {
  if (!email) return false;
  var normalized = String(email).trim().toLowerCase();

  var table = readTab_(CONFIG.ADMIN_SETTINGS_TAB, ADMIN_SETTINGS_HEADERS);
  if (table === null) {
    // Emergency fallback: tab missing entirely.
    return CONFIG.ADMIN_EMAILS.some(function (a) {
      return String(a).trim().toLowerCase() === normalized;
    });
  }
  if (table.map.email === undefined || table.map.role === undefined) return false;

  var hasActiveColumn = table.map.active !== undefined;
  return table.rows.some(function (row) {
    if (String(row.email || '').trim().toLowerCase() !== normalized) return false;
    if (String(row.role || '').trim().toLowerCase() !== 'admin') return false;
    return hasActiveColumn ? String(row.active || '').trim().toLowerCase() === 'true' : true;
  });
}

/** One query row (raw display values) → the object shape the catalog
    serves: camelCase keys, repository uppercased, list columns split. */
function rowObject_(values, map, rowIndex) {
  var row = {};
  Object.keys(map).forEach(function (key) {
    row[key] = String(values[rowIndex][map[key]] || '').trim();
  });
  row.repository = String(row.repository || '').toUpperCase();
  LIST_KEYS.forEach(function (key) { row[key] = splitList_(row[key]); });
  return row;
}

/** Version cell → canonical "major.minor" string. A new query starts at
    1.0, so a blank or unrecognized cell reads as "1.0"; a bare integer
    like "2" reads as "2.0". */
function normalizeVersion_(value) {
  var v = String(value === null || value === undefined ? '' : value).trim();
  if (/^\d+\.\d+$/.test(v)) return v;
  if (/^\d+$/.test(v)) return v + '.0';
  return '1.0';
}

/** "1.0" → "1.1", "1.9" → "1.10", "2.3" → "2.4". Minor bump on every
    save that changed at least one field. */
function bumpVersion_(current) {
  var parts = normalizeVersion_(current).split('.');
  return parts[0] + '.' + (Number(parts[1]) + 1);
}

/** Append one audit row per changed field, all stamped with the same
    version. A change may carry its own action (e.g. 'Approved' on a
    Status change into Production); defaultAction covers the rest.
    Columns are placed by header name; the tab is created with canonical
    headers if it doesn't exist yet. */
function appendChangeLog_(queryId, email, defaultAction, changes, version) {
  var sheet = changeLogSheet_();
  var headerRow = sheet.getDataRange().getDisplayValues()[0];
  var map = headerMap_(headerRow, CHANGE_LOG_HEADERS);
  var now = new Date();

  changes.forEach(function (c) {
    var row = [];
    for (var i = 0; i < headerRow.length; i++) row.push('');
    if (map.timestamp !== undefined) row[map.timestamp] = now;
    if (map.queryId !== undefined) row[map.queryId] = queryId;
    if (map.user !== undefined) row[map.user] = email;
    if (map.action !== undefined) row[map.action] = c.action || defaultAction;
    if (map.field !== undefined) row[map.field] = c.header;
    if (map.oldValue !== undefined) row[map.oldValue] = c.oldValue;
    if (map.newValue !== undefined) row[map.newValue] = c.newValue;
    if (map.version !== undefined) row[map.version] = version;
    sheet.appendRow(row);
  });
}

function changeLogSheet_() {
  var sheet = spreadsheet_().getSheetByName(CONFIG.CHANGE_LOG_TAB);
  if (!sheet) {
    sheet = spreadsheet_().insertSheet(CONFIG.CHANGE_LOG_TAB);
    sheet.appendRow(['Timestamp', 'Query ID', 'User', 'Action', 'Field', 'Old Value', 'New Value', 'Version']);
  }
  return sheet;
}

/* ---------- favorites ---------- */

function favoritesSheet_() {
  var sheet = spreadsheet_().getSheetByName(CONFIG.FAVORITES_TAB);
  if (!sheet) {
    // Create on first use so a missing tab never breaks the app.
    sheet = spreadsheet_().insertSheet(CONFIG.FAVORITES_TAB);
    sheet.appendRow(['User Email', 'Repository', 'Query ID', 'Favorited Date']);
  }
  return sheet;
}

/* ---------- misc ---------- */

/** Split a multi-value cell: one item per line, or semicolon-separated. */
function splitList_(value) {
  return String(value || '')
    .split(/\r?\n|;/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}
