#!/usr/bin/env node
/**
 * enrich-cubes.js  — single script to fully enrich Cube.dev schema files.
 *
 * Works with ANY database schema — zero hardcoded names.
 *
 * ─── What it does (in order) ─────────────────────────────────────────────────
 *
 *  PHASE -1 — CUBE GENERATION  (requires DB_HOST + DB_NAME)
 *    Connects to the database, reads information_schema, and generates a
 *    cube .js file for every table that does not already have one.
 *    Skipped automatically when DB_HOST is not set.
 *
 *  PHASE 0 — STATIC PRE-FIXES  (no LLM — always safe)
 *    a. Add ${CUBE}. prefix to all bare column SQL expressions
 *    b. Add missing FK joins based on _id-suffix dimensions (product_id → products)
 *    c. Add missing FK joins based on shared primary-key columns across cubes
 *    d. Add boolean comparison dimension + sum measure for cubes that have a
 *       "planned vs actual" time-dimension pair (e.g. estimated vs delivered)
 *
 *  PHASE 1 — LLM ENRICHMENT  (requires LLM_API_KEY, skipped in --static-only)
 *    - Fix any remaining structural issues (primaryKey, data_source, joins)
 *    - Add title + description to every cube, measure, dimension
 *    - Add missing sum/avg measures for numeric dimensions
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/enrich-cubes.js                     # full run (static + LLM) — always saves catalog to DuckDB
 *   node scripts/enrich-cubes.js --static-only       # phase 0 only, no LLM — saves catalog to DuckDB
 *   node scripts/enrich-cubes.js --dry-run           # preview all changes, no writes, no catalog save
 *   node scripts/enrich-cubes.js --cube=orders       # single cube only (still saves full catalog)
 *
 * ─── Required env (LLM phase) ────────────────────────────────────────────────
 *
 *   LLM_API_KEY   — OpenAI / Anthropic API key
 *   LLM_MODEL     — model override (default: gpt-4o for openai, claude-sonnet-4-6 for anthropic)
 *   LLM_PROVIDER  — openai | anthropic  (default: openai)
 *
 * ─── Required env (cube generation phase) ────────────────────────────────────
 *
 *   DB_HOST    — database host
 *   DB_PORT    — database port (default: 5432)
 *   DB_NAME    — database name
 *   DB_USER    — database user
 *   DB_PASS    — database password
 *   DB_SCHEMA  — schema to introspect (default: public)
 *   DB_TYPE    — database type: postgres | mysql  (default: postgres)
 *   DB_SSL     — set to "true" to enable SSL
 */

const fs   = require("fs");
const path = require("path");
const axios = require("axios");

const LLM_API_KEY   = process.env.LLM_API_KEY;
const LLM_MODEL     = process.env.LLM_MODEL    || "gpt-4o";
const LLM_PROVIDER  = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const SCHEMA_DIR    = path.resolve(__dirname, "../cube/schema/cubes");
const DRY_RUN       = process.argv.includes("--dry-run");
const STATIC_ONLY   = process.argv.includes("--static-only");
const ONLY_CUBE     = (process.argv.find(a => a.startsWith("--cube=")) || "").split("=")[1];
const DELAY_MS      = Number(process.env.ENRICH_DELAY_MS || 1200);
const CATALOG_DB    = path.resolve(__dirname, "../data/cube-catalog.duckdb");

// Database connection (Phase -1 — cube generation)
const DB_HOST   = process.env.DB_HOST;
const DB_PORT   = parseInt(process.env.DB_PORT  || "5432");
const DB_NAME   = process.env.DB_NAME;
const DB_USER   = process.env.DB_USER;
const DB_PASS   = process.env.DB_PASS;
const DB_SCHEMA = process.env.DB_SCHEMA || "public";
const DB_TYPE   = (process.env.DB_TYPE   || "postgres").toLowerCase();
const DB_SSL    = process.env.DB_SSL === "true";

// ════════════════════════════════════════════════════════════════════════════
//  Enrich prompt — fetched from MongoDB at runtime (ENRICH_CONTEXT field).
//  Set it via:  POST /context  { "ENRICH_CONTEXT": "..." }
//  Placeholders: {{FILE_NAME}}  {{FILE_CONTENT}}  {{ISSUES_SECTION}}  {{ALL_CUBE_NAMES}}
// ════════════════════════════════════════════════════════════════════════════

// Populated by loadConfigFromMongo() at script start
let _enrichContext = null;

// ════════════════════════════════════════════════════════════════════════════
//  LLM providers
// ════════════════════════════════════════════════════════════════════════════

// PROVIDERS reads from process.env at call time so config loaded from
// MongoDB Atlas (loadConfigFromMongo) is picked up without restart.
const PROVIDERS = {
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    buildBody: (prompt) => ({
      model: process.env.LLM_MODEL || "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    }),
    headers: () => ({
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      "Content-Type": "application/json"
    }),
    extractText: (res) => res.data.choices[0].message.content
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    buildBody: (prompt) => ({
      model: process.env.LLM_MODEL || "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
    }),
    headers: () => ({
      "x-api-key": process.env.LLM_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    }),
    extractText: (res) => res.data.content[0].text
  }
};

async function callLLM(prompt) {
  const providerKey = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`Unknown LLM provider: ${providerKey}`);
  const response = await axios.post(
    provider.url,
    provider.buildBody(prompt),
    { headers: provider.headers(), timeout: 90000 }
  );
  return provider.extractText(response);
}

// ════════════════════════════════════════════════════════════════════════════
//  File helpers
// ════════════════════════════════════════════════════════════════════════════

function getAllCubeNames() {
  return fs.readdirSync(SCHEMA_DIR)
    .filter(f => f.endsWith(".js"))
    .map(f => path.basename(f, ".js"));
}

function extractCubeName(content) {
  const m = content.match(/cube\s*\(\s*[`'"](\w+)[`'"]/);
  return m ? m[1] : null;
}

function collectAllDimensions(allCubeNames) {
  const map = new Map();
  for (const name of allCubeNames) {
    const filePath = path.join(SCHEMA_DIR, `${name}.js`);
    if (!fs.existsSync(filePath)) continue;
    const src = fs.readFileSync(filePath, "utf8");
    const cols = new Set(
      [...src.matchAll(/^ {4,}(\w+)\s*:\s*\{/gm)].map(m => m[1])
    );
    map.set(name, cols);
  }
  return map;
}

// ════════════════════════════════════════════════════════════════════════════
//  Phase -1 — Generate cube files from database schema
// ════════════════════════════════════════════════════════════════════════════

/**
 * Map a SQL column data type to a Cube.dev dimension type.
 * Generic — works for PostgreSQL, MySQL, and most SQL dialects.
 */
function sqlTypeToCube(sqlType) {
  const t = (sqlType || "").toLowerCase();
  if (/int|numeric|decimal|real|float|double|money|serial/.test(t)) return "number";
  if (/timestamp|datetime|date\b|time\b/.test(t))                   return "time";
  if (/^bool/.test(t))                                               return "boolean";
  return "string";
}

/** snake_case → PascalCase  (for measure names: price → totalPrice) */
function toPascalCase(snake) {
  return snake.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/**
 * Generate the content of a cube .js file for a single database table.
 * Produces a minimal but valid Cube schema with:
 *   - count measure
 *   - sum + avg measures for every numeric non-PK column
 *   - all columns as typed dimensions
 *   - primaryKey: true on the detected PK column(s)
 */
function generateCubeContent(tableName, columns, primaryKeys, schema) {
  schema = schema || process.env.DB_SCHEMA || "public";
  const measureLines = [`    count: { type: \`count\` }`];

  // Auto-generate sum/avg for numeric non-PK columns
  for (const col of columns) {
    if (sqlTypeToCube(col.data_type) !== "number") continue;
    if (primaryKeys.has(col.column_name)) continue;
    const pascal = toPascalCase(col.column_name);
    measureLines.push(`    total${pascal}: { sql: \`\${CUBE}.${col.column_name}\`, type: \`sum\` }`);
    measureLines.push(`    avg${pascal}:   { sql: \`\${CUBE}.${col.column_name}\`, type: \`avg\` }`);
  }

  const dimLines = columns.map(col => {
    const cubeType = sqlTypeToCube(col.data_type);
    const parts    = [
      `sql: \`\${CUBE}.${col.column_name}\``,
      `type: \`${cubeType}\``
    ];
    if (primaryKeys.has(col.column_name)) parts.push("primaryKey: true");
    return `    ${col.column_name}: { ${parts.join(", ")} }`;
  });

  // If no natural PK was found, add a synthetic one using ROW_NUMBER
  const hasPk = columns.some(c => primaryKeys.has(c.column_name));
  if (!hasPk) {
    dimLines.unshift(`    rowKey: { sql: \`CAST(ROW_NUMBER() OVER() AS VARCHAR)\`, type: \`string\`, primaryKey: true }`);
  }

  return `cube(\`${tableName}\`, {
  sql_table: \`${DB_SCHEMA}.${tableName}\`,
  data_source: \`default\`,
  measures: {
${measureLines.join(",\n")}
  },
  dimensions: {
${dimLines.join(",\n")}
  }
});
`;
}

/**
 * Connect to the configured database, read information_schema, and create
 * a cube .js file for every table that does not already have one.
 * Returns the list of table names that were generated.
 */
async function generateMissingCubes() {
  // Read DB config fresh — may have been set by loadConfigFromMongo()
  const host   = process.env.DB_HOST;
  const port   = parseInt(process.env.DB_PORT || "5432");
  const dbName = process.env.DB_NAME;
  const user   = process.env.DB_USER;
  const pass   = process.env.DB_PASS;
  const schema = process.env.DB_SCHEMA || "public";
  const ssl    = process.env.DB_SSL === "true";

  if (!host || !dbName) return [];

  let client;
  try {
    const { Client } = require("pg");
    client = new Client({
      host:     host,
      port:     port,
      database: dbName,
      user:     user,
      password: pass,
      ssl:      ssl ? { rejectUnauthorized: false } : false
    });
    await client.connect();
  } catch (err) {
    console.warn(`  ⚠  Could not connect to database: ${err.message}`);
    console.warn("     Skipping cube generation — set DB_HOST/DB_NAME to enable.\n");
    return [];
  }

  const generated = [];
  try {
    // All base tables in the target schema
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schema]
    );

    const existing = new Set(getAllCubeNames());

    for (const { table_name } of tables) {
      if (existing.has(table_name)) continue; // cube file already exists

      // Columns ordered by position
      const { rows: columns } = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table_name]
      );
      if (columns.length === 0) continue;

      // Primary key columns
      const { rows: pkRows } = await client.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema   = kcu.table_schema
         WHERE tc.table_schema = $1 AND tc.table_name = $2
           AND tc.constraint_type = 'PRIMARY KEY'`,
        [schema, table_name]
      );
      const primaryKeys = new Set(pkRows.map(r => r.column_name));

      const content  = generateCubeContent(table_name, columns, primaryKeys, schema);
      const filePath = path.join(SCHEMA_DIR, `${table_name}.js`);

      if (!DRY_RUN) {
        if (!fs.existsSync(SCHEMA_DIR)) fs.mkdirSync(SCHEMA_DIR, { recursive: true });
        fs.writeFileSync(filePath, content, "utf8");
      }

      generated.push(table_name);
      const pkLabel = pkRows.length ? pkRows.map(r => r.column_name).join(", ") : "synthetic rowKey";
      console.log(`  ${DRY_RUN ? "(dry) " : ""}Generated  ${table_name}.js  (${columns.length} cols, pk: ${pkLabel})`);
    }
  } finally {
    await client.end();
  }

  return generated;
}

// ════════════════════════════════════════════════════════════════════════════
//  Block manipulation (brace-counting — works for any nesting depth)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Find the closing `}` that matches the `{` at position `openIdx`.
 */
function findClosingBrace(content, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Insert `textToInsert` before the closing brace of a named block
 * (e.g. "joins", "dimensions", "measures").
 * Returns updated content string, or null if block not found.
 * Idempotent: if textToInsert already appears in the block, returns null.
 */
function insertIntoBlock(content, blockName, textToInsert) {
  const re = new RegExp(`\\b${blockName}\\s*:\\s*\\{`);
  const m  = content.match(re);
  if (!m) return null;

  const openIdx  = content.indexOf("{", m.index + m[0].length - 1);
  const closeIdx = findClosingBrace(content, openIdx);
  if (closeIdx === -1) return null;

  const blockBody  = content.substring(openIdx, closeIdx + 1);

  // Check each line of the insert for idempotency — skip if already in block
  const firstKeyMatch = textToInsert.match(/(\w+)\s*:/);
  if (firstKeyMatch && blockBody.includes(firstKeyMatch[1] + ":")) return null;

  const before     = content.substring(0, closeIdx);
  const after      = content.substring(closeIdx);
  const trimBefore = before.trimEnd();
  const needsComma = !trimBefore.endsWith(",") && !trimBefore.endsWith("{");

  return `${trimBefore}${needsComma ? "," : ""}\n${textToInsert}\n${after}`;
}

// ════════════════════════════════════════════════════════════════════════════
//  Phase 0a — ${CUBE}. prefix on bare SQL columns
// ════════════════════════════════════════════════════════════════════════════

function applyStaticFixes(content) {
  const fixes = [];

  const fixed = content.replace(
    /\bsql\s*:\s*`([^`]+)`/g,
    (match, expr) => {
      const trimmed = expr.trim();

      // Case 1: plain bare column identifier
      if (
        !trimmed.includes("${") &&
        !/[\s()'"=<>]/.test(trimmed) &&
        /^[a-z_][a-z0-9_]*$/.test(trimmed)
      ) {
        fixes.push(trimmed);
        return `sql: \`\${CUBE}.${trimmed}\``;
      }

      // Case 2: SQL function expression with bare column refs (CONCAT, CAST, …)
      if (!trimmed.includes("${CUBE}.") && /^[A-Z_]+\s*\(/i.test(trimmed)) {
        const patched = trimmed.replace(
          /(?<![.${'`])\b([a-z_][a-z0-9_]*)\b(?!\s*[:(])/g,
          (col) => {
            const SKIP = new Set(["null","true","false","and","or","not","in","is","as","over","by","asc","desc"]);
            if (SKIP.has(col.toLowerCase())) return col;
            return `\${CUBE}.${col}`;
          }
        );
        if (patched !== trimmed) {
          fixes.push(`${trimmed.split("(")[0]}(...)`);
          return `sql: \`${patched}\``;
        }
      }

      return match;
    }
  );

  return { fixed, fixes };
}

// ════════════════════════════════════════════════════════════════════════════
//  Phase 0b+c — missing FK joins
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build Map<cubeName, Set<pkColumnName>> by scanning each cube file for
 *   `    colName: { ... primaryKey: true ... }`
 * Uses line-level matching to avoid false-positives from container blocks.
 */
function buildPrimaryKeyMap(allCubeNames) {
  const pkMap = new Map();
  const CONTAINER = new Set(["measures", "dimensions", "joins", "segments"]);

  for (const name of allCubeNames) {
    const filePath = path.join(SCHEMA_DIR, `${name}.js`);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const pks     = new Set();

    for (const line of content.split("\n")) {
      // Only 4-space-indented lines = individual member entries (not block headers)
      if (!/^ {4}\w/.test(line)) continue;
      if (!/primaryKey\s*:\s*true/.test(line)) continue;
      const dimName = line.match(/^ +(\w+)\s*:/)?.[1];
      if (dimName && !CONTAINER.has(dimName)) pks.add(dimName);
    }

    if (pks.size > 0) pkMap.set(name, pks);
  }
  return pkMap;
}

/**
 * Returns the set of cube names already declared in the joins block.
 */
function getJoinedCubes(content, allCubeNames) {
  const joined = new Set();
  const jm = content.match(/\bjoins\s*:\s*\{/);
  if (!jm) return joined;
  const openIdx  = content.indexOf("{", jm.index + jm[0].length - 1);
  const closeIdx = findClosingBrace(content, openIdx);
  if (closeIdx === -1) return joined;
  const block = content.substring(openIdx, closeIdx);
  for (const c of allCubeNames) {
    if (new RegExp(`\\b${c}\\s*:`).test(block)) joined.add(c);
  }
  return joined;
}

/**
 * Detect and add missing FK joins to `content`.
 * Strategy 0b: _id-suffix dimensions → cube name lookup
 * Strategy 0c: shared primary-key column name across cubes
 * Idempotent: only adds joins that are not already present.
 */
function applyJoinFixes(cubeName, content, allCubeNames, pkMap) {
  const joinedCubes = getJoinedCubes(content, allCubeNames);
  const newJoins    = [];

  // 0b: _id suffix → resolve target cube name
  for (const [, dim] of content.matchAll(/\b(\w+_id)\s*:\s*\{/g)) {
    const base   = dim.replace(/_id$/, "");
    const target = allCubeNames.find(c => c === base) || allCubeNames.find(c => c === base + "s");
    if (!target || target === cubeName || joinedCubes.has(target)) continue;
    newJoins.push({ target, fk: dim });
    joinedCubes.add(target);
  }

  // 0c: shared primary-key column name
  for (const [otherCube, pks] of pkMap) {
    if (otherCube === cubeName || joinedCubes.has(otherCube)) continue;
    for (const pkCol of pks) {
      if (pkCol.endsWith("_id")) continue;  // handled by 0b
      if (pkCol.length <= 3)    continue;   // too short to be meaningful
      // This cube must have `pkCol` as a non-PK dimension
      const dimLine = content.split("\n").find(
        l => /^ {4}/.test(l) && new RegExp(`^ +${pkCol}\\s*:`).test(l)
      );
      if (!dimLine) continue;
      if (/primaryKey\s*:\s*true/.test(dimLine)) continue; // it IS this cube's own PK
      newJoins.push({ target: otherCube, fk: pkCol });
      joinedCubes.add(otherCube);
      break;
    }
  }

  if (newJoins.length === 0) return { content, added: [] };

  const joinLines = newJoins.map(j =>
    `    ${j.target}: { sql: \`\${CUBE}.${j.fk} = \${${j.target}}.${j.fk}\`, relationship: \`many_to_one\` }`
  ).join(",\n");

  let updated;
  if (/\bjoins\s*:\s*\{/.test(content)) {
    updated = insertIntoBlock(content, "joins", joinLines);
  } else {
    // No joins block — add one right after data_source line
    updated = content.replace(
      /(data_source\s*:\s*`[^`]*`,?\n)/,
      `$1  joins: {\n${joinLines}\n  },\n`
    );
    // Fallback: after sql_table line
    if (updated === content) {
      updated = content.replace(
        /(sql_table\s*:\s*`[^`]*`,?\n)/,
        `$1  joins: {\n${joinLines}\n  },\n`
      );
    }
  }

  return { content: updated || content, added: newJoins.map(j => j.target) };
}

// ════════════════════════════════════════════════════════════════════════════
//  Phase 0d — boolean comparison dims for planned-vs-actual time dim pairs
// ════════════════════════════════════════════════════════════════════════════

const PLANNED_KW = ["estimated","expected","planned","scheduled","due","target","promised","deadline"];
const ACTUAL_KW  = ["actual","delivered","completed","finished","received","done","closed","ended","arrived"];

function matchesKw(name, kws) {
  const lower = name.toLowerCase();
  return kws.some(k => lower.includes(k));
}

/**
 * Extract all time dimension names from a cube file.
 */
function extractTimeDims(content) {
  return content.split("\n")
    .filter(l => /^ {4}\w/.test(l) && /type\s*:\s*`time`/.test(l))
    .map(l => l.match(/^ +(\w+)\s*:/)?.[1])
    .filter(Boolean);
}

/**
 * Find unique planned-vs-actual pairs among time dimensions.
 * Deduplicates by (actKeyword, plnKeyword) so cubes with multiple "actual"
 * dimensions (e.g. carrier_date and customer_date both matching "delivered")
 * only produce ONE generated member per concept — using the LAST matching
 * dim in each group (typically the most final/user-facing state).
 */
function findTimeDimPairs(timeDims) {
  const actual  = timeDims.filter(d => matchesKw(d, ACTUAL_KW));
  const planned = timeDims.filter(d => matchesKw(d, PLANNED_KW));

  // Group actual dims by keyword — last one wins (most final state)
  const actualByKw = new Map();
  for (const act of actual) {
    const k = ACTUAL_KW.find(kw => act.toLowerCase().includes(kw)) || "actual";
    actualByKw.set(k, act);
  }

  const pairs = [];
  for (const pln of planned) {
    const plnKey = PLANNED_KW.find(kw => pln.toLowerCase().includes(kw)) || "planned";
    for (const [actKey, act] of actualByKw) {
      pairs.push({ actualDim: act, plannedDim: pln, baseName: `is_${actKey}_after_${plnKey}` });
    }
  }
  return pairs;
}

function toTitle(snake) {
  return snake.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Add boolean comparison dimension + sum measure for each planned-vs-actual
 * time dim pair in the cube.  Idempotent: skips pairs already present.
 */
function applyTimeDiffFixes(content) {
  const timeDims = extractTimeDims(content);
  if (timeDims.length < 2) return content;

  const pairs = findTimeDimPairs(timeDims);
  if (pairs.length === 0) return content;

  for (const { actualDim, plannedDim, baseName } of pairs) {
    if (content.includes(baseName)) continue; // already present — skip

    const measureName = baseName.replace(/^is_/, "") + "_count";

    const dimEntry =
      `    ${baseName}: {\n` +
      `      sql: \`CASE WHEN \${CUBE}.${actualDim} > \${CUBE}.${plannedDim} THEN 'true' ELSE 'false' END\`,\n` +
      `      type: \`string\`,\n` +
      `      title: \`${toTitle(baseName)}\`,\n` +
      `      description: \`Whether the actual event (${actualDim}) occurred after the planned date (${plannedDim}). Filter by 'true' to find late/overdue records.\`\n` +
      `    }`;

    const measureEntry =
      `    ${measureName}: {\n` +
      `      sql: \`CASE WHEN \${CUBE}.${actualDim} > \${CUBE}.${plannedDim} THEN 1 ELSE 0 END\`,\n` +
      `      type: \`sum\`,\n` +
      `      title: \`${toTitle(measureName)}\`,\n` +
      `      description: \`Count of records where the actual event (${actualDim}) occurred after the planned date (${plannedDim}).\`\n` +
      `    }`;

    const afterDim = insertIntoBlock(content, "dimensions", dimEntry);
    if (afterDim) content = afterDim;

    const afterMeasure = insertIntoBlock(content, "measures", measureEntry);
    if (afterMeasure) content = afterMeasure;
  }

  return content;
}

// ════════════════════════════════════════════════════════════════════════════
//  Phase 1 — structural analysis (fed into LLM prompt)
// ════════════════════════════════════════════════════════════════════════════

function detectIssues(content, allCubeNames, allDimensions) {
  const issues   = [];
  const cubeName = extractCubeName(content) || "";

  if (!/data_source\s*:/.test(content)) {
    issues.push("MISSING data_source: `default` at the cube top level.");
  }

  if (!/primaryKey\s*:\s*true/.test(content)) {
    issues.push(
      "MISSING primaryKey: no dimension has `primaryKey: true`. " +
      "Use the natural single-column PK if it exists, or a synthetic " +
      "CONCAT(...) of the most discriminating columns, or ROW_NUMBER() OVER() as last resort."
    );
  }

  // Remaining _id-suffix joins that weren't auto-added (shouldn't happen often)
  const joinedCubes = new Set();
  const joinBlock = content.match(/joins\s*:\s*\{([\s\S]*?)\n\s*\}/m);
  if (joinBlock) {
    for (const c of allCubeNames) {
      if (new RegExp(`\\b${c}\\s*:`).test(joinBlock[1])) joinedCubes.add(c);
    }
  }

  for (const [, dim] of content.matchAll(/\b(\w+_id)\s*:\s*\{/g)) {
    const base   = dim.replace(/_id$/, "");
    const target = allCubeNames.find(c => c === base) || allCubeNames.find(c => c === base + "s");
    if (!target || target === cubeName || joinedCubes.has(target)) continue;
    issues.push(
      `MISSING JOIN (FK): dimension \`${dim}\` implies a relation to cube \`${target}\`. ` +
      `Add: ${target}: { sql: \`\${CUBE}.${dim} = \${${target}}.${dim}\`, relationship: \`many_to_one\` }`
    );
    joinedCubes.add(target);
  }

  if (allDimensions) {
    const allCubeNameSet = new Set(allCubeNames);
    const SKIP = new Set(["id","name","value","type","status","date","count","score","rowKey","row_key","key"]);
    const thisDims = allDimensions.get(cubeName) || new Set();
    for (const [otherCube, otherDims] of allDimensions) {
      if (otherCube === cubeName || joinedCubes.has(otherCube)) continue;
      for (const col of thisDims) {
        if (SKIP.has(col) || col.endsWith("_id") || allCubeNameSet.has(col)) continue;
        if (col.length <= 4) continue;
        if (otherDims.has(col)) {
          issues.push(
            `POSSIBLE JOIN (shared column \`${col}\`): this cube and \`${otherCube}\` both have ` +
            `\`${col}\` — add join if it is a FK: ` +
            `${otherCube}: { sql: \`\${CUBE}.${col} = \${${otherCube}}.${col}\`, relationship: \`many_to_one\` }`
          );
          joinedCubes.add(otherCube);
          break;
        }
      }
    }
  }

  const timeDims = [...content.matchAll(/(\w+)\s*:\s*\{[^}]*type\s*:\s*`time`/g)].map(m => m[1]);
  if (timeDims.length >= 2 && !content.includes("DATE_PART") && !content.includes("DATEDIFF")) {
    issues.push(
      `MISSING DATE-DIFF MEASURES: this cube has ${timeDims.length} time dimensions ` +
      `(${timeDims.slice(0, 3).join(", ")}). Add avg measures for meaningful time differences ` +
      `(e.g. processing days, duration) using DATE_PART('day', end_col - start_col).`
    );
  }

  return issues;
}

// ════════════════════════════════════════════════════════════════════════════
//  Phase 1 — LLM prompt builder
// ════════════════════════════════════════════════════════════════════════════

function buildPrompt(fileName, fileContent, detectedIssues, allCubeNames) {
  const issuesSection = detectedIssues.length
    ? `\nDETECTED ISSUES — fix ALL of these first:\n${detectedIssues.map((i, n) => `  ${n + 1}. ${i}`).join("\n")}\n`
    : "\nNo structural issues detected — proceed with enrichment tasks.\n";

  if (!_enrichContext) {
    throw new Error("ENRICH_CONTEXT not set in MongoDB — configure it via POST /context { \"ENRICH_CONTEXT\": \"...\" }");
  }

  return _enrichContext
    .replaceAll("{{FILE_NAME}}",     fileName)
    .replaceAll("{{FILE_CONTENT}}",  fileContent)
    .replaceAll("{{ISSUES_SECTION}}", issuesSection)
    .replaceAll("{{ALL_CUBE_NAMES}}", allCubeNames.join(", "));
}

// ════════════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════════════

function stripFences(text) {
  return text
    .replace(/^```(?:javascript|js)?\n?/im, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
}

// ════════════════════════════════════════════════════════════════════════════
//  File enrichment — combines all phases
// ════════════════════════════════════════════════════════════════════════════

async function enrichFile(filePath, allCubeNames, allDimensions, pkMap) {
  const fileName = path.basename(filePath);
  const cubeName = path.basename(filePath, ".js");
  let content    = fs.readFileSync(filePath, "utf8");

  // ── Phase 0a: ${CUBE}. prefix on bare SQL columns ──────────────────────────
  const { fixed: afterPrefix, fixes: prefixFixes } = applyStaticFixes(content);
  content = afterPrefix;

  // ── Phase 0b+c: missing FK joins ──────────────────────────────────────────
  const { content: afterJoins, added: joinsAdded } = applyJoinFixes(cubeName, content, allCubeNames, pkMap);
  content = afterJoins;

  // ── Phase 0d: planned-vs-actual time dim comparison members ───────────────
  const afterTimeDiff  = applyTimeDiffFixes(content);
  const timeDiffAdded  = afterTimeDiff !== content;
  content = afterTimeDiff;

  const hadStaticChanges = content !== fs.readFileSync(filePath, "utf8");

  // ── Structural issue report (fed to LLM) ──────────────────────────────────
  const issues    = detectIssues(content, allCubeNames, allDimensions);
  const staticTag = [
    prefixFixes.length ? `+${prefixFixes.length} prefix` : "",
    joinsAdded.length  ? `+join(${joinsAdded.join(",")})` : "",
    timeDiffAdded      ? "+timeDiff" : ""
  ].filter(Boolean).join(" ");
  const structTag = issues.length ? `[${issues.length} issue(s)]` : "[ok]";

  const label = [staticTag || (hadStaticChanges ? "[static]" : ""), structTag]
    .filter(Boolean).join(" ").padEnd(40);

  process.stdout.write(`  ${fileName.padEnd(46)} ${label}`);

  if (DRY_RUN) {
    console.log(" (dry-run)");
    if (prefixFixes.length) console.log(`    ↳ would prefix: ${prefixFixes.slice(0, 5).join(", ")}${prefixFixes.length > 5 ? "..." : ""}`);
    if (joinsAdded.length)  console.log(`    ↳ would add joins: ${joinsAdded.join(", ")}`);
    if (timeDiffAdded)      console.log(`    ↳ would add comparison dim/measure`);
    if (issues.length)      issues.forEach(i => console.log(`    • ${i}`));
    return;
  }

  // Write static fixes immediately (even in --static-only mode)
  if (hadStaticChanges) fs.writeFileSync(filePath, content, "utf8");

  if (STATIC_ONLY) {
    console.log(hadStaticChanges ? " ✓ (static)" : " — (no changes)");
    return;
  }

  // ── Phase 1: LLM enrichment ────────────────────────────────────────────────
  const raw    = await callLLM(buildPrompt(fileName, content, issues, allCubeNames));
  const result = stripFences(raw);

  fs.writeFileSync(filePath, result + "\n", "utf8");
  console.log(" ✓");

  if (prefixFixes.length)  console.log(`    ↳ prefixed ${prefixFixes.length} column(s) with \${CUBE}.`);
  if (joinsAdded.length)   console.log(`    ↳ added joins: ${joinsAdded.join(", ")}`);
  if (timeDiffAdded)       console.log(`    ↳ added comparison dim/measure`);
  if (issues.length)       issues.forEach(i => console.log(`    ↳ fixed: ${i}`));
}

// ════════════════════════════════════════════════════════════════════════════
//  Main
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
//  Config loader — fetches LLM + DB settings from a MongoDB Atlas document.
//  Set CONFIG_MONGO_URI + CONFIG_DOC_ID in the environment to enable.
//  Any non-empty field in the document overrides the corresponding env var.
// ════════════════════════════════════════════════════════════════════════════

async function loadConfigFromMongo() {
  const uri    = process.env.CONFIG_MONGO_URI;
  const docId  = process.env.CONFIG_DOC_ID;
  if (!uri || !docId) return;

  const dbName = process.env.CONFIG_MONGO_DB  || "cubedev";
  const col    = process.env.CONFIG_COLLECTION || "cubedev";

  let client;
  try {
    const { MongoClient, ObjectId } = require("mongodb");
    client = new MongoClient(uri);
    await client.connect();

    const doc = await client.db(dbName).collection(col).findOne({ _id: new ObjectId(docId) });
    if (!doc) {
      console.warn(`  ⚠  Config doc ${docId} not found in ${dbName}.${col} — using env vars.\n`);
      return;
    }

    const KEYS = [
      "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL",
      "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASS",
      "DB_SCHEMA", "DB_TYPE", "DB_SSL"
    ];
    let loaded = 0;
    for (const k of KEYS) {
      if (doc[k] !== undefined && doc[k] !== null && doc[k] !== "") {
        process.env[k] = String(doc[k]);
        loaded++;
      }
    }

    // Load enrich prompt context — stored separately (can be long)
    if (doc.ENRICH_CONTEXT) {
      _enrichContext = doc.ENRICH_CONTEXT;
      console.log("  Enrich prompt context loaded from MongoDB Atlas ✓");
    }

    console.log(`  Config loaded from MongoDB Atlas — ${loaded} key(s) from doc ${docId}\n`);
  } catch (err) {
    console.warn(`  ⚠  Could not load config from MongoDB Atlas: ${err.message}`);
    console.warn("     Continuing with environment variables.\n");
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

async function main() {
  // ── Load config from MongoDB Atlas first (overrides env vars) ─────────────
  await loadConfigFromMongo();

  if (!STATIC_ONLY && !DRY_RUN && !process.env.LLM_API_KEY) {
    console.error(
      "Error: LLM_API_KEY is required for full enrichment.\n" +
      "  Set it in the config document or export LLM_API_KEY=sk-...\n\n" +
      "To run static fixes only (no LLM), use:\n" +
      "  node scripts/enrich-cubes.js --static-only"
    );
    process.exit(1);
  }

  if (!fs.existsSync(SCHEMA_DIR)) {
    console.error(`Schema directory not found: ${SCHEMA_DIR}`);
    process.exit(1);
  }

  // ── Phase -1: generate cube files from DB schema ─────────────────────────
  if (process.env.DB_HOST && process.env.DB_NAME) {
    console.log(`\nPhase -1 — Generating cube files from database (${process.env.DB_HOST}/${process.env.DB_NAME})...\n`);
    const generated = await generateMissingCubes();
    if (generated.length > 0) {
      console.log(`\n  → Created ${generated.length} new cube file(s)\n`);
    } else if (!DRY_RUN) {
      console.log("  All database tables already have cube files.\n");
    }
  }

  const allCubeNames  = getAllCubeNames();
  const allDimensions = collectAllDimensions(allCubeNames);
  const pkMap         = buildPrimaryKeyMap(allCubeNames);

  const files = fs.readdirSync(SCHEMA_DIR)
    .filter(f => f.endsWith(".js"))
    .filter(f => !ONLY_CUBE || f === `${ONLY_CUBE}.js`)
    .map(f => path.join(SCHEMA_DIR, f));

  if (files.length === 0) {
    console.error(ONLY_CUBE
      ? `Cube file not found: ${ONLY_CUBE}.js`
      : `No .js files found in ${SCHEMA_DIR}`);
    process.exit(1);
  }

  const modeLabel = STATIC_ONLY
    ? "static fixes only (no LLM)"
    : `LLM enrichment  [model: ${process.env.LLM_MODEL}]  [provider: ${process.env.LLM_PROVIDER}]`;

  console.log(`\nCube enrichment — ${files.length} file(s)  [${modeLabel}]`);
  if (DRY_RUN) console.log("DRY RUN — no files will be written");
  console.log();

  let ok = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    try {
      await enrichFile(files[i], allCubeNames, allDimensions, pkMap);
      ok++;
    } catch (err) {
      const name = path.basename(files[i]);
      console.log(` ✗  (${err.message})`);
      errors.push({ name, message: err.message });
      failed++;
    }
    if (!STATIC_ONLY && i < files.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nDone: ${ok} processed, ${failed} failed`);
  if (errors.length) {
    console.log("\nFailed files:");
    for (const e of errors) console.log(`  ${e.name}: ${e.message}`);
    process.exit(1);
  }

  // ── Always save catalog to DuckDB (unless dry-run) ───────────────────────
  if (!DRY_RUN) {
    await saveCatalogToDuckDB(allCubeNames);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  DuckDB catalog snapshot
//  Parses the (now-enriched) .js cube files and writes structured tables:
//    cubes        (name, title, description, sql_table)
//    members      (cube, member, kind, type, title, description)
//    joins        (from_cube, to_cube, fk_column, relationship)
//
//  Works for ANY schema — purely structural, no hardcoded names.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Lightweight parser for a Cube.js schema file.
 * Uses line-by-line and brace-counting approaches — does NOT eval the JS.
 * Handles ${CUBE}. expressions inside sql fields correctly.
 */
function parseCubeFile(filePath) {
  const content  = fs.readFileSync(filePath, "utf8");
  const fileName = path.basename(filePath, ".js");
  const lines    = content.split("\n");

  // cube name
  const nameMatch = content.match(/cube\s*\(\s*[`'"](\w+)[`'"]/);
  const cubeName  = nameMatch ? nameMatch[1] : fileName;

  // sql_table
  const tableMatch = content.match(/sql_table\s*:\s*[`'"]([^`'"]+)[`'"]/);
  const sqlTable   = tableMatch ? tableMatch[1] : "";

  // Cube-level title / description (first occurrence)
  const titleMatch = content.match(/\btitle\s*:\s*[`'"]([^`'"]+)[`'"]/);
  const descMatch  = content.match(/\bdescription\s*:\s*[`'"]([^`'"]{1,400})[`'"]/);
  const cubeTitle  = titleMatch ? titleMatch[1] : cubeName;
  const cubeDesc   = descMatch  ? descMatch[1]  : "";

  const CONTAINER = new Set(["measures","dimensions","joins","segments"]);
  const MEASURE_TYPES = new Set(["count","sum","avg","min","max","count_distinct"]);

  /**
   * Extract member names and metadata from a block (measures or dimensions).
   * Returns array of { name, kind, type, title, description }.
   * Uses a line-based scan: each 4-space-indented `word:` starts a new member.
   * Reads ahead until the next 4-space member or the end of the outer block.
   */
  function extractMembers(blockContent, defaultKind) {
    const result = [];
    const blockLines = blockContent.split("\n");
    let currentName = null;
    let currentLines = [];

    const flush = () => {
      if (!currentName || CONTAINER.has(currentName)) return;
      const body = currentLines.join("\n");
      const typeMatch = body.match(/type\s*:\s*[`'"](\w+)[`'"]/);
      const rawType   = typeMatch ? typeMatch[1] : "";
      let kind = defaultKind;
      if (MEASURE_TYPES.has(rawType)) kind = "measure";
      else if (rawType === "time")    kind = "timeDimension";
      const mTitle = (body.match(/title\s*:\s*[`'"]([^`'"]+)[`'"]/)||[])[1] || currentName;
      const mDesc  = (body.match(/description\s*:\s*[`'"]([^`'"]{1,300})[`'"]/)||[])[1] || "";
      result.push({ name: currentName, kind, type: rawType, title: mTitle, description: mDesc });
    };

    for (const line of blockLines) {
      const indentMatch = line.match(/^ {4}(\w+)\s*:/);
      if (indentMatch) {
        flush();
        currentName  = indentMatch[1];
        currentLines = [line];
      } else if (currentName) {
        currentLines.push(line);
      }
    }
    flush();
    return result;
  }

  const members = [];
  for (const blockName of ["measures", "dimensions"]) {
    const bm = content.match(new RegExp(`\\b${blockName}\\s*:\\s*\\{`));
    if (!bm) continue;
    const openIdx  = content.indexOf("{", bm.index + bm[0].length - 1);
    const closeIdx = findClosingBrace(content, openIdx);
    if (closeIdx === -1) continue;
    const blockContent = content.substring(openIdx + 1, closeIdx);
    const defaultKind  = blockName === "measures" ? "measure" : "dimension";
    for (const m of extractMembers(blockContent, defaultKind)) {
      members.push({
        cube: cubeName,
        member: `${cubeName}.${m.name}`,
        kind: m.kind,
        type: m.type,
        title: m.title,
        description: m.description
      });
    }
  }

  // joins: parse the joins block
  const joinPairs = [];
  const jm = content.match(/\bjoins\s*:\s*\{/);
  if (jm) {
    const openIdx  = content.indexOf("{", jm.index + jm[0].length - 1);
    const closeIdx = findClosingBrace(content, openIdx);
    if (closeIdx !== -1) {
      const block = content.substring(openIdx + 1, closeIdx);
      // Each join: targetCube: { sql: `...`, relationship: `...` }
      // Use line-based scan: 4-space-indented word = join target
      let tgt = null, sql = "", rel = "";
      for (const line of block.split("\n")) {
        const tgtMatch = line.match(/^ {4}(\w+)\s*:/);
        if (tgtMatch) {
          if (tgt) {
            const fkMatch = sql.match(/\$\{CUBE\}\.(\w+)/);
            joinPairs.push({ from: cubeName, to: tgt, fk: fkMatch ? fkMatch[1] : "", relationship: rel });
          }
          tgt = tgtMatch[1]; sql = line; rel = "";
        } else if (tgt) {
          sql += line;
          const relMatch = line.match(/relationship\s*:\s*[`'"](\w+)[`'"]/);
          if (relMatch) rel = relMatch[1];
        }
      }
      if (tgt) {
        const fkMatch = sql.match(/\$\{CUBE\}\.(\w+)/);
        joinPairs.push({ from: cubeName, to: tgt, fk: fkMatch ? fkMatch[1] : "", relationship: rel });
      }
    }
  }

  return { cubeName, sqlTable, cubeTitle, cubeDesc, members, joins: joinPairs };
}

async function saveCatalogToDuckDB(allCubeNames) {
  let duckdb;
  try {
    duckdb = require("duckdb");
  } catch {
    console.warn("  duckdb package not available — skipping catalog save.");
    console.warn("  Install with: npm install duckdb  (in the scripts/ or api/ directory)");
    return;
  }

  // Ensure output dir exists
  const dir = path.dirname(CATALOG_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Write to a temp file first so we never try to open the live catalog
  // while the API might have it open (DuckDB blocks concurrent writers).
  const tmpPath = CATALOG_DB + ".tmp";
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  const db   = new duckdb.Database(tmpPath);
  const conn = db.connect();

  const run = (sql, params = []) => new Promise((res, rej) =>
    conn.run(sql, ...params, (err) => err ? rej(err) : res())
  );

  // (Re)create tables
  await run("DROP TABLE IF EXISTS cube_joins");
  await run("DROP TABLE IF EXISTS cube_members");
  await run("DROP TABLE IF EXISTS cubes");

  await run(`CREATE TABLE cubes (
    name VARCHAR PRIMARY KEY,
    title VARCHAR,
    description VARCHAR,
    sql_table VARCHAR
  )`);

  await run(`CREATE TABLE cube_members (
    id INTEGER PRIMARY KEY,
    cube VARCHAR,
    member VARCHAR,
    kind VARCHAR,
    type VARCHAR,
    title VARCHAR,
    description VARCHAR
  )`);

  await run(`CREATE TABLE cube_joins (
    from_cube VARCHAR,
    to_cube VARCHAR,
    fk_column VARCHAR,
    relationship VARCHAR
  )`);

  let memberId = 0;
  for (const name of allCubeNames) {
    const filePath = path.join(SCHEMA_DIR, `${name}.js`);
    if (!fs.existsSync(filePath)) continue;
    const { cubeName, sqlTable, cubeTitle, cubeDesc, members, joins } = parseCubeFile(filePath);

    await run("INSERT INTO cubes VALUES (?, ?, ?, ?)", [cubeName, cubeTitle, cubeDesc, sqlTable]);

    for (const m of members) {
      await run("INSERT INTO cube_members VALUES (?, ?, ?, ?, ?, ?, ?)",
        [memberId++, m.cube, m.member, m.kind, m.type, m.title, m.description]);
    }

    for (const j of joins) {
      await run("INSERT INTO cube_joins VALUES (?, ?, ?, ?)",
        [j.from, j.to, j.fk, j.relationship]);
    }
  }

  // Summary
  const countRow = await new Promise((res, rej) =>
    conn.all("SELECT COUNT(*) AS n FROM cube_members", (err, rows) => err ? rej(err) : res(rows[0]))
  );
  conn.close();
  db.close();

  // Atomically replace the live catalog now that writing is done
  if (fs.existsSync(CATALOG_DB)) fs.unlinkSync(CATALOG_DB);
  fs.renameSync(tmpPath, CATALOG_DB);

  console.log(`\nDuckDB catalog saved → ${CATALOG_DB}`);
  console.log(`  cubes: ${allCubeNames.length}   members: ${countRow.n}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
