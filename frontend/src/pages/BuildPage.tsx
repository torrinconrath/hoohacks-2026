import { useState, useEffect, useRef, useCallback } from 'react'
import { generateApp, editApp } from '../lib/ai'
import type { Source, AppRecord, App, Field } from '../types'

function inferFieldType(v: unknown): string {
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date'
  return 'text'
}

const SUGGESTIONS = [
  'a daily habit check-in with streaks and progress rings',
  'a weekly spending breakdown with category charts',
  'a smart todo list sorted by priority and due date',
  'a mood journal with emoji ratings and calendar view',
  'an upcoming events countdown dashboard',
  'a personal net worth tracker over time',
]

interface BuildPageProps {
  sources: Source[]
  getRecords: (sourceId: string) => Promise<AppRecord[]>
  apps: App[]
  saveApp: (params: { name: string; prompt: string; html: string; sourceIds?: string[] }) => Promise<App>
  updateApp: (id: string, updates: { html?: string; name?: string }) => Promise<App>
  deleteApp: (id: string) => Promise<void>
  activeAppId: string | null
  onSelectApp: (id: string | null) => void
  syncRecords: (sourceId: string, recordsData: Record<string, unknown>[]) => Promise<void>
  createSource: (params: { name: string; type: string; icon?: string; fields?: Field[] }) => Promise<Source>
  updateSource: (id: string, updates: Partial<Source>) => Promise<Source>
}

export default function BuildPage({ sources, getRecords, apps, saveApp, updateApp, deleteApp, activeAppId, onSelectApp, syncRecords, createSource, updateSource }: BuildPageProps) {
  const [prompt, setPrompt]               = useState('')
  const [building, setBuilding]           = useState(false)
  const [error, setError]                 = useState('')
  const [progress, setProgress]           = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set())
  const [editOpen, setEditOpen]                   = useState(false)
  const [editPrompt, setEditPrompt]               = useState('')
  const [editing, setEditing]                     = useState(false)
  const [editError, setEditError]                 = useState('')
  const [editProgress, setEditProgress]           = useState(0)
  const [editProgressLabel, setEditProgressLabel] = useState('')
  const frameRef = useRef<HTMLIFrameElement>(null)

  // Reset edit bar when switching apps
  useEffect(() => { setEditOpen(false); setEditPrompt(''); setEditError('') }, [activeAppId])

  function toggleSource(id: string) {
    setSelectedSourceIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const activeApp = apps.find(a => a.id === activeAppId)

  // ── vibeDB postMessage bridge ─────────────────────────────────────────────
  // Listen for write-backs from generated apps
  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      if (!e.data || e.data.type !== 'vibeDB:write') return
      const { sourceName, records } = e.data as { sourceName: string; records: Record<string, unknown>[] }
      let src = sources.find(s => s.name === sourceName)
      if (!src) {
        // Auto-create source with fields inferred from first record
        const inferredFields: Field[] = records.length > 0
          ? Object.keys(records[0]).filter(k => k !== 'id').map(k => ({
              key: k,
              label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              type: inferFieldType(records[0][k]),
            }))
          : []
        src = await createSource({ name: sourceName, type: 'custom', icon: '⚡', fields: inferredFields })
      }
      await syncRecords(src.id, records)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [sources, syncRecords, createSource])

  // ── Build ─────────────────────────────────────────────────────────────────
  async function handleBuild() {
    if (!prompt.trim()) return
    setBuilding(true); setError('')
    setProgress(5); setProgressLabel('Planning data sources…')

    try {
      // Send ALL sources with records (backend plan step selects which to use)
      setProgress(15); setProgressLabel('Loading your data…')
      const allSourcesWithRecords = await Promise.all(
        sources.map(async src => {
          const records = await getRecords(src.id)
          return { ...src, records: records.map(r => r.data) }
        })
      )
      const allSourceSummaries = sources.map(({ id, name, type, fields }) => ({ id, name, type, fields }))

      setProgress(35); setProgressLabel('Generating app…')
      const { html, name: appName, source_plan } = await generateApp(prompt, allSourcesWithRecords, allSourceSummaries, [...selectedSourceIds])
      console.log(html)
      if (!html || !html.includes('<')) throw new Error('No valid app generated. Try rephrasing.')

      setProgress(75); setProgressLabel('Creating data sources…')

      // Create new sources declared by the plan
      const createdSourceIds: string[] = []
      for (const ns of source_plan.new_sources) {
        const created = await createSource({ name: ns.name, type: ns.type, icon: ns.icon, fields: ns.fields })
        createdSourceIds.push(created.id)
      }

      // Collect all source IDs: existing (from plan, validated) + newly created
      const existingIds = source_plan.existing_sources
        .map(e => e.source_id)
        .filter(id => sources.some(s => s.id === id))
      const allSourceIds = [...existingIds, ...createdSourceIds]

      setProgress(90); setProgressLabel('Saving app…')
      const app = await saveApp({ name: appName, prompt, html, sourceIds: allSourceIds })

      setProgress(100)
      setPrompt('')
      setSelectedSourceIds(new Set())
      onSelectApp(app.id)

    } catch (err) {
      console.log(err)
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBuilding(false); setProgress(0)
    }
  }

  // ── Edit ──────────────────────────────────────────────────────────────────
  async function handleEdit() {
    if (!editPrompt.trim() || !activeApp) return
    setEditing(true); setEditError('')
    setEditProgress(10); setEditProgressLabel('Planning changes…')

    try {
      const linkedSources = sources.filter(s => activeApp.source_ids?.includes(s.id))
      const sourcesWithRecords = await Promise.all(
        linkedSources.map(async src => {
          const records = await getRecords(src.id)
          return { id: src.id, name: src.name, type: src.type, fields: src.fields, records: records.map(r => r.data) }
        })
      )

      setEditProgress(30); setEditProgressLabel('Editing app…')
      const { html, schema_updates } = await editApp(editPrompt, activeApp.html, sourcesWithRecords)
      if (!html || !html.includes('<')) throw new Error('Edit failed. Try rephrasing.')

      setEditProgress(80); setEditProgressLabel('Applying changes…')

      for (const upd of schema_updates) {
        await updateSource(upd.source_id, { fields: upd.fields })
      }

      await updateApp(activeApp.id, { html })

      setEditProgress(100)
      setEditPrompt('')
      setEditOpen(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setEditing(false); setEditProgress(0)
    }
  }

  // ── Inject vibeDB into iframe when app opens ──────────────────────────────
  const getInjectedHtml = useCallback(async (app: App): Promise<string> => {
    const linkedSources = sources.filter(s => app.source_ids?.includes(s.id))
    const vibeDB: Record<string, unknown> = {}
    for (const src of linkedSources) {
      const records = await getRecords(src.id)
      vibeDB[src.name] = { fields: src.fields, records: records.map(r => r.data) }
    }
    const injection = `<script>window.vibeDB = ${JSON.stringify(vibeDB)};</script>`
    let html = app.html
    if (html.includes('</head>')) {
      html = html.replace('</head>', injection + '</head>')
    } else {
      html = injection + html
    }
    return html
  }, [sources, getRecords])

  const [injectedHtml, setInjectedHtml] = useState('')
  useEffect(() => {
    if (!activeApp) { setInjectedHtml(''); return }
    getInjectedHtml(activeApp).then(setInjectedHtml)
  }, [activeApp, getInjectedHtml])

  return (
    <div style={styles.wrap}>

      {/* ── Builder / Library panel ─────────────────────────────── */}
      <div style={{ ...styles.builderPanel, display: activeApp ? 'none' : 'flex' }}>

        {/* Left: prompt */}
        <div style={styles.promptArea}>
          <div style={styles.header}>
            <div style={styles.pageIcon}>⚡</div>
            <div style={styles.pageTitle}>App Builder</div>
            <div style={styles.pageSub}>Describe any app. It reads your real data automatically.</div>
          </div>

          {/* Data context callout */}
          {sources.length > 0 ? (
            <div style={styles.calloutAccent}>
              <span>🗄️</span>
              <span>
                <strong>{sources.length} source{sources.length > 1 ? 's' : ''} connected</strong>
                {' '}— apps you build will automatically use your real data.
              </span>
            </div>
          ) : (
            <div style={styles.callout}>
              <span>💡</span>
              <span>Add data sources in the <strong>Data tab</strong> and generated apps will be pre-filled with your real information.</span>
            </div>
          )}

          {error && <div style={styles.errorMsg}>{error}</div>}

          {/* Source picker */}
          {sources.length > 0 && (
            <div style={styles.sourcePicker}>
              <span style={styles.sourcePickerLabel}>Pin sources</span>
              <div style={styles.sourcePickerBtns}>
                {sources.map(src => {
                  const selected = selectedSourceIds.has(src.id)
                  return (
                    <button
                      key={src.id}
                      style={{ ...styles.sourceBtn, ...(selected ? styles.sourceBtnActive : {}) }}
                      onClick={() => toggleSource(src.id)}
                    >
                      {src.icon} {src.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Prompt input */}
          <div style={styles.promptBox}>
            <textarea
              style={styles.promptTextarea}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="a habit tracker showing my current streaks and today's check-ins…"
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleBuild() }}
              rows={4}
            />
            <div style={styles.promptFooter}>
              <span style={styles.promptHint}>⌘↵ to build</span>
              <button style={{ ...styles.buildBtn, opacity: building ? 0.6 : 1 }} onClick={handleBuild} disabled={building}>
                {building ? progressLabel : 'Build →'}
              </button>
            </div>
            {building && (
              <div style={styles.progressTrack}>
                <div style={{ ...styles.progressFill, width: `${progress}%` }} />
              </div>
            )}
          </div>

          {/* Suggestions */}
          <div style={styles.chips}>
            {SUGGESTIONS.map(s => (
              <span key={s} style={styles.chip} onClick={() => setPrompt(s)}>{s}</span>
            ))}
          </div>
        </div>

        {/* Right: library */}
        <div style={styles.library}>
          <div style={styles.libraryTitle}>Your Apps</div>
          {apps.length === 0 ? (
            <div style={styles.emptyLib}>Apps you build will live here, ready to relaunch any time.</div>
          ) : (
            apps.map(app => {
              const linkedSrcs = sources.filter(s => app.source_ids?.includes(s.id))
              return (
                <div key={app.id} style={styles.appTile} onClick={() => onSelectApp(app.id)}>
                  <div style={styles.appTileName}>{app.name}</div>
                  {linkedSrcs.length > 0 && (
                    <div style={styles.appTileSrcs}>🗄️ {linkedSrcs.map(s => s.name).join(' · ')}</div>
                  )}
                  <div style={styles.appTileDate}>{new Date(app.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  <button style={styles.appTileDel} onClick={e => { e.stopPropagation(); deleteApp(app.id) }}>✕</button>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* ── App Viewer ────────────────────────────────────────────── */}
      {activeApp && (
        <div style={styles.viewer}>
          <div style={styles.viewerBar}>
            <button style={styles.backBtn} onClick={() => onSelectApp(null)}>← Back</button>
            <div style={styles.viewerTitle}>{activeApp.name}</div>
            {sources.filter(s => activeApp.source_ids?.includes(s.id)).length > 0 && (
              <div style={styles.viewerSrcs}>
                🗄️ {sources.filter(s => activeApp.source_ids?.includes(s.id)).map(s => s.name).join(' · ')}
              </div>
            )}
            <button
              style={{ ...styles.backBtn, marginLeft: 'auto', background: editOpen ? 'var(--accent-s)' : undefined, color: editOpen ? 'var(--accent)' : undefined, borderColor: editOpen ? 'rgba(124,106,245,0.35)' : undefined }}
              onClick={() => { setEditOpen(o => !o); setEditError('') }}
            >
              {editOpen ? 'Close' : '✏️ Edit'}
            </button>
            <button style={{ ...styles.backBtn, color: 'var(--red)', borderColor: 'rgba(224,62,62,0.25)' }}
              onClick={() => { deleteApp(activeApp.id); onSelectApp(null) }}>
              Delete
            </button>
          </div>
          <iframe
            ref={frameRef}
            style={styles.iframe}
            srcDoc={injectedHtml}
            sandbox="allow-scripts allow-forms allow-same-origin"
            title={activeApp.name}
          />
          {editOpen && (
            <div style={styles.editBar}>
              {editError && <div style={styles.editError}>{editError}</div>}
              <div style={styles.editInputRow}>
                <input
                  style={styles.editInput}
                  value={editPrompt}
                  onChange={e => setEditPrompt(e.target.value)}
                  placeholder="Describe your change… e.g. add a priority field, change accent color to blue"
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEdit() } }}
                  disabled={editing}
                  autoFocus
                />
                <button style={{ ...styles.buildBtn, opacity: editing ? 0.6 : 1 }} onClick={handleEdit} disabled={editing}>
                  {editing ? editProgressLabel : 'Apply →'}
                </button>
              </div>
              {editing && (
                <div style={styles.progressTrack}>
                  <div style={{ ...styles.progressFill, width: `${editProgress}%` }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  )
}

const styles = {
  wrap: { flex: 1, display: 'flex', overflow: 'hidden' },

  builderPanel: { flex: 1, display: 'flex', overflow: 'hidden' },

  promptArea: {
    flex: 1, overflowY: 'auto' as const, padding: '56px 64px 80px',
    borderRight: '1px solid var(--border)',
  },
  header: { marginBottom: 28 },
  pageIcon: { fontSize: 44, marginBottom: 12, lineHeight: 1 },
  pageTitle: { fontFamily: "'Lora', serif", fontSize: 36, fontWeight: 500, marginBottom: 6 },
  pageSub: { fontSize: 14, color: 'var(--text3)', fontStyle: 'italic' as const, fontFamily: "'Lora', serif" },

  callout: { display: 'flex', alignItems: 'flex-start', gap: 10, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 20, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.6 },
  calloutAccent: { display: 'flex', alignItems: 'flex-start', gap: 10, background: 'var(--accent-s)', border: '1px solid rgba(124,106,245,0.2)', borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 20, fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.6 },

  errorMsg: { background: 'rgba(224,62,62,0.07)', border: '1px solid rgba(224,62,62,0.2)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--radius)', fontSize: 13, marginBottom: 14 },

  promptBox: { border: '1.5px solid var(--border2)', borderRadius: 10, background: 'var(--bg)', marginBottom: 16, overflow: 'hidden', transition: 'border-color 0.2s, box-shadow 0.2s' },
  promptTextarea: { width: '100%', padding: '14px 16px 10px', background: 'none', border: 'none', outline: 'none', fontSize: 14.5, color: 'var(--text)', resize: 'none' as const, lineHeight: 1.65, caretColor: 'var(--accent)' },
  promptFooter: { display: 'flex', alignItems: 'center', padding: '8px 12px 10px', borderTop: '1px solid var(--border)', gap: 8 },
  promptHint: { fontSize: 11.5, color: 'var(--text3)', flexShrink: 0 },
  buildBtn: { padding: '8px 20px', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 'var(--radius)', fontSize: 13.5, fontWeight: 500, cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s' },
  progressTrack: { height: 2, background: 'var(--border)' },
  progressFill: { height: '100%', background: 'var(--accent)', transition: 'width 0.5s ease' },

  sourcePicker: { marginBottom: 14 },
  sourcePickerLabel: { fontSize: 11, fontWeight: 500, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '0.06em', display: 'block', marginBottom: 7 },
  sourcePickerBtns: { display: 'flex', gap: 6, flexWrap: 'wrap' as const },
  sourceBtn: { padding: '5px 11px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', fontSize: 12.5, cursor: 'pointer', transition: 'all 0.15s', fontWeight: 400 },
  sourceBtnActive: { background: 'var(--accent-s)', border: '1px solid rgba(124,106,245,0.35)', color: 'var(--accent)', fontWeight: 500 },

  chips: { display: 'flex', gap: 7, flexWrap: 'wrap' as const },
  chip: { border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text2)', padding: '5px 13px', fontSize: 12.5, borderRadius: 20, cursor: 'pointer', transition: 'all 0.12s', fontFamily: "'Lora', serif", fontStyle: 'italic' as const },

  library: { width: 320, flexShrink: 0, background: 'var(--bg2)', overflowY: 'auto' as const, padding: '24px 18px' },
  libraryTitle: { fontSize: 11, fontWeight: 500, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 14 },
  emptyLib: { fontSize: 13, color: 'var(--text3)', fontStyle: 'italic' as const, fontFamily: "'Lora', serif", lineHeight: 1.7 },
  appTile: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 8, cursor: 'pointer', transition: 'all 0.15s', position: 'relative' as const },
  appTileName: { fontSize: 13.5, fontWeight: 500, color: 'var(--text)', marginBottom: 4 },
  appTileSrcs: { fontSize: 11.5, color: 'var(--accent)', marginBottom: 3 },
  appTileDate: { fontSize: 11, color: 'var(--text3)' },
  appTileDel: { position: 'absolute' as const, top: 10, right: 10, background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 14, padding: '2px 4px', borderRadius: 3, display: 'none' },

  editBar: { borderTop: '1px solid var(--border)', background: 'var(--bg2)', padding: '12px 18px', flexShrink: 0 },
  editError: { fontSize: 12.5, color: 'var(--red)', marginBottom: 8 },
  editInputRow: { display: 'flex', gap: 8, alignItems: 'center' },
  editInput: { flex: 1, padding: '8px 12px', border: '1.5px solid var(--border2)', borderRadius: 'var(--radius)' as const, background: 'var(--bg)', fontSize: 13.5, color: 'var(--text)', outline: 'none' },

  viewer: { flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' },
  viewerBar: { padding: '10px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg2)', flexShrink: 0 },
  backBtn: { padding: '5px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12.5, color: 'var(--text2)', cursor: 'pointer', transition: 'all 0.12s' },
  viewerTitle: { fontSize: 13.5, fontWeight: 500, color: 'var(--text)', flex: 1 },
  viewerSrcs: { fontSize: 12, color: 'var(--accent)' },
  iframe: { flex: 1, border: 'none', background: 'white', width: '100%' },
}
