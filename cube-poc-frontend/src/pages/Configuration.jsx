import { useEffect, useState } from 'react'
import { streamSSE } from '../lib/sse.js'
import { API_BASE } from '../lib/api.js'

const HEALTH_URL = `${API_BASE}/health`
const CONFIG_URL = `${API_BASE}/config`

function Configuration() {
  const [values, setValues] = useState({
    LLM_PROVIDER: '',
    LLM_API_KEY: '',
    LLM_MODEL: '',
  })
  const [keyConfigured, setKeyConfigured] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [loading, setLoading] = useState(true)

  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState([])
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetch(HEALTH_URL)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const llm = data?.llm || {}
        setValues((v) => ({
          ...v,
          LLM_PROVIDER: llm.provider && llm.provider !== 'not configured' ? llm.provider : '',
          LLM_MODEL: llm.model && llm.model !== 'default' ? llm.model : '',
        }))
        setKeyConfigured(!!llm.ready)
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const update = (field) => (e) =>
    setValues((v) => ({ ...v, [field]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()

    const body = {}
    if (values.LLM_PROVIDER.trim()) body.LLM_PROVIDER = values.LLM_PROVIDER.trim()
    if (values.LLM_API_KEY.trim()) body.LLM_API_KEY = values.LLM_API_KEY.trim()
    if (values.LLM_MODEL.trim()) body.LLM_MODEL = values.LLM_MODEL.trim()

    if (Object.keys(body).length === 0) {
      setError('Fill at least one field.')
      return
    }

    setSubmitting(true)
    setProgress([])
    setResult(null)
    setError(null)

    try {
      for await (const event of streamSSE(CONFIG_URL, body)) {
        if (event.type === 'progress') {
          setProgress((p) => [...p, event.message])
        } else if (event.type === 'done') {
          setResult(event)
          if (body.LLM_API_KEY) setKeyConfigured(true)
          setValues((v) => ({ ...v, LLM_API_KEY: '' }))
        } else if (event.type === 'error') {
          setError(event.message || 'Unknown error')
        }
      }
    } catch (err) {
      setError(err.message || 'Request failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="card page-loading">
        <span className="spinner" />
        <span>Loading current settings…</span>
      </div>
    )
  }

  return (
    <div className="card">
      <h1 className="title">LLM Configuration</h1>
      <p className="subtitle">
        Update your LLM provider, API key, and model. Leave a field blank to
        keep the existing value.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="form-fields">
          <label className="field">
            <span>LLM Provider</span>
            <input
              type="text"
              value={values.LLM_PROVIDER}
              onChange={update('LLM_PROVIDER')}
              placeholder="e.g. openai"
              disabled={submitting}
            />
          </label>

          <label className="field">
            <span>
              API Key{' '}
              {keyConfigured && (
                <span className="field-tag">configured</span>
              )}
            </span>
            <div className="password-wrap">
              <input
                type={showKey ? 'text' : 'password'}
                value={values.LLM_API_KEY}
                onChange={update('LLM_API_KEY')}
                placeholder={keyConfigured ? '••••••••  (leave blank to keep)' : 'sk-...'}
                disabled={submitting}
              />
              <button
                type="button"
                className="eye-btn"
                onClick={() => setShowKey((s) => !s)}
                aria-label="Toggle key visibility"
                disabled={submitting}
              >
                {showKey ? '🙈' : '👁'}
              </button>
            </div>
          </label>

          <label className="field">
            <span>Model</span>
            <input
              type="text"
              value={values.LLM_MODEL}
              onChange={update('LLM_MODEL')}
              placeholder="e.g. gpt-4o"
              disabled={submitting}
            />
          </label>

          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      {submitting && (
        <div className="config-progress">
          <div className="config-progress-title">
            <span className="spinner" />
            <span>Updating configuration</span>
          </div>
          <ul className="config-list">
            {progress.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
            {progress.length === 0 && <li className="muted">Starting…</li>}
          </ul>
        </div>
      )}

      {result && !submitting && (
        <div className="banner banner-success">
          <strong>✓ Saved.</strong> {result.message}
          {result.updated?.length > 0 && (
            <span className="muted"> — Updated: {result.updated.join(', ')}</span>
          )}
        </div>
      )}

      {error && !submitting && (
        <div className="banner banner-error">
          <strong>!</strong> {error}
        </div>
      )}
    </div>
  )
}

export default Configuration
