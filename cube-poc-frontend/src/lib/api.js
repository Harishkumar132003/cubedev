// Resolved at build time by Vite.
// Dev (vite dev server)   → http://localhost:3000   (talk to the API directly)
// Prod (built static site) → /api                   (proxied by nginx)
// Override either by setting VITE_API_BASE in a .env file.
export const API_BASE =
  import.meta.env.VITE_API_BASE ||
  (import.meta.env.DEV ? 'http://localhost:3000' : '/api')
