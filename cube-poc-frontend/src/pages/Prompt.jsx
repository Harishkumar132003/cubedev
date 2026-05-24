import { useEffect, useState } from 'react'
import { API_BASE } from '../lib/api.js'

const CONTEXT_URL = `${API_BASE}/context`

const PROMPT_FIELDS = [
  {
    key: 'LLM_CONTEXT',
    label: 'Ask prompt',
    short: 'Used by /ask',
    description:
      'Turns the user’s natural-language question into a Cube query. Receives the relevant schema and the question.',
    placeholders: ['{{SCHEMA}}', '{{QUESTION}}'],
  },
  {
    key: 'LLM_RETRY_CONTEXT',
    label: 'Retry prompt',
    short: 'Used after a failed query',
    description:
      'Asks the LLM to self-correct after the first query fails. Receives the schema, question, previous query, and Cube error.',
    placeholders: ['{{SCHEMA}}', '{{QUESTION}}', '{{PREVIOUS_QUERY}}', '{{CUBE_ERROR}}'],
  },
  {
    key: 'ENRICH_CONTEXT',
    label: 'Enrich prompt',
    short: 'Used by /enrich',
    description:
      'Improves a generated cube file. Receives the file name, file content, validator issues, and all cube names.',
    placeholders: ['{{FILE_NAME}}', '{{FILE_CONTENT}}', '{{ISSUES_SECTION}}', '{{ALL_CUBE_NAMES}}'],
  },
]

function Prompt() {
  const [values, setValues] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [selectedKey, setSelectedKey] = useState(PROMPT_FIELDS[0].key)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetch(CONTEXT_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`Load failed: ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (cancelled) return
        setValues({
          LLM_CONTEXT: data.LLM_CONTEXT || '',
          LLM_RETRY_CONTEXT: data.LLM_RETRY_CONTEXT || '',
          ENRICH_CONTEXT: data.ENRICH_CONTEXT || '',
        })
      })
      .catch((err) => !cancelled && setLoadError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const selectedField = PROMPT_FIELDS.find((f) => f.key === selectedKey)
  const selectedValue = values[selectedKey] || ''

  const selectPrompt = (key) => {
    if (editing && key !== selectedKey) {
      const ok = confirm('Discard unsaved changes?')
      if (!ok) return
    }
    setSelectedKey(key)
    setEditing(false)
    setDraft('')
    setFeedback(null)
  }

  const startEdit = () => {
    setDraft(selectedValue)
    setEditing(true)
    setFeedback(null)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft('')
  }

  const save = async () => {
    if (draft.trim() === selectedValue.trim()) {
      setEditing(false)
      setFeedback({ kind: 'info', message: 'No changes to save.' })
      return
    }

    setSaving(true)
    setFeedback(null)

    try {
      const res = await fetch(CONTEXT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [selectedKey]: draft }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Save failed: ${res.status}`)
      setValues((v) => ({ ...v, [selectedKey]: draft }))
      setEditing(false)
      setDraft('')
      setFeedback({ kind: 'success', message: data.message || 'Prompt updated.' })
    } catch (err) {
      setFeedback({ kind: 'error', message: err.message || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="card page-loading">
        <span className="spinner" />
        <span>Loading prompts…</span>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="card error-card">
        <div className="error-icon">!</div>
        <h2>Couldn’t load prompts</h2>
        <p className="muted">{loadError}</p>
      </div>
    )
  }

  return (
    <div className="card prompt-card">
      <header className="prompt-header">
        <h1 className="title">LLM Prompts</h1>
        <p className="subtitle">
          Pick a prompt on the left to view or edit it.
        </p>
      </header>

      <div className="prompt-layout">
        <nav className="prompt-list">
          {PROMPT_FIELDS.map((f) => {
            const filled = (values[f.key] || '').trim().length > 0
            return (
              <button
                key={f.key}
                type="button"
                className={`prompt-list-item${
                  f.key === selectedKey ? ' active' : ''
                }`}
                onClick={() => selectPrompt(f.key)}
              >
                <div className="prompt-list-row">
                  <span className="prompt-list-name">{f.label}</span>
                  {filled ? (
                    <span className="dot dot-on" title="Set" />
                  ) : (
                    <span className="dot dot-off" title="Empty" />
                  )}
                </div>
                <span className="prompt-list-short">{f.short}</span>
              </button>
            )
          })}
        </nav>

        <section className="prompt-detail">
          <div className="prompt-detail-header">
            <div>
              <h2>{selectedField.label}</h2>
              <p className="muted">{selectedField.description}</p>
            </div>
            {!editing && (
              <button
                type="button"
                className="btn-ghost"
                onClick={startEdit}
              >
                Edit
              </button>
            )}
          </div>

          <div className="placeholder-row">
            {selectedField.placeholders.map((p) => (
              <code key={p} className="placeholder-chip">
                {p}
              </code>
            ))}
          </div>

          {editing ? (
            <>
              <textarea
                className="prompt-textarea"
                rows={16}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={saving}
                placeholder={`Enter the ${selectedField.label.toLowerCase()}…`}
                autoFocus
              />
              <div className="prompt-actions">
                <button
                  type="button"
                  className="link-btn"
                  onClick={cancelEdit}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={save}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          ) : selectedValue ? (
            <pre className="prompt-view">{selectedValue}</pre>
          ) : (
            <div className="prompt-empty">
              <p>No prompt set.</p>
              <button
                type="button"
                className="btn-primary"
                onClick={startEdit}
              >
                Add prompt
              </button>
            </div>
          )}

          {feedback && !editing && (
            <div className={`banner banner-${feedback.kind}`}>
              <strong>
                {feedback.kind === 'success' ? '✓' : feedback.kind === 'error' ? '!' : 'ℹ'}
              </strong>{' '}
              {feedback.message}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Prompt
