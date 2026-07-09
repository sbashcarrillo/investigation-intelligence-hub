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
   Tabs: Queries | Repositories | Categories | User Favorites | Change Log

   Queries — THE master table. One query per row. Header row 1:
     Query ID | Repository | Status | Category | Query Name | Description |
     Link | Last Updated | Remarks | Inputs | Returns | Data Sources |
     Tags | SQL | Use Cases | Updated By

     • Repository determines which repo page the query appears on
       (ORG / LE / SUB / any future code — must match a Repositories row).
     • Status controls visibility: only rows where Status = "Production"
       are served to users. Anything else (Draft, Review, Deprecated, …)
       is invisible to the app.
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

   Change Log — for HUMANS auditing the catalog; the app NEVER reads or
   writes it. Suggested columns:
     Date | Query ID | Field Changed | Changed By | Notes

   COLUMN LOOKUP IS DYNAMIC
   ────────────────────────
   No column numbers are hardcoded anywhere in this file. Each tab's
   header row (row 1) is read at runtime and columns are located by
   header NAME (case-insensitive, extra spaces ignored, a few synonyms
   accepted — see the *_HEADERS specs below). You can add, remove, or
   reorder columns freely; unknown columns are simply ignored.
   ========================================================================= */

var CONFIG = {
  SHEET_ID: 'PASTE_YOUR_SHEET_ID_HERE',   // ← ① the ID from your sheet's URL

  QUERIES_TAB: 'Queries',
  REPOSITORIES_TAB: 'Repositories',
  CATEGORIES_TAB: 'Categories',
  FAVORITES_TAB: 'User Favorites',
  CHANGE_LOG_TAB: 'Change Log',           // documented above; never touched by code

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
  queryId:     ['Query ID', 'ID'],
  repository:  ['Repository', 'Repo'],
  status:      ['Status'],
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
   These seven functions are the entire contract with the client
   (called from js-data-adapter via google.script.run). Their names,
   arguments, and return shapes are unchanged from the previous
   ORG/LE/SUB-tab backend — the client needs no changes.              */

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

/** The signed-in user's Google email. Works for users in your Workspace
    domain when the web app is deployed with domain access. */
function getCurrentUser() {
  return { email: Session.getActiveUser().getEmail() || '' };
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
function getCatalog_() {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'fpi.catalog.v2';
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var queries = readProductionQueries_();
  var catalog = {
    repos: readRepositories_(queries),
    categoriesByRepo: readCategories_(),
    queries: queries
  };

  try { cache.put(cacheKey, JSON.stringify(catalog), CONFIG.CACHE_SECONDS); } catch (e) { /* >100KB — skip cache */ }
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
