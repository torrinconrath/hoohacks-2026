import { useState, useEffect, useRef } from 'react'
import { inferSchema } from '../lib/ai'
import type { Source, AppRecord, Field } from '../types'

const TYPE_OPTIONS = [
  { value: 'tasks',    label: '📋 Tasks / Todos' },
  { value: 'habits',   label: '🌱 Habits & Health' },
  { value: 'finances', label: '💰 Finances' },
  { value: 'notes',    label: '📝 Notes / Journal' },
  { value: 'calendar', label: '📅 Calendar' },
  { value: 'custom',   label: '📦 Custom' },
]

const TYPE_COLORS: Record<string, string> = {
  tasks: '#0969a2', habits: '#0d7a6a', finances: '#c97d10',
  notes: '#a85500', calendar: '#6234b5', custom: '#57544c', app: '#7c6af5',
}

const MANUAL_DEFAULTS: Record<string, Omit<Field, 'key'>[]> = {
  tasks:    [{ label: 'Title', type: 'text' }, { label: 'Priority', type: 'select', options: ['high','medium','low'] }, { label: 'Due Date', type: 'date' }, { label: 'Completed', type: 'boolean' }, { label: 'Notes', type: 'text' }],
  habits:   [{ label: 'Name', type: 'text' }, { label: 'Frequency', type: 'select', options: ['daily','weekly'] }, { label: 'Streak', type: 'number' }, { label: 'Last Done', type: 'date' }],
  finances: [{ label: 'Description', type: 'text' }, { label: 'Amount', type: 'number' }, { label: 'Category', type: 'text' }, { label: 'Date', type: 'date' }, { label: 'Type', type: 'select', options: ['income','expense'] }],
  notes:    [{ label: 'Title', type: 'text' }, { label: 'Content', type: 'text' }, { label: 'Date', type: 'date' }, { label: 'Mood', type: 'select', options: ['great','good','okay','bad'] }],
  calendar: [{ label: 'Title', type: 'text' }, { label: 'Date', type: 'date' }, { label: 'Time', type: 'text' }, { label: 'Location', type: 'text' }, { label: 'Notes', type: 'text' }],
  custom:   [],
}

interface DataPageProps {
  sources: Source[]
  activeSourceId: string | null
  onSelectSource: (id: string | null) => void
  createSource: (params: { name: string; type: string; icon?: string; fields?: Field[] }) => Promise<Source>
  updateSource: (id: string, updates: Partial<Source>) => Promise<Source>
  deleteSource: (id: string) => Promise<void>
  getRecords: (sourceId: string) => Promise<AppRecord[]>
  createRecord: (sourceId: string, recordData: Record<string, unknown>) => Promise<AppRecord>
  updateRecord: (recordId: string, recordData: Record<string, unknown>) => Promise<AppRecord>
  deleteRecord: (recordId: string) => Promise<void>
  bulkCreateRecords: (sourceId: string, recordsData: Record<string, unknown>[]) => Promise<AppRecord[]>
}

export default function DataPage({
  sources, activeSourceId, onSelectSource,
  createSource, updateSource, deleteSource,
  getRecords, createRecord, updateRecord, deleteRecord, bulkCreateRecords
}: DataPageProps) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [records, setRecords]         = useState<AppRecord[]>([])
  const [loadingRecs, setLoadingRecs] = useState(false)
  const [editingCell, setEditingCell] = useState<{ recordId: string; fieldKey: string } | null>(null)
  const [addingRow, setAddingRow]     = useState(false)
  const [newRowData, setNewRowData]   = useState<Record<string, unknown>>({})
  const [addingField, setAddingField] = useState(false)
  const [newFieldLabel, setNewFieldLabel] = useState('')
  const [newFieldType, setNewFieldType]   = useState('text')
  const [newFieldOptions, setNewFieldOptions] = useState('')

  const activeSource = sources.find(s => s.id === activeSourceId)

  // Load records when source changes
  useEffect(() => {
    if (!activeSourceId) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingRecs(true)
    getRecords(activeSourceId)
      .then(recs => { if (!cancelled) { setRecords(recs); setLoadingRecs(false) } })
      .catch(() => { if (!cancelled) setLoadingRecs(false) })
    return () => { cancelled = true }
  }, [activeSourceId, getRecords])

  // ── Inline cell edit ──────────────────────────────────────────────────────
  async function handleCellEdit(record: AppRecord, fieldKey: string, newValue: unknown) {
    const updated: Record<string, unknown> = { ...record.data, [fieldKey]: newValue }
    await updateRecord(record.id, updated)
    setRecords(prev => prev.map(r => r.id === record.id ? { ...r, data: updated } : r))
    setEditingCell(null)
  }

  // ── Add row ───────────────────────────────────────────────────────────────
  async function handleAddRow() {
    if (!activeSource || !activeSourceId) return
    const rec = await createRecord(activeSourceId, newRowData)
    setRecords(prev => [...prev, rec])
    setNewRowData({})
    setAddingRow(false)
  }

  // ── Delete row ────────────────────────────────────────────────────────────
  async function handleDeleteRow(recordId: string) {
    await deleteRecord(recordId)
    setRecords(prev => prev.filter(r => r.id !== recordId))
  }

  // ── Add field ─────────────────────────────────────────────────────────────
  async function handleAddField() {
    if (!activeSource || !activeSourceId || !newFieldLabel.trim()) return
    const key = labelToKey(newFieldLabel) || 'field'
    const newField: Field = {
      key,
      label: newFieldLabel.trim(),
      type: newFieldType,
      ...(newFieldType === 'select' && newFieldOptions.trim()
        ? { options: newFieldOptions.split(',').map(o => o.trim()).filter(Boolean) }
        : {}),
    }
    const updatedFields = [...(activeSource.fields || []), newField]
    await updateSource(activeSourceId, { fields: updatedFields })
    setAddingField(false)
    setNewFieldLabel('')
    setNewFieldType('text')
    setNewFieldOptions('')
  }

  const displayFields = activeSource?.fields?.filter(f => f.key !== 'id') || []

  return (
    <div style={styles.page}>
      {/* Page header */}
      <div style={styles.header}>
        <div style={styles.pageIcon}>🗄️</div>
        <div style={styles.pageTitle}>My Data</div>
        <div style={styles.pageSub}>Your personal data sources. Apps you build read and write to these.</div>
      </div>

      <hr style={styles.divider} />

      {/* Source grid */}
      <div style={styles.sectionLabel}>Sources</div>
      <div style={styles.sourceGrid}>
        {sources.map(src => (
          <div
            key={src.id}
            style={{ ...styles.sourceCard, ...(activeSourceId === src.id ? styles.sourceCardActive : {}) }}
            onClick={() => { onSelectSource(src.id); setShowAddForm(false) }}
          >
            <span style={{ ...styles.typeBadge, background: `${TYPE_COLORS[src.type]}18`, color: TYPE_COLORS[src.type] }}>
              {src.type}
            </span>
            <div style={styles.sourceIcon}>{src.icon}</div>
            <div style={styles.sourceName}>{src.name}</div>
            <div style={styles.sourceMeta}>{src.fields?.length || 0} fields</div>
          </div>
        ))}
        <div style={styles.addCard} onClick={() => { setShowAddForm(true); onSelectSource(null) }}>
          <span style={{ fontSize: 20 }}>+</span> Add data source
        </div>
      </div>

      {/* Add source form */}
      {showAddForm && (
        <AddSourceForm
          onSave={async ({ name, type, icon, raw }) => {
            // 1. AI infers schema
            const schema = await inferSchema(type, name, raw)
            // 2. Create source with fields
            const src = await createSource({ name, type, icon, fields: schema.fields })
            // 3. Bulk-insert records
            if (schema.records?.length > 0) {
              const recs = await bulkCreateRecords(src.id, schema.records)
              setRecords(recs)
            }
            setShowAddForm(false)
            onSelectSource(src.id)
          }}
          onSaveManual={async ({ name, type, icon, fields }) => {
            const src = await createSource({ name, type, icon, fields })
            setShowAddForm(false)
            onSelectSource(src.id)
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {/* Source table */}
      {activeSource && (
        <div style={styles.tableSection}>
          <div style={styles.tableHeader}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 22 }}>{activeSource.icon}</span>
              <div>
                <div style={styles.tableName}>{activeSource.name}</div>
                <div style={styles.tableCount}>{records.length} records · {displayFields.length} fields</div>
              </div>
            </div>
            <button style={styles.dangerBtn} onClick={async () => {
              if (!confirm('Delete this source and all its records?')) return
              await deleteSource(activeSourceId!)
              onSelectSource(null)
            }}>Delete source</button>
          </div>

          {loadingRecs ? (
            <div style={styles.loading}>Loading records…</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {displayFields.map(f => (
                      <th key={f.key} style={styles.th}>{f.label}</th>
                    ))}
                    <th style={{ ...styles.th, width: 32 }}></th>
                    <th style={{ ...styles.th, width: addingField ? 280 : 32, padding: addingField ? '4px 8px' : undefined }}>
                      {addingField ? (
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input
                            autoFocus
                            style={{ ...styles.cellInput, flex: 2, fontSize: 12 }}
                            type="text"
                            placeholder="Field name"
                            value={newFieldLabel}
                            onChange={e => setNewFieldLabel(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleAddField(); if (e.key === 'Escape') setAddingField(false) }}
                          />
                          <select
                            style={{ ...styles.cellInput, flex: 1, fontSize: 12, cursor: 'pointer' }}
                            value={newFieldType}
                            onChange={e => setNewFieldType(e.target.value)}
                          >
                            {['text','number','date','boolean','select'].map(t => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                          {newFieldType === 'select' && (
                            <input
                              style={{ ...styles.cellInput, flex: 2, fontSize: 12 }}
                              type="text"
                              placeholder="opt1,opt2"
                              value={newFieldOptions}
                              onChange={e => setNewFieldOptions(e.target.value)}
                            />
                          )}
                          <button style={styles.saveRowBtn} onClick={handleAddField}>✓</button>
                          <button style={{ ...styles.rowDel, opacity: 1 }} onClick={() => setAddingField(false)}>×</button>
                        </div>
                      ) : (
                        <span
                          title="Add field"
                          style={{ cursor: 'pointer', color: 'var(--text3)', fontSize: 14, padding: '0 4px' }}
                          onClick={() => setAddingField(true)}
                        >+</span>
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {records.map(record => (
                    <tr key={record.id} style={styles.tr}>
                      {displayFields.map(f => (
                        <td key={f.key} style={styles.td} onClick={() => setEditingCell({ recordId: record.id, fieldKey: f.key })}>
                          {editingCell?.recordId === record.id && editingCell?.fieldKey === f.key ? (
                            <CellEditor
                              field={f}
                              value={record.data[f.key]}
                              onSave={val => handleCellEdit(record, f.key, val)}
                              onCancel={() => setEditingCell(null)}
                            />
                          ) : (
                            <CellDisplay field={f} value={record.data[f.key]} />
                          )}
                        </td>
                      ))}
                      <td style={{ ...styles.td, width: 32 }}>
                        <button style={styles.rowDel} onClick={() => handleDeleteRow(record.id)}>×</button>
                      </td>
                      <td style={styles.td} />
                    </tr>
                  ))}

                  {/* Add row */}
                  {addingRow ? (
                    <tr style={styles.tr}>
                      {displayFields.map(f => (
                        <td key={f.key} style={styles.td}>
                          <CellEditor
                            field={f}
                            value={newRowData[f.key] ?? ''}
                            onSave={val => setNewRowData(prev => ({ ...prev, [f.key]: val }))}
                            onCancel={() => {}}
                            inline
                          />
                        </td>
                      ))}
                      <td style={styles.td}>
                        <button style={styles.saveRowBtn} onClick={handleAddRow}>✓</button>
                      </td>
                      <td style={styles.td} />
                    </tr>
                  ) : (
                    <tr>
                      <td colSpan={displayFields.length + 2} style={{ padding: '6px 12px' }}>
                        <span style={styles.addRowBtn} onClick={() => setAddingRow(true)}>+ Add row</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Add Source Form ───────────────────────────────────────────────────────────

interface AddSourceFormProps {
  onSave: (params: { name: string; type: string; icon: string; raw: string }) => Promise<void>
  onSaveManual: (params: { name: string; type: string; icon: string; fields: Field[] }) => Promise<void>
  onCancel: () => void
}

function labelToKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

// ── AddSourceForm ─────────────────────────────────────────────────────────────

function AddSourceForm({ onSave, onSaveManual, onCancel }: AddSourceFormProps) {
  const [mode, setMode]       = useState<'import' | 'file' | 'calendar' | 'manual'>('import')
  const [type, setType]       = useState('tasks')
  const [name, setName]       = useState('')
  const [raw, setRaw]         = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  // ── File upload ───────────────────────────────────────────────────────────
  const fileInputRef                  = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver]       = useState(false)
  const [fileName, setFileName]       = useState<string | null>(null)
  const [filePreview, setFilePreview] = useState<string | null>(null)
  const [fileRaw, setFileRaw]         = useState('')

  // ── ICS calendar upload ───────────────────────────────────────────────────
  const icsInputRef                   = useRef<HTMLInputElement>(null)
  const [icsFileName, setIcsFileName] = useState<string | null>(null)
  const [icsPreview, setIcsPreview]   = useState<string | null>(null)
  const [icsRaw, setIcsRaw]           = useState('')

  // ── Manual fields ─────────────────────────────────────────────────────────
  const [manualFields, setManualFields] = useState<Array<{ label: string; type: string; options: string }>>(() =>
    MANUAL_DEFAULTS['tasks'].map(f => ({ label: f.label, type: f.type, options: f.options?.join(',') || '' }))
  )

  function handleTypeChange(newType: string) {
    setType(newType)
    setManualFields((MANUAL_DEFAULTS[newType] || []).map(f => ({ label: f.label, type: f.type, options: f.options?.join(',') || '' })))
  }

  function getIcon() { return TYPE_OPTIONS.find(t => t.value === type)?.label.split(' ')[0] || '📦' }
  function getName() { return name || TYPE_OPTIONS.find(t => t.value === type)?.label.slice(3) || type }

  const PLACEHOLDERS: Record<string, string> = {
    tasks:    '- Go to gym (due Monday)\n- Call dentist ★ urgent\n- Finish report by Friday',
    habits:   'Reading: daily, 14 day streak\nGym: 3x/week, 5 day streak\nMeditate: daily, 2 day streak',
    finances: 'Rent -$1800 Jan 1\nSalary +$4500 Jan 15\nGroceries -$120 Jan 16\nNetflix -$16 Jan 18',
    notes:    'Jan 20 - Feeling great today, got a lot done. Mood: 😊\nJan 21 - Bit tired but pushed through.',
    calendar: 'Team standup - Mon/Wed/Fri 9am\nDentist - Feb 3 at 2pm\nFlight to NYC - Feb 10',
    custom:   'Paste any data in any format…',
  }

  // ── Submit handlers ───────────────────────────────────────────────────────

  async function handleSubmitImport(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!raw.trim()) { setError('Please paste some data first.'); return }
    setLoading(true); setError('')
    try { await onSave({ name: getName(), type, icon: getIcon(), raw }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.') }
    finally { setLoading(false) }
  }

  async function handleSubmitFile() {
    if (!fileRaw.trim()) { setError('Please select a file first.'); return }
    setLoading(true); setError('')
    try { await onSave({ name: getName(), type, icon: getIcon(), raw: fileRaw }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.') }
    finally { setLoading(false) }
  }

  async function handleSubmitIcs() {
    if (!icsRaw.trim()) { setError('Please select an .ics file first.'); return }
    setLoading(true); setError('')
    try { await onSave({ name: getName(), type: 'calendar', icon: '📅', raw: icsRaw }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.') }
    finally { setLoading(false) }
  }

  async function handleSubmitManual(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const fields: Field[] = manualFields
        .filter(f => f.label.trim())
        .map(f => ({
          key: labelToKey(f.label) || 'field',
          label: f.label,
          type: f.type,
          ...(f.type === 'select' && f.options.trim() ? { options: f.options.split(',').map(o => o.trim()).filter(Boolean) } : {}),
        }))
      await onSaveManual({ name: getName(), type, icon: getIcon(), fields })
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.') }
    finally { setLoading(false) }
  }

  // ── File parsers ──────────────────────────────────────────────────────────

  async function parseFile(file: File) {
    setError(''); setFileName(file.name)
    const ext = file.name.split('.').pop()?.toLowerCase()
    try {
      if (['csv','tsv','txt','md'].includes(ext || '')) {
        const text = await file.text()
        setFileRaw(text); setFilePreview(text.slice(0, 400) + (text.length > 400 ? '\n…' : ''))
        return
      }
      if (ext === 'json') {
        const text = await file.text()
        try {
          const pretty = JSON.stringify(JSON.parse(text), null, 2)
          setFileRaw(pretty); setFilePreview(pretty.slice(0, 400) + (pretty.length > 400 ? '\n…' : ''))
        } catch { setFileRaw(text); setFilePreview(text.slice(0, 400)) }
        return
      }
      if (ext === 'xlsx' || ext === 'xls') {
        // @ts-ignore — SheetJS via CDN
        const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs')
        const buf  = await file.arrayBuffer()
        const wb   = XLSX.read(buf, { type: 'array' })
        const csv: string = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])
        setFileRaw(csv); setFilePreview(csv.slice(0, 400) + (csv.length > 400 ? '\n…' : ''))
        return
      }
      setError(`Unsupported file type ".${ext}". Use CSV, XLSX, JSON, TXT, or MD.`)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not read file.') }
  }

  async function parseIcs(file: File) {
    setError(''); setIcsFileName(file.name)
    try {
      const text = await file.text()
      const events: string[] = []
      for (const block of text.split('BEGIN:VEVENT').slice(1)) {
        const get = (key: string) => {
          const m = block.match(new RegExp(`${key}[^:]*:([^\r\n]+)`))
          return m ? m[1].replace(/\\n/g,' ').replace(/\\,/g,',').trim() : ''
        }
        const summary = get('SUMMARY')
        if (!summary) continue
        const parts = [summary, get('DTSTART'), get('DTEND'), get('LOCATION'), get('DESCRIPTION')].filter(Boolean)
        events.push(parts.join(' | '))
      }
      if (!events.length) { setError('No events found in this .ics file.'); return }
      const joined = events.join('\n')
      setIcsRaw(joined)
      setIcsPreview(events.slice(0, 6).join('\n') + (events.length > 6 ? `\n…(${events.length - 6} more events)` : ''))
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not read .ics file.') }
  }

  function updateField(i: number, key: string, val: string) {
    setManualFields(prev => prev.map((f, idx) => idx === i ? { ...f, [key]: val } : f))
  }
  function removeField(i: number) { setManualFields(prev => prev.filter((_, idx) => idx !== i)) }
  function addField()              { setManualFields(prev => [...prev, { label: '', type: 'text', options: '' }]) }

  // ── Render ────────────────────────────────────────────────────────────────

  const TABS: { id: typeof mode; label: string }[] = [
    { id: 'import',   label: '✨ AI Import'     },
    { id: 'file',     label: '📄 File Upload'    },
    { id: 'calendar', label: '📅 Calendar / ICS' },
    { id: 'manual',   label: '✏️ Manual Setup'   },
  ]

  return (
    <div style={styles.addForm}>
      <div style={styles.addFormTitle}>New Data Source</div>

      {/* Mode tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 18, borderBottom: '1px solid var(--border)' }}>
        {TABS.map(m => (
          <button
            key={m.id}
            type="button"
            onClick={() => { setMode(m.id); setError('') }}
            style={{
              padding: '7px 15px', background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' as const,
              color: mode === m.id ? 'var(--accent)' : 'var(--text3)',
              borderBottom: mode === m.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
            }}
          >{m.label}</button>
        ))}
      </div>

      {/* Shared: type + name (calendar locks type to 'calendar') */}
      <div style={styles.fieldRow}>
        <div style={styles.fieldCol}>
          <label style={styles.fieldLabel}>Type</label>
          <select
            style={styles.select}
            value={mode === 'calendar' ? 'calendar' : type}
            disabled={mode === 'calendar'}
            onChange={e => handleTypeChange(e.target.value)}
          >
            {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={{ ...styles.fieldCol, flex: 2 }}>
          <label style={styles.fieldLabel}>Name</label>
          <input
            style={styles.input}
            type="text"
            placeholder={`e.g. My ${mode === 'calendar' ? 'Calendar' : type}`}
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </div>
      </div>

      {/* ── AI IMPORT ──────────────────────────────────────────────────────── */}
      {mode === 'import' && (
        <form onSubmit={handleSubmitImport}>
          <div style={{ marginBottom: 14 }}>
            <label style={styles.fieldLabel}>Paste your data</label>
            <div style={styles.pasteHint}>Anything works — bullet lists, paragraphs, tables. AI will structure it.</div>
            <textarea
              style={styles.textarea}
              value={raw}
              onChange={e => setRaw(e.target.value)}
              placeholder={PLACEHOLDERS[type]}
              rows={6}
            />
          </div>
          {error && <div style={styles.errorMsg}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={styles.primaryBtn} disabled={loading}>{loading ? '⟳ Structuring with AI…' : 'Structure & Save →'}</button>
            <button type="button" style={styles.secondaryBtn} onClick={onCancel}>Cancel</button>
          </div>
        </form>
      )}

      {/* ── FILE UPLOAD ────────────────────────────────────────────────────── */}
      {mode === 'file' && (
        <div>
          <div style={styles.pasteHint}>CSV, XLSX, JSON, TXT, or Markdown. AI will infer the schema and import the rows.</div>
          <div
            style={{
              border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border2)'}`,
              borderRadius: 'var(--radius)',
              background: dragOver ? 'var(--accent-s)' : 'transparent',
              padding: '28px 16px', textAlign: 'center' as const, cursor: 'pointer',
              transition: 'all 0.15s', marginBottom: 10,
            }}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) parseFile(f) }}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef} type="file"
              accept=".csv,.xlsx,.xls,.json,.txt,.md,.tsv"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) parseFile(f) }}
            />
            {fileName ? (
              <>
                <div style={{ fontSize: 20, marginBottom: 4 }}>✅</div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{fileName}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>Click to replace</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 26, marginBottom: 6 }}>📂</div>
                <div style={{ fontSize: 13, color: 'var(--text3)', fontWeight: 500 }}>Drop file here or click to browse</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3 }}>CSV · XLSX · JSON · TXT · MD</div>
              </>
            )}
          </div>
          {filePreview && <pre style={styles.codePreview}>{filePreview}</pre>}
          {error && <div style={styles.errorMsg}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={styles.primaryBtn} disabled={loading || !fileRaw.trim()} onClick={handleSubmitFile}>
              {loading ? '⟳ Structuring with AI…' : 'Import & Structure →'}
            </button>
            <button type="button" style={styles.secondaryBtn} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── CALENDAR / ICS ─────────────────────────────────────────────────── */}
      {mode === 'calendar' && (
        <div>
          <div style={styles.pasteHint}>Upload an .ics file exported from Google Calendar, Apple Calendar, Outlook, or any other calendar app.</div>
          <div
            style={{
              border: `2px dashed ${icsFileName ? 'var(--accent)' : 'var(--border2)'}`,
              borderRadius: 'var(--radius)',
              background: icsFileName ? 'var(--accent-s)' : 'transparent',
              padding: '28px 16px', textAlign: 'center' as const, cursor: 'pointer',
              transition: 'all 0.15s', marginBottom: 10,
            }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) parseIcs(f) }}
            onClick={() => icsInputRef.current?.click()}
          >
            <input
              ref={icsInputRef} type="file" accept=".ics"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) parseIcs(f) }}
            />
            {icsFileName ? (
              <>
                <div style={{ fontSize: 20, marginBottom: 4 }}>✅</div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{icsFileName}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>Click to replace</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 26, marginBottom: 6 }}>📅</div>
                <div style={{ fontSize: 13, color: 'var(--text3)', fontWeight: 500 }}>Drop .ics file here or click to browse</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3 }}>Google Calendar · Apple Calendar · Outlook</div>
              </>
            )}
          </div>
          {icsPreview && <pre style={styles.codePreview}>{icsPreview}</pre>}
          <div style={{ ...styles.pasteHint, marginTop: 4 }}>
            <strong>How to export:</strong> Google Calendar → Settings → Import &amp; Export → Export &nbsp;·&nbsp; Apple Calendar → File → Export &nbsp;·&nbsp; Outlook → File → Save Calendar
          </div>
          {error && <div style={styles.errorMsg}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button style={styles.primaryBtn} disabled={loading || !icsRaw.trim()} onClick={handleSubmitIcs}>
              {loading ? '⟳ Structuring with AI…' : 'Import Calendar →'}
            </button>
            <button type="button" style={styles.secondaryBtn} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── MANUAL SETUP ───────────────────────────────────────────────────── */}
      {mode === 'manual' && (
        <form onSubmit={handleSubmitManual}>
          <div style={{ marginBottom: 14 }}>
            <label style={styles.fieldLabel}>Fields</label>
            <div style={styles.pasteHint}>Define the fields for your source. Add or remove as needed.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {manualFields.map((f, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <input
                    style={{ ...styles.input, flex: 2 }}
                    type="text"
                    placeholder="Field label"
                    value={f.label}
                    onChange={e => updateField(i, 'label', e.target.value)}
                  />
                  <select
                    style={{ ...styles.select, flex: 1 }}
                    value={f.type}
                    onChange={e => updateField(i, 'type', e.target.value)}
                  >
                    {['text','number','date','boolean','select'].map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <button type="button" style={{ ...styles.secondaryBtn, padding: '8px 10px', flexShrink: 0 }} onClick={() => removeField(i)}>×</button>
                </div>
              ))}
              {manualFields.map((f, i) => f.type === 'select' && (
                <div key={`opts-${i}`} style={{ paddingLeft: 12, marginTop: -2 }}>
                  <input
                    style={{ ...styles.input, width: '100%', fontSize: 12 }}
                    type="text"
                    placeholder={`Options for "${f.label || 'select'}" (comma-separated, e.g. high,medium,low)`}
                    value={f.options}
                    onChange={e => updateField(i, 'options', e.target.value)}
                  />
                </div>
              ))}
            </div>
            <button type="button" style={{ ...styles.secondaryBtn, marginTop: 8, fontSize: 12.5 }} onClick={addField}>
              + Add field
            </button>
          </div>
          {error && <div style={styles.errorMsg}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={styles.primaryBtn} disabled={loading}>{loading ? '⟳ Creating…' : 'Create Source →'}</button>
            <button type="button" style={styles.secondaryBtn} onClick={onCancel}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}

// ── Cell components ───────────────────────────────────────────────────────────

interface CellDisplayProps {
  field: Field
  value: unknown
}

function CellDisplay({ field, value }: CellDisplayProps) {
  if (value === null || value === undefined || value === '') return <span style={{ color: 'var(--text3)' }}>—</span>
  if (field.type === 'boolean') {
    return <span style={{ color: value ? 'var(--green)' : 'var(--text3)' }}>{value ? '✓' : '○'}</span>
  }
  if (field.key === 'priority') {
    const c: Record<string, string> = { high: 'var(--red)', medium: 'var(--yellow)', low: 'var(--green)' }
    return <span style={{ fontSize: 11, fontWeight: 500, color: c[String(value).toLowerCase()] || 'var(--text2)' }}>{String(value)}</span>
  }
  if (field.key === 'type') {
    const c = String(value).toLowerCase() === 'income' ? 'var(--green)' : 'var(--red)'
    return <span style={{ fontSize: 11, fontWeight: 500, color: c }}>{String(value)}</span>
  }
  return <span style={{ fontSize: 13 }}>{String(value)}</span>
}

interface CellEditorProps {
  field: Field
  value: unknown
  onSave: (val: unknown) => void
  onCancel: () => void
  inline?: boolean
}

function CellEditor({ field, value, onSave, onCancel, inline }: CellEditorProps) {
  const [val, setVal] = useState<unknown>(value ?? '')

  function commit() { onSave(val) }
  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
    if (e.key === 'Escape') onCancel()
  }

  if (field.type === 'boolean') {
    return (
      <input type="checkbox" checked={!!val} onChange={e => { onSave(e.target.checked) }} autoFocus />
    )
  }
  if (field.type === 'select' && field.options?.length) {
    return (
      <select style={styles.cellInput} value={val as string} onChange={e => setVal(e.target.value)} onBlur={commit} autoFocus>
        <option value="">—</option>
        {field.options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  return (
    <input
      style={styles.cellInput}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={val as string}
      onChange={e => setVal(e.target.value)}
      onBlur={inline ? undefined : commit}
      onKeyDown={handleKey}
      autoFocus={!inline}
    />
  )
}

const styles = {
  page: { flex: 1, overflowY: 'auto' as const, padding: '56px 88px 80px', maxWidth: 1100 },
  header: { marginBottom: 28 },
  pageIcon: { fontSize: 44, marginBottom: 12, lineHeight: 1 },
  pageTitle: { fontFamily: "'Lora', serif", fontSize: 36, fontWeight: 500, marginBottom: 6 },
  pageSub: { fontSize: 14, color: 'var(--text3)', fontStyle: 'italic' as const, fontFamily: "'Lora', serif" },
  divider: { border: 'none', borderTop: '1px solid var(--border)', margin: '24px 0' },
  sectionLabel: { fontSize: 11, fontWeight: 500, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 10 },

  sourceGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 28 },
  sourceCard: {
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    padding: 16, background: 'var(--bg)', cursor: 'pointer', transition: 'all 0.15s',
  },
  sourceCardActive: { borderColor: 'var(--accent)', background: 'var(--accent-s)' },
  typeBadge: { display: 'inline-block', fontSize: 10, fontWeight: 500, padding: '2px 7px', borderRadius: 20, textTransform: 'uppercase' as const, letterSpacing: '0.03em', marginBottom: 8 },
  sourceIcon: { fontSize: 22, marginBottom: 6 },
  sourceName: { fontSize: 13.5, fontWeight: 500, marginBottom: 2 },
  sourceMeta: { fontSize: 12, color: 'var(--text3)' },

  addCard: {
    border: '1.5px dashed var(--border2)', borderRadius: 'var(--radius)',
    padding: 16, cursor: 'pointer', display: 'flex', alignItems: 'center',
    justifyContent: 'center', gap: 8, color: 'var(--text3)', fontSize: 13.5,
    transition: 'all 0.15s', minHeight: 82,
  },

  addForm: {
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    background: 'var(--bg)', padding: 24, marginBottom: 28, boxShadow: 'var(--shadow-md)',
  },
  addFormTitle: { fontSize: 15, fontWeight: 500, marginBottom: 18 },
  fieldRow: { display: 'flex', gap: 10, marginBottom: 14 },
  fieldCol: { display: 'flex', flexDirection: 'column' as const, gap: 5, flex: 1 },
  fieldLabel: { fontSize: 11.5, fontWeight: 500, color: 'var(--text2)' },
  pasteHint: { fontSize: 12, color: 'var(--text3)', marginTop: 3, marginBottom: 7, fontStyle: 'italic' as const, fontFamily: "'Lora', serif" },
  input: { padding: '8px 12px', border: '1px solid var(--border2)', borderRadius: 'var(--radius)', fontSize: 13.5, outline: 'none' },
  select: { padding: '8px 12px', border: '1px solid var(--border2)', borderRadius: 'var(--radius)', fontSize: 13.5, outline: 'none', background: 'var(--bg)', cursor: 'pointer' },
  textarea: { width: '100%', padding: '10px 12px', border: '1px solid var(--border2)', borderRadius: 'var(--radius)', fontSize: 13, resize: 'vertical' as const, outline: 'none', lineHeight: 1.6 },
  errorMsg: { background: 'rgba(224,62,62,0.07)', border: '1px solid rgba(224,62,62,0.2)', color: 'var(--red)', padding: '8px 12px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 10 },
  primaryBtn: { padding: '8px 18px', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 'var(--radius)', fontSize: 13.5, fontWeight: 500, cursor: 'pointer' },
  secondaryBtn: { padding: '8px 14px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 13, color: 'var(--text2)', cursor: 'pointer' },

  codePreview: {
    background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    padding: '8px 12px', fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' as const,
    maxHeight: 130, overflowY: 'auto' as const, margin: '0 0 10px', color: 'var(--text2)',
  },

  tableSection: { marginTop: 8 },
  tableHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14, gap: 16 },
  tableName: { fontSize: 20, fontFamily: "'Lora', serif", fontWeight: 500 },
  tableCount: { fontSize: 12, color: 'var(--text3)', marginTop: 2 },
  dangerBtn: { padding: '6px 12px', background: 'transparent', border: '1px solid rgba(224,62,62,0.25)', color: 'var(--red)', borderRadius: 'var(--radius)', fontSize: 12.5, cursor: 'pointer', flexShrink: 0 },
  loading: { padding: '24px 0', color: 'var(--text3)', fontSize: 13, fontStyle: 'italic' as const },

  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13.5 },
  th: { textAlign: 'left' as const, padding: '7px 12px', fontSize: 11, fontWeight: 500, color: 'var(--text3)', letterSpacing: '0.04em', textTransform: 'uppercase' as const, borderBottom: '1px solid var(--border)', background: 'var(--bg2)', whiteSpace: 'nowrap' as const },
  tr: { transition: 'background 0.1s' },
  td: { padding: '7px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text2)', cursor: 'cell', maxWidth: 240 },

  cellInput: { width: '100%', padding: '4px 8px', border: '1px solid var(--accent)', borderRadius: 4, fontSize: 13, outline: 'none', background: 'var(--bg)' },
  rowDel: { background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 16, padding: '0 2px', opacity: 0.4, transition: 'opacity 0.1s' },
  addRowBtn: { fontSize: 12.5, color: 'var(--text3)', cursor: 'pointer', padding: '4px 0' },
  saveRowBtn: { background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', fontSize: 13 },
}