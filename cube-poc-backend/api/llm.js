const axios = require("axios");

const PROVIDERS = {
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o",
    headers: () => ({
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      "content-type": "application/json"
    }),
    buildBody: (model, prompt) => ({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    }),
    extractText: (res) => res.data.choices[0].message.content
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-sonnet-4-6",
    headers: () => ({
      "x-api-key": process.env.LLM_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    }),
    buildBody: (model, prompt) => ({
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }]
    }),
    extractText: (res) => res.data.content[0].text
  }
};

// ── Schema context builder ────────────────────────────────────────────────────
function buildSchemaContext(meta) {
  return meta.cubes.map(cube => {
    const timeDims  = cube.dimensions.filter(d => d.type === "time").map(d => d.name);
    const otherDims = cube.dimensions.filter(d => d.type !== "time").map(d => `${d.name} (${d.type})`);
    return {
      cube: cube.name,
      measures: cube.measures.map(m => `${m.name} (${m.type})`),
      dimensions: otherDims,
      timeDimensions: timeDims
    };
  });
}

// ── MongoDB context cache ─────────────────────────────────────────────────────
// Fetched once per minute; invalidated immediately after a POST /context save.
// LLM_CONTEXT, LLM_RETRY_CONTEXT must be set in the MongoDB config document
// via POST /context before /ask will work.
let _ctxCache    = null;
let _ctxCachedAt = 0;
const CTX_TTL_MS = 60_000;

async function loadContextFromMongo() {
  const now = Date.now();
  if (_ctxCache && (now - _ctxCachedAt) < CTX_TTL_MS) return _ctxCache;

  const uri   = process.env.CONFIG_MONGO_URI;
  const docId = process.env.CONFIG_DOC_ID;
  if (!uri || !docId) return {};

  const { MongoClient, ObjectId } = require("mongodb");
  const dbName = process.env.CONFIG_MONGO_DB  || "cubedev";
  const col    = process.env.CONFIG_COLLECTION || "cubedev";
  let client;
  try {
    client = new MongoClient(uri);
    await client.connect();
    const doc = await client.db(dbName).collection(col).findOne(
      { _id: new ObjectId(docId) },
      { projection: { LLM_CONTEXT: 1, LLM_RETRY_CONTEXT: 1 } }
    );
    const ctx = {
      main:  doc?.LLM_CONTEXT       || null,
      retry: doc?.LLM_RETRY_CONTEXT || null
    };
    _ctxCache    = ctx;
    _ctxCachedAt = now;
    return ctx;
  } catch (err) {
    console.warn("LLM context fetch from MongoDB failed:", err.message);
    return _ctxCache || {};
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

function invalidateContextCache() {
  _ctxCache    = null;
  _ctxCachedAt = 0;
}

// ── Template engine ───────────────────────────────────────────────────────────
function applyTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{{${k}}}`, v),
    template
  );
}

function buildPrompt(question, schema, template) {
  if (!template) throw new Error("LLM_CONTEXT not set — configure it via POST /context");
  return applyTemplate(template, {
    SCHEMA:   JSON.stringify(schema, null, 2),
    QUESTION: question
  });
}

function buildRetryPrompt(question, schema, previousQuery, cubeError, template) {
  if (!template) throw new Error("LLM_RETRY_CONTEXT not set — configure it via POST /context");
  return applyTemplate(template, {
    SCHEMA:         JSON.stringify(schema, null, 2),
    QUESTION:       question,
    PREVIOUS_QUERY: JSON.stringify(previousQuery, null, 2),
    CUBE_ERROR:     cubeError
  });
}

// ── Response parser ───────────────────────────────────────────────────────────
function parseQueryFromText(text) {
  const cleaned = text.replace(/```json\n?/gi, "").replace(/```\n?/gi, "").trim();
  const match   = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM did not return valid JSON");
  return JSON.parse(match[0]);
}

// ── Streaming entry point ─────────────────────────────────────────────────────
// Calls onToken(text) for every streamed chunk so the caller can forward
// partial output to the UI in real time via SSE.
async function streamLLM(question, cubeMeta, onToken, retryContext = null) {
  const providerName = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  const provider     = PROVIDERS[providerName];

  if (!provider) throw new Error(`Unknown LLM provider "${providerName}". Supported: ${Object.keys(PROVIDERS).join(", ")}`);
  if (!process.env.LLM_API_KEY) throw new Error("LLM_API_KEY is not set. Add it via POST /config.");

  const model    = process.env.LLM_MODEL || provider.defaultModel;
  const schema   = buildSchemaContext(cubeMeta);
  const mongoCtx = await loadContextFromMongo();

  const prompt = retryContext
    ? buildRetryPrompt(question, schema, retryContext.previousQuery, retryContext.cubeError, mongoCtx.retry)
    : buildPrompt(question, schema, mongoCtx.main);

  const url     = typeof provider.url === "function" ? provider.url() : provider.url;
  let fullText  = "";

  if (providerName === "openai") {
    const body     = { ...provider.buildBody(model, prompt), stream: true };
    const response = await axios.post(url, body, {
      headers: provider.headers(),
      responseType: "stream",
      timeout: 60000
    });

    await new Promise((resolve, reject) => {
      let buf = "";
      response.data.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const token = JSON.parse(raw).choices?.[0]?.delta?.content;
            if (token) { fullText += token; onToken(token); }
          } catch {}
        }
      });
      response.data.on("end",   resolve);
      response.data.on("error", reject);
    });

  } else if (providerName === "anthropic") {
    const body     = { ...provider.buildBody(model, prompt), stream: true };
    const response = await axios.post(url, body, {
      headers: provider.headers(),
      responseType: "stream",
      timeout: 60000
    });

    await new Promise((resolve, reject) => {
      let buf = "";
      response.data.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          try {
            const token = JSON.parse(raw)?.delta?.text;
            if (token) { fullText += token; onToken(token); }
          } catch {}
        }
      });
      response.data.on("end",   resolve);
      response.data.on("error", reject);
    });

  } else {
    // Unknown provider — non-streaming fallback
    const response = await axios.post(url, provider.buildBody(model, prompt), {
      headers: provider.headers(),
      timeout: 30000
    });
    fullText = provider.extractText(response);
    onToken(fullText);
  }

  const parsed = parseQueryFromText(fullText);
  return { cubeQuery: parsed, model: `${providerName}/${model}` };
}

// ── Non-streaming entry point (kept for internal use) ─────────────────────────
async function askLLM(question, cubeMeta, retryContext = null) {
  const providerName = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  const provider     = PROVIDERS[providerName];

  if (!provider) throw new Error(`Unknown LLM provider "${providerName}". Supported: ${Object.keys(PROVIDERS).join(", ")}`);
  if (!process.env.LLM_API_KEY) throw new Error("LLM_API_KEY is not set. Add it via POST /config.");

  const model    = process.env.LLM_MODEL || provider.defaultModel;
  const schema   = buildSchemaContext(cubeMeta);
  const mongoCtx = await loadContextFromMongo();

  const prompt = retryContext
    ? buildRetryPrompt(question, schema, retryContext.previousQuery, retryContext.cubeError, mongoCtx.retry)
    : buildPrompt(question, schema, mongoCtx.main);

  const url      = typeof provider.url === "function" ? provider.url() : provider.url;
  const response = await axios.post(url, provider.buildBody(model, prompt), {
    headers: provider.headers(),
    timeout: 30000
  });

  const text   = provider.extractText(response);
  const parsed = parseQueryFromText(text);
  return { cubeQuery: parsed, model: `${providerName}/${model}` };
}

module.exports = { askLLM, streamLLM, invalidateContextCache };
