import { useMemo, useState } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'

const VIEWS = [
  { id: 'table', label: 'Table' },
  { id: 'line', label: 'Line' },
  { id: 'bar', label: 'Bar' },
  { id: 'area', label: 'Area' },
]

const CHART_COLORS = ['#6c5ce7', '#13aa52', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7']

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function inferAxes(rows) {
  if (!rows || rows.length === 0) return { xKey: null, yKeys: [] }
  const columns = Object.keys(rows[0])
  const numericCols = columns.filter((col) =>
    rows.every((r) => toNumber(r[col]) !== null),
  )
  const categoryCols = columns.filter((col) => !numericCols.includes(col))
  const xKey = categoryCols[0] || columns[0]
  const yKeys = numericCols.length > 0 ? numericCols : columns.filter((c) => c !== xKey)
  return { xKey, yKeys }
}

function chartData(rows, yKeys) {
  return rows.map((r) => {
    const next = { ...r }
    yKeys.forEach((k) => {
      next[k] = toNumber(r[k]) ?? 0
    })
    return next
  })
}

function shortLabel(value) {
  const s = String(value)
  return s.length > 12 ? `${s.slice(0, 10)}…` : s
}

function ResultTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <p className="chat-empty-result">No rows returned.</p>
  }
  const columns = Object.keys(rows[0])
  return (
    <div className="chat-table-wrap">
      <table className="chat-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td key={col}>{String(row[col])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ChartView({ type, rows }) {
  const { xKey, yKeys } = useMemo(() => inferAxes(rows), [rows])
  const data = useMemo(() => chartData(rows, yKeys), [rows, yKeys])

  if (!xKey || yKeys.length === 0) {
    return (
      <p className="chat-empty-result">
        Not enough numeric data to chart. Try the table view.
      </p>
    )
  }

  const commonAxes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#eef0f4" />
      <XAxis
        dataKey={xKey}
        tickFormatter={shortLabel}
        tick={{ fontSize: 11, fill: '#6b7280' }}
      />
      <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} />
      <Tooltip />
      <Legend wrapperStyle={{ fontSize: 12 }} />
    </>
  )

  return (
    <div className="chat-chart-wrap">
      <ResponsiveContainer width="100%" height={280}>
        {type === 'line' ? (
          <LineChart data={data} margin={{ top: 10, right: 16, bottom: 10, left: 0 }}>
            {commonAxes}
            {yKeys.map((k, i) => (
              <Line
                key={k}
                type="monotone"
                dataKey={k}
                stroke={CHART_COLORS[i % CHART_COLORS.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            ))}
          </LineChart>
        ) : type === 'bar' ? (
          <BarChart data={data} margin={{ top: 10, right: 16, bottom: 10, left: 0 }}>
            {commonAxes}
            {yKeys.map((k, i) => (
              <Bar key={k} dataKey={k} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </BarChart>
        ) : (
          <AreaChart data={data} margin={{ top: 10, right: 16, bottom: 10, left: 0 }}>
            {commonAxes}
            {yKeys.map((k, i) => {
              const color = CHART_COLORS[i % CHART_COLORS.length]
              return (
                <Area
                  key={k}
                  type="monotone"
                  dataKey={k}
                  stroke={color}
                  fill={color}
                  fillOpacity={0.25}
                  strokeWidth={2}
                />
              )
            })}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

function ResultViewer({ rows }) {
  const [view, setView] = useState('table')
  return (
    <div className="result-viewer">
      <div className="view-tabs">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`view-tab${view === v.id ? ' active' : ''}`}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === 'table' ? <ResultTable rows={rows} /> : <ChartView type={view} rows={rows} />}
    </div>
  )
}

export default ResultViewer
