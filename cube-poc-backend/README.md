# cubedev

```bash
# 1. Connection update (validates DB, saves creds, generates cubes)
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{
    "DB_TYPE": "postgres",
    "DB_HOST": "db.example.com",
    "DB_PORT": "5432",
    "DB_NAME": "mydb",
    "DB_USER": "admin",
    "DB_PASS": "secret",
    "DB_SCHEMA": "public",
    "LLM_PROVIDER": "openai",
    "LLM_API_KEY": "sk-...",
    "LLM_MODEL": "gpt-4o"
  }'

# 2. LLM cube creation context update
curl -X POST http://localhost:3000/context \
  -H "Content-Type: application/json" \
  -d '{"ENRICH_CONTEXT": "...prompt with {{FILE_NAME}} {{FILE_CONTENT}} {{ISSUES_SECTION}} {{ALL_CUBE_NAMES}}..."}'

# 3. LLM context for ask query update
curl -X POST http://localhost:3000/context \
  -H "Content-Type: application/json" \
  -d '{"LLM_CONTEXT": "...prompt with {{SCHEMA}} and {{QUESTION}}..."}'

# 4. Ask query
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "how many orders per state?"}'

# 5. Get LLM enrich context
curl http://localhost:3000/context | jq '.ENRICH_CONTEXT'

# 6. Get LLM ask query context
curl http://localhost:3000/context | jq '.LLM_CONTEXT'
```
