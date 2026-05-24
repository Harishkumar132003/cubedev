const duckdb = require("duckdb");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const fs = require("fs");

const CUBE_API_URL   = process.env.CUBE_API_URL    || "http://localhost:4000";
const CUBE_API_SECRET = process.env.CUBE_API_SECRET || "mysecretkey123";
const TTL_MS         = Number(process.env.CATALOG_TTL_MS || 5 * 60 * 1000);
// Path to the persisted DuckDB catalog written by enrich-cubes.js.
// When present, the API loads from this file instead of calling Cube /meta.
// This gives richer FTS (titles + descriptions added by LLM enrichment).
const CATALOG_DB_PATH = process.env.CATALOG_DB_PATH || null;

const db = new duckdb.Database(":memory:");
const conn = db.connect();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.run(sql, ...params, (err) => (err ? reject(err) : resolve()));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

let ftsLoaded = false;
let loadedAt = 0;
let cubesByName = new Map();   // cube name → cube meta object
let joinGraph   = new Map();   // cube name → Set of directly joined cube names
let loadPromise = null;

function cubeToken() {
  return jwt.sign({}, CUBE_API_SECRET, { expiresIn: "24h" });
}

async function fetchMeta() {
  const res = await axios.get(`${CUBE_API_URL}/cubejs-api/v1/meta`, {
    headers: { Authorization: `Bearer ${cubeToken()}` },
    timeout: 10000
  });
  return res.data;
}

async function ensureExtensions() {
  if (ftsLoaded) return;
  await run("INSTALL fts");
  await run("LOAD fts");
  ftsLoaded = true;
}

/**
 * Build a join graph from the meta response.
 * Two strategies combined:
 *   1. Explicit: read cube.joins if Cube exposes them in /meta.
 *   2. Inferred: any dimension named <target>_id (string type) implies a join to <target> or <target>s.
 */
function buildJoinGraph(meta) {
  const allNames = new Set((meta.cubes || []).map(c => c.name));
  const graph    = new Map();

  for (const cube of meta.cubes || []) {
    const joined = new Set();

    // Strategy 1 – explicit joins block (present in some Cube versions)
    if (cube.joins && typeof cube.joins === "object") {
      for (const target of Object.keys(cube.joins)) {
        if (allNames.has(target) && target !== cube.name) joined.add(target);
      }
    }

    // Strategy 2 – infer from _id dimensions
    for (const dim of cube.dimensions || []) {
      const col = (dim.name || "").split(".").pop(); // strip "cube." prefix
      if (!col.endsWith("_id")) continue;
      const base = col.replace(/_id$/, "");
      const target =
        allNames.has(base)        ? base :
        allNames.has(base + "s")  ? base + "s" : null;
      if (target && target !== cube.name) joined.add(target);
    }

    graph.set(cube.name, joined);
  }

  // Add reverse edges so expansion works both ways.
  // e.g. order_items joins orders → orders can also reach order_items.
  // This lets BFS find fact tables from any connected dimension cube.
  const reverseGraph = new Map();
  for (const [cube, targets] of graph) {
    for (const target of targets) {
      if (!reverseGraph.has(target)) reverseGraph.set(target, new Set());
      reverseGraph.get(target).add(cube);
    }
  }
  for (const [cube, reverseCubes] of reverseGraph) {
    if (!graph.has(cube)) graph.set(cube, new Set());
    for (const rc of reverseCubes) graph.get(cube).add(rc);
  }

  return graph;
}

async function rebuild(meta) {
  await ensureExtensions();
  await run("DROP TABLE IF EXISTS members");
  await run(`
    CREATE TABLE members (
      id INTEGER PRIMARY KEY,
      cube VARCHAR,
      member VARCHAR,
      kind VARCHAR,
      search_text VARCHAR
    )
  `);

  cubesByName = new Map();
  joinGraph   = buildJoinGraph(meta);

  const rows = [];
  let id = 0;

  for (const cube of meta.cubes || []) {
    cubesByName.set(cube.name, {
      name: cube.name,
      title: cube.title,
      description: cube.description,
      measures: (cube.measures || []).map((m) => ({
        name: m.name,
        type: m.type,
        title: m.title,
        description: m.description
      })),
      dimensions: (cube.dimensions || []).map((d) => ({
        name: d.name,
        type: d.type,
        title: d.title,
        description: d.description
      }))
    });

    const cubeText = [cube.name, cube.title, cube.description].filter(Boolean).join(" ");
    for (const m of cube.measures || []) {
      rows.push([
        id++,
        cube.name,
        m.name,
        "measure",
        [cubeText, m.name, m.title, m.description].filter(Boolean).join(" ")
      ]);
    }
    for (const d of cube.dimensions || []) {
      rows.push([
        id++,
        cube.name,
        d.name,
        d.type === "time" ? "timeDimension" : "dimension",
        [cubeText, d.name, d.title, d.description].filter(Boolean).join(" ")
      ]);
    }
  }

  for (const row of rows) {
    await run("INSERT INTO members VALUES (?, ?, ?, ?, ?)", row);
  }

  if (rows.length > 0) {
    await run("PRAGMA create_fts_index('members', 'id', 'search_text', overwrite=1)");
  }

  loadedAt = Date.now();
}

/**
 * Load the catalog from a persisted DuckDB file written by enrich-cubes.js.
 * The file has three tables: cubes, cube_members, cube_joins.
 * Richer search_text (LLM titles + descriptions) than loading from /meta alone.
 */
async function rebuildFromFile(filePath) {
  await ensureExtensions();
  await run("DROP TABLE IF EXISTS members");
  await run(`
    CREATE TABLE members (
      id INTEGER PRIMARY KEY,
      cube VARCHAR,
      member VARCHAR,
      kind VARCHAR,
      search_text VARCHAR
    )
  `);

  cubesByName = new Map();
  joinGraph   = new Map();

  // Open the file read-only in a temporary connection
  const fileDb   = new duckdb.Database(filePath, duckdb.OPEN_READONLY);
  const fileConn = fileDb.connect();
  const fileAll  = (sql) => new Promise((res, rej) =>
    fileConn.all(sql, (err, rows) => err ? rej(err) : res(rows))
  );

  try {
    const cubes   = await fileAll("SELECT name, title, description, sql_table FROM cubes ORDER BY name");
    const members = await fileAll("SELECT cube, member, kind, type, title, description FROM cube_members");
    const joins   = await fileAll("SELECT from_cube, to_cube FROM cube_joins");

    // Group members by cube
    const membersByCube = new Map();
    for (const m of members) {
      if (!membersByCube.has(m.cube)) membersByCube.set(m.cube, []);
      membersByCube.get(m.cube).push(m);
    }

    // Build cubesByName + FTS rows
    const rows = [];
    let id = 0;

    for (const cube of cubes) {
      const cubeMembers = membersByCube.get(cube.name) || [];
      cubesByName.set(cube.name, {
        name: cube.name,
        title: cube.title,
        description: cube.description,
        measures: cubeMembers
          .filter(m => m.kind === "measure")
          .map(m => ({ name: m.member, type: m.type, title: m.title, description: m.description })),
        dimensions: cubeMembers
          .filter(m => m.kind !== "measure")
          .map(m => ({ name: m.member, type: m.type, title: m.title, description: m.description }))
      });

      const cubeText = [cube.name, cube.title, cube.description].filter(Boolean).join(" ");
      for (const m of cubeMembers) {
        const shortName = m.member.split(".").pop();
        rows.push([
          id++,
          cube.name,
          m.member,
          m.kind,
          [cubeText, m.member, shortName, m.title, m.description].filter(Boolean).join(" ")
        ]);
      }
    }

    for (const row of rows) {
      await run("INSERT INTO members VALUES (?, ?, ?, ?, ?)", row);
    }

    if (rows.length > 0) {
      await run("PRAGMA create_fts_index('members', 'id', 'search_text', overwrite=1)");
    }

    // Build bidirectional join graph from cube_joins table
    for (const cube of cubes) joinGraph.set(cube.name, new Set());
    for (const j of joins) {
      if (!joinGraph.has(j.from_cube)) joinGraph.set(j.from_cube, new Set());
      if (!joinGraph.has(j.to_cube))   joinGraph.set(j.to_cube,   new Set());
      joinGraph.get(j.from_cube).add(j.to_cube);
      joinGraph.get(j.to_cube).add(j.from_cube);  // bidirectional
    }

  } finally {
    fileConn.close();
    fileDb.close();
  }

  loadedAt = Date.now();
  console.log(`Catalog loaded from file: ${filePath}  (${cubesByName.size} cubes, ${[...cubesByName.values()].reduce((n,c)=>n+c.measures.length+c.dimensions.length,0)} members)`);
}

async function ensureLoaded(force = false) {
  if (!force && cubesByName.size > 0 && Date.now() - loadedAt < TTL_MS) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    // Prefer the persisted DuckDB catalog (richer FTS from LLM enrichment)
    if (CATALOG_DB_PATH && fs.existsSync(CATALOG_DB_PATH)) {
      await rebuildFromFile(CATALOG_DB_PATH);
    } else {
      const meta = await fetchMeta();
      await rebuild(meta);
    }
  })();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function sanitize(q) {
  return (q || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Check if any token in the question directly names a cube.
 * Matches exact name ("customers"), last segment ("customers" from "order_customers"),
 * or singular form ("customer" → "customers").
 */
function directNameMatches(qWords, allCubeNames) {
  const matched = [];
  for (const name of allCubeNames) {
    const parts    = name.split("_");
    const lastName = parts[parts.length - 1];
    const singular = lastName.endsWith("s") ? lastName.slice(0, -1) : lastName;
    // Also match the full snake_case name with underscores replaced by spaces
    const spaceName = name.replace(/_/g, " ");

    if (
      qWords.has(name)      ||   // exact: "customers"
      qWords.has(lastName)  ||   // last word: "items" from "order_items"
      qWords.has(singular)  ||   // singular: "customer" → customers
      qWords.has(spaceName)      // space variant: "order items"
    ) {
      matched.push(name);
    }
  }
  return matched;
}

async function findRelevantMeta(question, { maxCubes = 5, maxMembers = 30 } = {}) {
  await ensureLoaded();

  const q      = sanitize(question);
  const qWords = new Set(q.split(/\s+/));

  // ── Step 1: BM25 full-text search ───────────────────────────────────────────
  let matches = [];
  if (q && cubesByName.size > 0) {
    matches = await all(
      `SELECT id, cube, member, kind, score FROM (
         SELECT id, cube, member, kind, fts_main_members.match_bm25(id, ?) AS score
         FROM members
       ) WHERE score IS NOT NULL
       ORDER BY score DESC
       LIMIT ?`,
      [q, maxMembers]
    );
  }

  // Ranked cube list from BM25
  const seen      = new Set();
  const cubeOrder = [];
  for (const row of matches) {
    if (!seen.has(row.cube)) {
      seen.add(row.cube);
      cubeOrder.push(row.cube);
      if (cubeOrder.length >= maxCubes) break;
    }
  }

  // ── Step 2: Direct name matching ─────────────────────────────────────────────
  // If the question literally names a cube (e.g. "customers"), always include it
  // even if BM25 ranked it low due to high term frequency penalty.
  const directHits = directNameMatches(qWords, [...cubesByName.keys()]);
  for (const name of directHits) {
    if (!seen.has(name) && cubeOrder.length < maxCubes) {
      seen.add(name);
      cubeOrder.push(name);
    }
  }

  // ── Step 3: Join-path expansion (multi-hop) ──────────────────────────────────
  // Expand along join edges until no new cubes can be added or maxCubes is reached.
  // Multi-hop ensures: customers → orders → order_items all get included when
  // a question needs the full chain (e.g. "cities by revenue").
  let frontier = [...cubeOrder];
  while (frontier.length > 0 && cubeOrder.length < maxCubes) {
    const nextFrontier = [];
    for (const cube of frontier) {
      if (cubeOrder.length >= maxCubes) break;
      for (const joined of joinGraph.get(cube) || []) {
        if (!seen.has(joined) && cubeOrder.length < maxCubes) {
          seen.add(joined);
          cubeOrder.push(joined);
          nextFrontier.push(joined);   // newly added → expand from these next round
        }
      }
    }
    frontier = nextFrontier;           // next BFS level
  }

  // ── Resolve to full cube objects ──────────────────────────────────────────────
  const selected = cubeOrder.length
    ? cubeOrder.map((n) => cubesByName.get(n)).filter(Boolean)
    : Array.from(cubesByName.values());

  return {
    cubes: selected,
    matched: matches.map((m) => ({
      cube: m.cube,
      member: m.member,
      kind: m.kind,
      score: Number(m.score)
    })),
    fallbackUsed: cubeOrder.length === 0,
    totalCubesAvailable: cubesByName.size
  };
}

module.exports = {
  ensureLoaded,
  refresh: () => ensureLoaded(true),
  findRelevantMeta
};
