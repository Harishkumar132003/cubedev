function DatabasePicker({ databases, onSelect }) {
  return (
    <div>
      <h1 className="title">Set Up a Database connection</h1>
      <p className="subtitle">Select a database type</p>

      <div className="db-grid">
        {databases.map((db) => (
          <button
            key={db.id}
            type="button"
            className="db-tile"
            onClick={() => onSelect(db)}
          >
            <span className="db-tile-icon">{db.icon}</span>
            <span className="db-tile-name">{db.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default DatabasePicker
