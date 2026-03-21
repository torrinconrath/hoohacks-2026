import { useState, useEffect, useRef, useCallback } from 'react'
import { generateApp } from '../lib/ai'
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
  deleteApp: (id: string) => Promise<void>
  activeAppId: string | null
  onSelectApp: (id: string | null) => void
  syncRecords: (sourceId: string, recordsData: Record<string, unknown>[]) => Promise<void>
  createSource: (params: { name: string; type: string; icon?: string; fields?: Field[] }) => Promise<Source>
  updateSource: (id: string, updates: Partial<Source>) => Promise<Source>
}

export default function BuildPage({ sources, getRecords, apps, saveApp, deleteApp, activeAppId, onSelectApp, syncRecords, createSource, updateSource }: BuildPageProps) {
  const [prompt, setPrompt]               = useState('')
  const [building, setBuilding]           = useState(false)
  const [error, setError]                 = useState('')
  const [progress, setProgress]           = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const frameRef = useRef<HTMLIFrameElement>(null)

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
      } else if (src.fields.length === 0 && records.length > 0) {
        // Companion source has no fields yet — infer and update
        const inferredFields: Field[] = Object.keys(records[0]).filter(k => k !== 'id').map(k => ({
          key: k,
          label: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          type: inferFieldType(records[0][k]),
        }))
        await updateSource(src.id, { fields: inferredFields })
      }
      await syncRecords(src.id, records)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [sources, syncRecords, createSource, updateSource])

  // ── Detect relevant sources from prompt ───────────────────────────────────
  function getRelevantSources(promptText: string): Source[] {
    if (!sources.length) return []
    const p = promptText.toLowerCase()
    const kw: Record<string, string[]> = {
      tasks:    ['task','todo','list','work','project','do','done','backlog','checklist'],
      habits:   ['habit','streak','daily','routine','health','track','morning','check'],
      finances: ['money','spend','budget','expense','finance','cost','income','saving','transaction','net worth'],
      notes:    ['note','journal','write','thought','diary','entry','mood','log'],
      calendar: ['event','calendar','schedule','upcoming','date','plan','meeting','appointment'],
    }
    return sources.filter(src => {
      const words = kw[src.type] || []
      return words.some(k => p.includes(k)) || p.includes(src.name.toLowerCase())
    })
  }

  const relevantSources = getRelevantSources(prompt)

  // ── Build ─────────────────────────────────────────────────────────────────
  async function handleBuild() {
    if (!prompt.trim()) return
    setBuilding(true)
    setError('')
    setProgress(5)
    setProgressLabel('Analyzing prompt…')

    try {
      // Fetch records for relevant sources
      setProgress(20)
      setProgressLabel('Loading your data…')

      const sourcesWithRecords = await Promise.all(
        relevantSources.map(async src => {
          const records = await getRecords(src.id)
          return { ...src, records: records.map(r => r.data) }
        })
      )

      setProgress(40)
      setProgressLabel('Generating app…')
      const { html, name: appName } = await generateApp(prompt, sourcesWithRecords)
      console.log(html);
      if (!html || !html.includes('<')) throw new Error('No valid app generated. Try rephrasing.')

      setProgress(88)
      setProgressLabel('Finishing up…')

      // Create companion source for app-owned data
      const companion = await createSource({ name: appName, type: 'custom', icon: '⚡', fields: [] })

      const app = await saveApp({
        name: appName,
        prompt,
        html,
        sourceIds: [...relevantSources.map(s => s.id), companion.id]
      })

      setProgress(100)
      setPrompt('')
      onSelectApp(app.id)

    } catch(err) {
        console.log(err);
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBuilding(false)
      setProgress(0)
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
              {relevantSources.length > 0 && (
                <div style={styles.pills}>
                  {relevantSources.map(s => (
                    <span key={s.id} style={styles.pill}>🗄️ {s.name}</span>
                  ))}
                </div>
              )}
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
            <button style={{ ...styles.backBtn, marginLeft: 'auto', color: 'var(--red)', borderColor: 'rgba(224,62,62,0.25)' }}
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
  pills: { display: 'flex', gap: 5, flex: 1, flexWrap: 'wrap' as const },
  pill: { fontSize: 11, fontWeight: 500, padding: '3px 9px', borderRadius: 20, background: 'var(--accent-s)', color: 'var(--accent)', border: '1px solid rgba(124,106,245,0.2)' },
  buildBtn: { padding: '8px 20px', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 'var(--radius)', fontSize: 13.5, fontWeight: 500, cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s' },
  progressTrack: { height: 2, background: 'var(--border)' },
  progressFill: { height: '100%', background: 'var(--accent)', transition: 'width 0.5s ease' },

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

  viewer: { flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' },
  viewerBar: { padding: '10px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg2)', flexShrink: 0 },
  backBtn: { padding: '5px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12.5, color: 'var(--text2)', cursor: 'pointer', transition: 'all 0.12s' },
  viewerTitle: { fontSize: 13.5, fontWeight: 500, color: 'var(--text)', flex: 1 },
  viewerSrcs: { fontSize: 12, color: 'var(--accent)' },
  iframe: { flex: 1, border: 'none', background: 'white', width: '100%' },
}
