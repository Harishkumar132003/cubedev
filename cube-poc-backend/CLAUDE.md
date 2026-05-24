# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A POC that turns natural-language questions into Cube.dev queries against a PostgreSQL database (the Brazilian Olist e-commerce dataset). Request flow:

```
client -> Express API (:3000) -> Cube.dev (:4000) -> PostgreSQL (external)
                |
                +-- /ask: question
                |     -> DuckDB FTS catalog picks relevant cubes
                |     -> LLM gets ONLY that slice + question
                |     -> Cube query JSON -> run on Cube
                +-- /query: caller supplies the Cube query JSON directly
```

## Commands

```bash
# Start the stack (cube + api). LLM_* are read from ./.env
docker compose up -d

# After editing api/*.js, rebuild the api container (cube hot-reloads schema)
docker compose build api && docker compose up -d api

# Logs
docker compose logs -f api
docker compose logs -f cube

# Stop / reset
docker compose down
docker compose down -v   # also drops the cubestore volume

# Smoke test
curl http://localhost:3000/health
curl http://localhost:3000/meta            # raw Cube schema
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"query":{"measures":["orders.count"],"dimensions":["customers.customer_state"]}}'
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"how many orders per state?"}'

# Force-rebuild the DuckDB catalog after editing cube/schema/*
curl -X POST http://localhost:3000/catalog/refresh
```

There is no test suite, linter, or build step beyond the Docker image build.

## Architecture notes

**Two services, external Postgres.** `docker-compose.yml` only defines `cube` and `api`. Postgres is **not** containerized — Cube connects to an external host configured in `docker-compose.yml` (`CUBEJS_DB_HOST`). The README still describes a bundled Postgres + CSV loader; that setup is gone, so trust the compose file, not the README.

**API endpoints** (in [api/index.js](api/index.js)):
- `GET /health` — also reports LLM config and Cube reachability.
- `GET /meta` — proxies Cube's `/cubejs-api/v1/meta` (cubes, measures, dimensions). Used both by callers and internally by `/ask` to build the LLM prompt.
- `POST /query` — body `{ query: <CubeQuery> }`. Passes through to Cube unchanged. No LLM involved.
- `POST /ask` — body `{ question: "..." }`. Retrieves the relevant schema subset via the DuckDB catalog (see below), asks the LLM to emit a Cube query JSON, then runs it. Response includes a `retrieval` block (`cubesSent`, `matchedMembers`, `fallbackUsed`) for debugging recall. Requires `LLM_API_KEY`.
- `POST /catalog/refresh` — force-rebuilds the DuckDB catalog from Cube `/meta`. Call after schema edits if you don't want to wait for the TTL.

**Schema retrieval layer** ([api/catalog.js](api/catalog.js)). An in-process DuckDB instance holds one row per cube member (`measure` / `dimension` / `timeDimension`) with a BM25 FTS index on the concatenated `cube + member + title + description`. On `/ask`:
1. Sanitize the question (lowercase, strip punctuation).
2. `fts_main_members.match_bm25` returns the top-K matching members (default `maxMembers=30`).
3. Collect the distinct cubes those members belong to, capped at `maxCubes=5`, preserving match-rank order.
4. Return the **full** measure/dimension list for those cubes (not just the matching members) — the LLM needs the complete shape of each cube it's allowed to query.
5. If FTS returns zero hits, fall back to sending all cubes — degrades to pre-DuckDB behavior instead of failing silently. The `retrieval.fallbackUsed` flag in the response surfaces this.

Catalog is loaded lazily on first `/ask`, refreshed when stale (`CATALOG_TTL_MS`, default 5 min), and warmed once at server start. A single-flight guard (`loadPromise`) prevents concurrent rebuilds. Recall is currently weak for synonym-style queries ("revenue" won't match `totalPrice`) because cube definitions have no `title`/`description` fields — adding them is the cheapest way to improve retrieval quality.

**Cube auth.** Every Cube request is signed with a short-lived JWT minted from `CUBE_API_SECRET`. The same secret must be set on both the `api` and `cube` services in `docker-compose.yml` (currently `mysecretkey123`).

**LLM layer** ([api/llm.js](api/llm.js)). Provider registry pattern: each provider declares `url`, `headers()`, `buildBody()`, `extractText()`. Only `openai` is implemented today, even though `LLM_PROVIDER` defaults to `"anthropic"` in `askLLM` — set `LLM_PROVIDER=openai` in `.env` or add an `anthropic` entry to `PROVIDERS` before relying on the default. `buildSchemaContext()` strips Cube meta down to `{cube, measures, dimensions}` before prompting; if you add fields the LLM should see (e.g. descriptions), extend it there. `parseQueryFromText()` tolerates ```json fences and extracts the first `{...}` block.

**Cube schema** lives in [cube/schema/](cube/schema/) and is mounted into the container at `/cube/conf`. Files under `cubes/` define one cube per source table (Olist dataset: `orders`, `customers`, `order_items`, `products`, `sellers`, `geolocation`, `order_payments`, `order_reviews`, `product_category_name_translation`). Joins are declared on the "many" side (e.g. `order_items` joins to `orders`, `products`, `sellers`). To expose a curated subset to the LLM or BI tools, add a view under `cube/schema/views/` (see `example_view.yml` for the syntax). Cube watches this directory in dev mode — no restart needed after schema edits.

**Stale file.** [api/queryMapper.js](api/queryMapper.js) is a tombstone for the old rule-based NL mapper; safe to ignore or delete.

## Configuration

`.env` (gitignored) supplies `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` to the `api` container via docker-compose variable substitution. DB credentials and `CUBEJS_API_SECRET` are hardcoded in `docker-compose.yml`.
