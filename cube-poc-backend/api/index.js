const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { MongoClient, ObjectId } = require("mongodb");
const { askLLM, streamLLM, invalidateContextCache } = require("./llm");
const catalog = require("./catalog");
const { validateAndFixQuery } = require("./queryValidator");

// Directory where Cube.js schema files live (mounted into the container)
const CUBE_SCHEMA_DIR = process.env.CUBE_SCHEMA_DIR || "/app/cube/schema/cubes";

// Allowed config keys that can be updated via POST /config
const CONFIG_KEYS = [
  "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL",
  "DB_TYPE", "DB_HOST", "DB_PORT", "DB_NAME",
  "DB_USER", "DB_PASS", "DB_SCHEMA", "DB_SSL"
];

// ── Server-Sent Events helpers ────────────────────────────────────────────────
function sseSetup(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function sseSend(res, type, payload = {}) {
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Phase -1: cube generation helpers ────────────────────────────────────────

/** Map a SQL column data type to a Cube.dev dimension type (generic, any SQL dialect). */
function sqlTypeToCube(sqlType) {
  const t = (sqlType || "").toLowerCase();
  if (/int|numeric|decimal|real|float|double|money|serial/.test(t)) return "number";
  if (/timestamp|datetime|date\b|time\b/.test(t))                   return "time";
  if (/^bool/.test(t))                                               return "boolean";
  return "string";
}

/** snake_case → PascalCase  (e.g. unit_price → UnitPrice) */
function toPascalCase(snake) {
  return snake.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/**
 * Render a minimal-but-valid cube .js file for one table.
 * Generic — no hardcoded column or table names.
 */
function generateCubeContent(tableName, columns, primaryKeys, schema) {
  const measureLines = [`    count: { type: \`count\` }`];

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

  const hasPk = columns.some(c => primaryKeys.has(c.column_name));
  if (!hasPk) {
    dimLines.unshift(`    rowKey: { sql: \`CAST(ROW_NUMBER() OVER() AS VARCHAR)\`, type: \`string\`, primaryKey: true }`);
  }

  return `cube(\`${tableName}\`, {
  sql_table: \`${schema}.${tableName}\`,
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
 * Connect to the DB described by `creds`, discover all tables that don't
 * yet have a cube file, generate + write those files, and stream SSE
 * progress events throughout.
 *
 * Currently supports: postgres.  Other types log a skip message.
 * Returns { generated: [tableName, ...] }.
 */
async function generateCubesFromDB(res, creds) {
  const dbType = (creds.DB_TYPE || "postgres").toLowerCase();
  const schema = creds.DB_SCHEMA || "public";

  if (dbType !== "postgres") {
    sseSend(res, "progress", { message: `DB type '${dbType}' — cube generation not yet supported, skipping` });
    return { generated: [], deleted: [] };
  }

  // Always wipe existing cube files before regenerating
  const deleted = [];
  if (fs.existsSync(CUBE_SCHEMA_DIR)) {
    const oldFiles = fs.readdirSync(CUBE_SCHEMA_DIR).filter(f => f.endsWith(".js"));
    for (const f of oldFiles) {
      fs.unlinkSync(path.join(CUBE_SCHEMA_DIR, f));
      deleted.push(path.basename(f, ".js"));
    }
    if (deleted.length) {
      sseSend(res, "progress", { message: `Deleted ${deleted.length} existing cube file(s)` });
    }
  }

  sseSend(res, "progress", { message: `Discovering tables in '${creds.DB_NAME}' (schema: ${schema})...` });

  const { Client } = require("pg");
  const client = new Client({
    host:     creds.DB_HOST,
    port:     parseInt(creds.DB_PORT || "5432"),
    database: creds.DB_NAME,
    user:     creds.DB_USER,
    password: creds.DB_PASS,
    ssl:      creds.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000
  });
  await client.connect();

  const generated = [];
  try {
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schema]
    );

    const existingCubes = new Set(
      fs.existsSync(CUBE_SCHEMA_DIR)
        ? fs.readdirSync(CUBE_SCHEMA_DIR)
            .filter(f => f.endsWith(".js"))
            .map(f => path.basename(f, ".js"))
        : []
    );

    const newTables = tables.filter(t => !existingCubes.has(t.table_name));

    sseSend(res, "progress", {
      message: `Found ${tables.length} table(s) — ${newTables.length} new cube(s) to create`
    });

    if (!fs.existsSync(CUBE_SCHEMA_DIR)) {
      fs.mkdirSync(CUBE_SCHEMA_DIR, { recursive: true });
    }

    for (const { table_name } of newTables) {
      sseSend(res, "progress", { message: `Creating cube: ${table_name}...` });

      const { rows: columns } = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table_name]
      );

      if (columns.length === 0) {
        sseSend(res, "progress", { message: `Skipping ${table_name} — no columns found` });
        continue;
      }

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

      const numericCount = columns.filter(
        c => sqlTypeToCube(c.data_type) === "number" && !primaryKeys.has(c.column_name)
      ).length;

      const content = generateCubeContent(table_name, columns, primaryKeys, schema);
      fs.writeFileSync(path.join(CUBE_SCHEMA_DIR, `${table_name}.js`), content, "utf8");
      generated.push(table_name);

      sseSend(res, "progress", {
        message: `✓ ${table_name} — ${columns.length} columns, ${numericCount * 2 + 1} measures`
      });
    }

    if (newTables.length === 0) {
      sseSend(res, "progress", { message: "All tables already have cube files — nothing new to generate" });
    }
  } finally {
    await client.end().catch(() => {});
  }

  // Refresh catalog so /ask picks up the new cubes immediately
  if (generated.length > 0) {
    sseSend(res, "progress", { message: "Refreshing schema catalog..." });
    await catalog.refresh().catch(err =>
      sseSend(res, "progress", { message: `Catalog refresh deferred: ${err.message}` })
    );
    sseSend(res, "progress", { message: "Schema catalog updated ✓" });
  }

  return { generated, deleted };
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

const CUBE_API_URL = process.env.CUBE_API_URL || "http://localhost:4000";
const CUBE_API_SECRET = process.env.CUBE_API_SECRET || "mysecretkey123";
const PORT = process.env.PORT || 3000;

function getCubeToken() {
  return jwt.sign({}, CUBE_API_SECRET, { expiresIn: "24h" });
}

async function queryCube(cubeQuery) {
  const response = await axios.post(
    `${CUBE_API_URL}/cubejs-api/v1/load`,
    { query: cubeQuery },
    {
      headers: {
        Authorization: `Bearer ${getCubeToken()}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );
  return response.data;
}

async function getCubeMeta() {
  const response = await axios.get(`${CUBE_API_URL}/cubejs-api/v1/meta`, {
    headers: { Authorization: `Bearer ${getCubeToken()}` },
    timeout: 10000
  });
  return response.data;
}

// GET /health
app.get("/health", async (req, res) => {
  let cubeStatus = "unavailable";
  try {
    await axios.get(`${CUBE_API_URL}/livez`, {
      headers: { Authorization: `Bearer ${getCubeToken()}` },
      timeout: 5000
    });
    cubeStatus = "ok";
  } catch {}

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    llm: {
      provider: process.env.LLM_PROVIDER || "not configured",
      model: process.env.LLM_MODEL || "default",
      ready: !!process.env.LLM_API_KEY
    },
    services: { api: "ok", cube: cubeStatus }
  });
});

// GET /meta — all cubes, measures, dimensions from Cube
app.get("/meta", async (req, res) => {
  try {
    const meta = await getCubeMeta();
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// POST /query — direct Cube query (no LLM) — SSE stream
app.post("/query", async (req, res) => {
  sseSetup(res);
  const { query } = req.body;

  if (!query) {
    sseSend(res, "error", { message: "Missing 'query' field" });
    return res.end();
  }

  try {
    sseSend(res, "progress", { message: "Executing Cube query..." });
    const cubeResponse = await queryCube(query);
    sseSend(res, "done", {
      status: "ok",
      query,
      result: cubeResponse.data,
      meta: { rowCount: cubeResponse.data?.length ?? 0 }
    });
  } catch (err) {
    sseSend(res, "error", { message: err.response?.data?.error || err.message, query });
  }
  res.end();
});

// POST /ask — natural language question → LLM → Cube query → result — SSE stream
app.post("/ask", async (req, res) => {
  sseSetup(res);
  const { question } = req.body;

  if (!question || typeof question !== "string") {
    sseSend(res, "error", { message: "Missing 'question' field" });
    return res.end();
  }

  if (!process.env.LLM_API_KEY) {
    sseSend(res, "error", { message: "LLM not configured — set LLM_API_KEY via POST /config" });
    return res.end();
  }

  try {
    // Step 1: schema retrieval
    sseSend(res, "progress", { step: "schema", message: "Searching relevant schema..." });
    const { cubes, matched, fallbackUsed, totalCubesAvailable } =
      await catalog.findRelevantMeta(question);

    sseSend(res, "progress", {
      step: "schema",
      message: `Found ${cubes.length} relevant cube(s): ${cubes.map(c => c.name).join(", ")}`
    });

    const retrieval = { cubesSent: cubes.map(c => c.name), matchedMembers: matched, fallbackUsed, totalCubesAvailable };

    // Step 2: LLM query generation — stream tokens live to the UI
    sseSend(res, "progress", { step: "llm", message: "Generating Cube query with LLM..." });
    let { cubeQuery, model } = await streamLLM(
      question,
      { cubes },
      (token) => sseSend(res, "token", { text: token })
    );

    if (cubeQuery.clarify) {
      sseSend(res, "clarification", { message: cubeQuery.clarify, retrieval });
      return res.end();
    }

    // Step 3: validate
    sseSend(res, "progress", { step: "validate", message: "Validating query fields..." });
    const { fixedQuery, changes } = validateAndFixQuery(cubeQuery, { cubes });
    cubeQuery = fixedQuery;
    if (changes.length) {
      sseSend(res, "progress", { step: "validate", message: `Auto-corrected ${changes.length} field(s)` });
    }

    // Step 4: execute Cube query (with one retry on error)
    sseSend(res, "progress", { step: "execute", message: "Executing query..." });
    let cubeResponse, retried = false;
    try {
      cubeResponse = await queryCube(cubeQuery);
    } catch (firstErr) {
      const cubeError = firstErr.response?.data?.error || firstErr.message;
      sseSend(res, "progress", { step: "retry", message: `Query failed — asking LLM to self-correct...` });
      retried = true;

      let retryCubes = cubes;
      const joinPathMatch = cubeError.match(/Can't find join path to join (.+)/);
      if (joinPathMatch) {
        const badCubeNames = joinPathMatch[1].split(",").map(s => s.replace(/['"]/g, "").trim());
        retryCubes = cubes.filter(c => !badCubeNames.includes(c.name));
        sseSend(res, "progress", { step: "retry", message: `Removed disconnected cube(s): ${badCubeNames.join(", ")}` });
      }

      sseSend(res, "progress", { step: "retry", message: "Generating corrected query..." });
      const retry = await streamLLM(
        question,
        { cubes: retryCubes },
        (token) => sseSend(res, "token", { text: token }),
        { previousQuery: cubeQuery, cubeError }
      );

      if (retry.cubeQuery.clarify) {
        sseSend(res, "clarification", { message: retry.cubeQuery.clarify, retrieval });
        return res.end();
      }
      const { fixedQuery: retryFixed } = validateAndFixQuery(retry.cubeQuery, { cubes: retryCubes });
      cubeQuery = retryFixed;

      sseSend(res, "progress", { step: "execute", message: "Executing corrected query..." });
      cubeResponse = await queryCube(cubeQuery);
    }

    sseSend(res, "done", {
      status: "ok",
      question,
      model,
      retrieval,
      cubeQuery,
      validatorCorrections: changes.length > 0 ? changes : undefined,
      result: cubeResponse.data,
      meta: { rowCount: cubeResponse.data?.length ?? 0, retried }
    });
  } catch (err) {
    sseSend(res, "error", { message: err.response?.data?.error || err.message });
  }
  res.end();
});

// POST /config — validate + update LLM / DB credentials — SSE stream
// Body: any subset of { LLM_PROVIDER, LLM_API_KEY, LLM_MODEL,
//                       DB_TYPE, DB_HOST, DB_PORT, DB_NAME,
//                       DB_USER, DB_PASS, DB_SCHEMA, DB_SSL }
// Flow: validate Atlas store → validate DB connection (if DB creds given) → save
app.post("/config", async (req, res) => {
  sseSetup(res);

  const cfgUri = process.env.CONFIG_MONGO_URI;
  const cfgDb  = process.env.CONFIG_MONGO_DB  || "cubedev";
  const cfgCol = process.env.CONFIG_COLLECTION || "cubedev";
  const docId  = process.env.CONFIG_DOC_ID;

  if (!cfgUri || !docId) {
    sseSend(res, "error", { message: "Config store not configured — set CONFIG_MONGO_URI and CONFIG_DOC_ID" });
    return res.end();
  }

  // Filter to allowed keys only
  const updates = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (CONFIG_KEYS.includes(k)) updates[k] = String(v);
  }

  if (Object.keys(updates).length === 0) {
    sseSend(res, "error", { message: "No valid fields provided", allowedFields: CONFIG_KEYS });
    return res.end();
  }

  let atlasClient;
  try {
    // ── Step 1: connect to Atlas config store ────────────────────────────────
    sseSend(res, "progress", { message: "Connecting to config store..." });
    atlasClient = new MongoClient(cfgUri);
    await atlasClient.connect();
    sseSend(res, "progress", { message: "Config store connected ✓" });

    // ── Step 2: validate DB connection if any DB fields are being updated ────
    const DB_FIELDS = ["DB_TYPE","DB_HOST","DB_PORT","DB_NAME","DB_USER","DB_PASS","DB_SSL"];
    let mergedCreds = null;  // set only when DB validation runs successfully

    if (DB_FIELDS.some(k => updates[k])) {
      sseSend(res, "progress", { message: "Validating database connection..." });

      // Merge current stored creds with incoming updates for a complete credential set
      const currentDoc = await atlasClient.db(cfgDb).collection(cfgCol)
        .findOne({ _id: new ObjectId(docId) }) || {};
      const merged = { ...currentDoc, ...updates };

      const dbType = (merged.DB_TYPE || "postgres").toLowerCase();
      const dbHost = merged.DB_HOST;
      const dbPort = parseInt(merged.DB_PORT || "5432");
      const dbName = merged.DB_NAME;
      const dbUser = merged.DB_USER;
      const dbPass = merged.DB_PASS;
      const dbSsl  = merged.DB_SSL === "true";

      if (!dbHost || !dbName) {
        sseSend(res, "error", { message: "DB_HOST and DB_NAME are required to validate the database connection" });
        return res.end();
      }

      try {
        if (dbType === "postgres") {
          const { Client } = require("pg");
          const pg = new Client({
            host: dbHost, port: dbPort, database: dbName,
            user: dbUser, password: dbPass,
            ssl: dbSsl ? { rejectUnauthorized: false } : false,
            connectionTimeoutMillis: 6000
          });
          await pg.connect();
          await pg.end();
          sseSend(res, "progress", { message: `Database connected successfully ✓  (${dbHost}/${dbName})` });
          mergedCreds = merged;  // pass full creds to cube generator
        } else {
          sseSend(res, "progress", { message: `DB type '${dbType}' — connection check skipped` });
        }
      } catch (dbErr) {
        sseSend(res, "error", { message: `Database connection failed: ${dbErr.message}` });
        return res.end();
      }
    }

    // ── Step 3: save to Atlas ────────────────────────────────────────────────
    sseSend(res, "progress", { message: "Saving credentials to config store..." });
    const result = await atlasClient.db(cfgDb).collection(cfgCol).updateOne(
      { _id: new ObjectId(docId) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      sseSend(res, "error", { message: `Config document ${docId} not found` });
      return res.end();
    }
    sseSend(res, "progress", { message: `${Object.keys(updates).length} credential(s) saved ✓` });

    // ── Step 4: generate cube files from the connected DB ───────────────────
    let cubesGenerated = [];
    let cubesDeleted = [];
    if (mergedCreds) {
      const { generated, deleted } = await generateCubesFromDB(res, mergedCreds);
      cubesGenerated = generated;
      cubesDeleted = deleted;
    }

    sseSend(res, "done", {
      status: "ok",
      message: cubesGenerated.length
        ? `Credentials saved and ${cubesGenerated.length} cube(s) created`
        : `${Object.keys(updates).length} credential(s) updated successfully`,
      updated: Object.keys(updates),
      cubesGenerated: cubesGenerated.length ? cubesGenerated : undefined,
      cubesDeleted: cubesDeleted.length ? cubesDeleted : undefined
    });
  } catch (err) {
    sseSend(res, "error", { message: err.message });
  } finally {
    if (atlasClient) await atlasClient.close().catch(() => {});
    res.end();
  }
});

// ── LLM context endpoints (plain JSON — no SSE) ───────────────────────────────
// Context fields live in the MongoDB Atlas config document.
// Set them once via POST /context, then /ask and /enrich read them from there.

// GET /context — read all three context fields from MongoDB
app.get("/context", async (req, res) => {
  const cfgUri = process.env.CONFIG_MONGO_URI;
  const cfgDb  = process.env.CONFIG_MONGO_DB  || "cubedev";
  const cfgCol = process.env.CONFIG_COLLECTION || "cubedev";
  const docId  = process.env.CONFIG_DOC_ID;

  if (!cfgUri || !docId) {
    return res.status(500).json({ error: "Config store not configured" });
  }

  let client;
  try {
    client = new MongoClient(cfgUri);
    await client.connect();
    const doc = await client.db(cfgDb).collection(cfgCol).findOne(
      { _id: new ObjectId(docId) },
      { projection: { LLM_CONTEXT: 1, LLM_RETRY_CONTEXT: 1, ENRICH_CONTEXT: 1 } }
    );
    res.json({
      LLM_CONTEXT:       doc?.LLM_CONTEXT       || null,
      LLM_RETRY_CONTEXT: doc?.LLM_RETRY_CONTEXT || null,
      ENRICH_CONTEXT:    doc?.ENRICH_CONTEXT    || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});

// POST /context — save one or more context fields to MongoDB.
// Body: { LLM_CONTEXT?, LLM_RETRY_CONTEXT?, ENRICH_CONTEXT? }
// Placeholders:
//   LLM_CONTEXT       → {{SCHEMA}}  {{QUESTION}}
//   LLM_RETRY_CONTEXT → {{SCHEMA}}  {{QUESTION}}  {{PREVIOUS_QUERY}}  {{CUBE_ERROR}}
//   ENRICH_CONTEXT    → {{FILE_NAME}}  {{FILE_CONTENT}}  {{ISSUES_SECTION}}  {{ALL_CUBE_NAMES}}
app.post("/context", async (req, res) => {
  const cfgUri = process.env.CONFIG_MONGO_URI;
  const cfgDb  = process.env.CONFIG_MONGO_DB  || "cubedev";
  const cfgCol = process.env.CONFIG_COLLECTION || "cubedev";
  const docId  = process.env.CONFIG_DOC_ID;

  if (!cfgUri || !docId) {
    return res.status(500).json({ error: "Config store not configured" });
  }

  const ALLOWED = ["LLM_CONTEXT", "LLM_RETRY_CONTEXT", "ENRICH_CONTEXT"];
  const updates = {};
  for (const key of ALLOWED) {
    if (typeof req.body?.[key] === "string" && req.body[key].trim()) {
      updates[key] = req.body[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({
      error: "No valid fields provided",
      allowedFields: ALLOWED,
      placeholders: {
        LLM_CONTEXT:       ["{{SCHEMA}}", "{{QUESTION}}"],
        LLM_RETRY_CONTEXT: ["{{SCHEMA}}", "{{QUESTION}}", "{{PREVIOUS_QUERY}}", "{{CUBE_ERROR}}"],
        ENRICH_CONTEXT:    ["{{FILE_NAME}}", "{{FILE_CONTENT}}", "{{ISSUES_SECTION}}", "{{ALL_CUBE_NAMES}}"]
      }
    });
  }

  let client;
  try {
    client = new MongoClient(cfgUri);
    await client.connect();
    const result = await client.db(cfgDb).collection(cfgCol).updateOne(
      { _id: new ObjectId(docId) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: `Config document ${docId} not found` });
    }

    invalidateContextCache(); // next /ask re-fetches immediately
    res.json({
      status:  "ok",
      message: `${Object.keys(updates).length} context field(s) updated`,
      updated: Object.keys(updates)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// POST /enrich — run the enrich-cubes.js script (generate cubes, apply fixes, LLM enrichment, save catalog)
// Optional body: { "staticOnly": true } to skip LLM and only apply static fixes
app.post("/enrich", (req, res) => {
  const args = ["/app/scripts/enrich-cubes.js"];
  if (req.body?.staticOnly) args.push("--static-only");
  if (req.body?.dryRun)     args.push("--dry-run");
  if (req.body?.cube)       args.push(`--cube=${req.body.cube}`);

  const child = spawn("node", args, {
    env: { ...process.env },
    cwd: "/app"
  });

  let output = "";
  child.stdout.on("data", (d) => { process.stdout.write(d); output += d; });
  child.stderr.on("data", (d) => { process.stderr.write(d); output += d; });

  child.on("close", (code) => {
    const status = code === 0 ? "ok" : "error";
    res.status(code === 0 ? 200 : 500).json({ status, exitCode: code, output });

    // Reload the catalog so changes are picked up immediately
    if (code === 0) {
      catalog.refresh().catch((err) => console.warn("Catalog reload after enrich failed:", err.message));
    }
  });

  child.on("error", (err) => {
    res.status(500).json({ status: "error", error: err.message });
  });
});

// POST /catalog/refresh — force-reload the DuckDB schema cache from Cube
app.post("/catalog/refresh", async (req, res) => {
  try {
    await catalog.refresh();
    res.json({ status: "ok", reloadedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  GET  /meta`);
  console.log(`  POST /query             → direct Cube query`);
  console.log(`  POST /ask               → natural language (LLM required)`);
  console.log(`  POST /catalog/refresh   → reload schema cache`);
  console.log(`  POST /config            → save LLM/DB credentials + generate cubes`);
  console.log(`  GET  /context           → read LLM prompt context from Atlas`);
  console.log(`  POST /context           → update LLM prompt context in Atlas`);
  console.log(`  POST /enrich            → run enrich-cubes.js (static fixes + LLM enrichment)`);
  console.log(`LLM provider: ${process.env.LLM_PROVIDER || "not set"}`);

  // Warm the catalog so the first /ask isn't slow.
  catalog
    .ensureLoaded()
    .then(() => console.log("Schema catalog warmed"))
    .catch((err) => console.warn(`Catalog warm-up deferred: ${err.message}`));
});
