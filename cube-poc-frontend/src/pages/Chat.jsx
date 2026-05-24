import { useEffect, useRef, useState } from 'react'
import ResultViewer from '../components/ResultViewer.jsx'
import { streamSSE } from '../lib/sse.js'
import { API_BASE } from '../lib/api.js'

const API_URL = `${API_BASE}/ask`

const STEP_LABELS = {
  schema: 'Searching schema',
  llm: 'Generating query',
  validate: 'Validating',
  execute: 'Running query',
  retry: 'Retrying',
}

function ProgressList({ items, running }) {
  if (!items || items.length === 0) return null
  return (
    <ul className="progress-list">
      {items.map((p, i) => {
        const isLast = i === items.length - 1
        const showSpinner = running && isLast
        return (
          <li key={i} className={`progress-item${showSpinner ? ' active' : ''}`}>
            <span className="progress-marker">
              {showSpinner ? <span className="spinner" /> : '✓'}
            </span>
            <span className="progress-text">
              {p.step && (
                <span className="progress-step">{STEP_LABELS[p.step] || p.step}</span>
              )}
              <span>{p.message}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function TokenStream({ text }) {
  if (!text) return null
  return (
    <div className="token-stream">
      <div className="token-stream-label">Cube query (streaming)</div>
      <pre>{text}</pre>
    </div>
  )
}

function AssistantMessage({ msg }) {
  const { status, progress, tokens, payload, error, clarification } = msg

  if (status === 'error') {
    return (
      <div className="msg msg-error">
        <div className="msg-bubble">{error}</div>
      </div>
    )
  }

  if (status === 'clarification') {
    return (
      <div className="msg msg-assistant">
        <div className="msg-bubble msg-clarify">
          <div className="msg-clarify-label">Needs clarification</div>
          <p>{clarification}</p>
        </div>
      </div>
    )
  }

  const isStreaming = status === 'streaming'

  return (
    <div className="msg msg-assistant">
      <div className="msg-bubble">
        {isStreaming ? (
          <>
            <ProgressList items={progress} running />
            <TokenStream text={tokens} />
          </>
        ) : (
          <>
            <ResultViewer rows={payload?.result || []} />
            <div className="msg-meta">
              {payload?.model && <span className="msg-badge">{payload.model}</span>}
              {payload?.meta?.rowCount != null && (
                <span className="msg-badge">{payload.meta.rowCount} rows</span>
              )}
              {payload?.meta?.retried && (
                <span className="msg-badge msg-badge-warn">retried</span>
              )}
              {progress.length > 0 && (
                <details className="msg-details">
                  <summary>Steps ({progress.length})</summary>
                  <ProgressList items={progress} running={false} />
                </details>
              )}
              {payload?.cubeQuery && (
                <details className="msg-details">
                  <summary>Cube query</summary>
                  <pre>{JSON.stringify(payload.cubeQuery, null, 2)}</pre>
                </details>
              )}
              {payload?.retrieval?.cubesSent?.length > 0 && (
                <details className="msg-details">
                  <summary>Cubes ({payload.retrieval.cubesSent.join(', ')})</summary>
                  <pre>{JSON.stringify(payload.retrieval, null, 2)}</pre>
                </details>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function newAssistantMsg(id) {
  return {
    id,
    role: 'assistant',
    status: 'streaming',
    progress: [],
    tokens: '',
    payload: null,
    error: null,
    clarification: null,
  }
}

function applyEvent(msg, event) {
  switch (event.type) {
    case 'progress':
      return {
        ...msg,
        progress: [...msg.progress, { step: event.step, message: event.message }],
      }
    case 'token':
      return { ...msg, tokens: msg.tokens + (event.text || '') }
    case 'clarification':
      return {
        ...msg,
        status: 'clarification',
        clarification: event.message,
        retrieval: event.retrieval,
      }
    case 'done':
      return { ...msg, status: 'done', payload: event }
    case 'error':
      return { ...msg, status: 'error', error: event.message || 'Unknown error' }
    default:
      return msg
  }
}

function Chat() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const scrollerRef = useRef(null)
  const abortRef = useRef(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const send = async (e) => {
    e.preventDefault()
    const question = input.trim()
    if (!question || streaming) return

    setInput('')
    const userId = `u-${Date.now()}`
    const assistantId = `a-${Date.now()}`

    setMessages((m) => [
      ...m,
      { id: userId, role: 'user', text: question },
      newAssistantMsg(assistantId),
    ])
    setStreaming(true)

    const updateAssistant = (event) =>
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? applyEvent(msg, event) : msg)),
      )

    const controller = new AbortController()
    abortRef.current = controller

    try {
      for await (const event of streamSSE(
        API_URL,
        { question },
        { signal: controller.signal },
      )) {
        updateAssistant(event)
      }
      setMessages((m) =>
        m.map((msg) => {
          if (msg.id !== assistantId) return msg
          if (msg.status === 'streaming') {
            return { ...msg, status: 'error', error: 'Stream ended unexpectedly.' }
          }
          return msg
        }),
      )
    } catch (err) {
      if (err.name === 'AbortError') return
      setMessages((m) =>
        m.map((msg) =>
          msg.id === assistantId
            ? { ...msg, status: 'error', error: err.message || 'Request failed.' }
            : msg,
        ),
      )
    } finally {
      abortRef.current = null
      setStreaming(false)
    }
  }

  const stop = () => abortRef.current?.abort()

  return (
    <div className="chat">
      <header className="chat-header">
        <h1>Ask your data</h1>
        <p className="muted">
          Ask questions in plain English — answers come from your connected Cube.
        </p>
      </header>

      <div className="chat-scroller" ref={scrollerRef}>
        {messages.length === 0 && !streaming && (
          <div className="chat-empty">
            <p>Try something like:</p>
            <ul>
              <li>How many orders per state?</li>
              <li>What is the total revenue this month?</li>
              <li>Top 5 customers by order count</li>
            </ul>
          </div>
        )}

        {messages.map((m) => {
          if (m.role === 'user') {
            return (
              <div key={m.id} className="msg msg-user">
                <div className="msg-bubble">{m.text}</div>
              </div>
            )
          }
          return <AssistantMessage key={m.id} msg={m} />
        })}
      </div>

      <form className="chat-input-row" onSubmit={send}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about your data..."
          disabled={streaming}
        />
        {streaming ? (
          <button type="button" className="btn-stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  )
}

export default Chat
