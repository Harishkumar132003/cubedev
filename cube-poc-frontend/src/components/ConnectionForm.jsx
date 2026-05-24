import { useState } from 'react'

function ConnectionForm({ db, onChange, onSubmit, submitting = false }) {
  const [values, setValues] = useState({
    host: '',
    port: db.defaultPort || '',
    database: '',
    username: '',
    password: '',
  })
  const [showPassword, setShowPassword] = useState(false)

  const update = (field) => (e) =>
    setValues((v) => ({ ...v, [field]: e.target.value }))

  const handleSubmit = (e) => {
    e.preventDefault()
    onSubmit(values)
  }

  return (
    <form onSubmit={handleSubmit}>
      <h1 className="title">Set Up a Database connection</h1>

      <div className="selected-db">
        <span className="db-tile-icon small">{db.icon}</span>
        <span className="selected-db-name">{db.name}</span>
        <button
          type="button"
          className="link-btn"
          onClick={onChange}
          disabled={submitting}
        >
          Change
        </button>
      </div>

      <p className="muted">
        Enter database credentials to connect to your database.
      </p>

      <div className="form-fields">
        <label className="field">
          <span>Hostname</span>
          <input
            type="text"
            value={values.host}
            onChange={update('host')}
            placeholder="localhost"
            required
            disabled={submitting}
          />
        </label>

        <label className="field">
          <span>Port</span>
          <input
            type="text"
            value={values.port}
            onChange={update('port')}
            required
            disabled={submitting}
          />
        </label>

        <label className="field">
          <span>Database</span>
          <input
            type="text"
            value={values.database}
            onChange={update('database')}
            required
            disabled={submitting}
          />
        </label>

        <label className="field">
          <span>Username</span>
          <input
            type="text"
            value={values.username}
            onChange={update('username')}
            required
            disabled={submitting}
          />
        </label>

        <label className="field">
          <span>Password</span>
          <div className="password-wrap">
            <input
              type={showPassword ? 'text' : 'password'}
              value={values.password}
              onChange={update('password')}
              required
              disabled={submitting}
            />
            <button
              type="button"
              className="eye-btn"
              onClick={() => setShowPassword((s) => !s)}
              aria-label="Toggle password visibility"
            >
              {showPassword ? '👁' : '👁'}
            </button>
          </div>
        </label>

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Connecting…' : 'Apply'}
        </button>
      </div>
    </form>
  )
}

export default ConnectionForm
