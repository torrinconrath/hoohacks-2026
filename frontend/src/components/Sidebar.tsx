import { useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Source, App } from '../types'
import SettingsModal from './SettingsModal'

interface SidebarProps {
  user: User
  sources: Source[]
  apps: App[]
  activeView: string
  activeSourceId: string | null
  activeAppId: string | null
  onNav: (v: string) => void
  onSelectSource: (id: string | null) => void
  onSelectApp: (id: string) => void
}

const TYPE_COLORS: Record<string, string> = {
  tasks:    '#0969a2',
  habits:   '#0d7a6a',
  finances: '#c97d10',
  notes:    '#a85500',
  calendar: '#6234b5',
  custom:   '#57544c',
  app:      '#7c6af5',
}

export default function Sidebar({ user, sources, apps, activeView, activeSourceId, activeAppId, onNav, onSelectSource, onSelectApp }: SidebarProps) {
  const [showSettings, setShowSettings] = useState(false)
  const hasKey = !!localStorage.getItem('vibe_anthropic_key')

  return (
    <aside style={styles.sidebar}>
      {/* Workspace header */}
      <div style={styles.top}>
        <div style={styles.wsRow}>
          <div style={styles.wsIcon}>✦</div>
          <div style={styles.wsName}>My Workspace</div>
        </div>
      </div>

      <div style={styles.scroll}>
        {/* Main nav */}
        <div style={{ padding: '8px 0 4px' }}>
          <NavItem icon="🗄️" label="Data" active={activeView === 'data' && !activeAppId} onClick={() => onNav('data')} />
          <NavItem icon="⚡" label="Apps" badge={apps.length} active={activeView === 'build' && !activeAppId} onClick={() => onNav('build')} />
        </div>

        <Divider />

        {/* Data sources */}
        <SectionLabel>Data Sources</SectionLabel>
        {sources.filter(s => s.type !== 'app').map(src => (
          <SourceItem
            key={src.id}
            src={src}
            active={activeSourceId === src.id}
            color={TYPE_COLORS[src.type] || TYPE_COLORS['custom']}
            onClick={() => { onNav('data'); onSelectSource(src.id) }}
          />
        ))}
        <div style={styles.addBtn} onClick={() => { onNav('data'); onSelectSource(null) }}>
          <span style={{ fontSize: 15 }}>+</span> Add source
        </div>

        {sources.some(s => s.type === 'app') && (
          <>
            <Divider />
            <SectionLabel>App Data</SectionLabel>
            {sources.filter(s => s.type === 'app').map(src => (
              <SourceItem
                key={src.id}
                src={src}
                active={activeSourceId === src.id}
                color={TYPE_COLORS['app']}
                onClick={() => { onNav('data'); onSelectSource(src.id) }}
              />
            ))}
          </>
        )}

        <Divider />

        {/* App library */}
        <SectionLabel>App Library</SectionLabel>
        {apps.length === 0 && (
          <div style={styles.emptyNav}>No apps yet</div>
        )}
        {apps.slice(0, 8).map(app => (
          <NavItem
            key={app.id}
            icon="⚡"
            iconSize={12}
            label={app.name}
            active={activeAppId === app.id}
            onClick={() => { onNav('build'); onSelectApp(app.id) }}
          />
        ))}
      </div>

      {/* User footer */}
      <div style={styles.footer}>
        <div style={styles.footerEmail}>{user.email}</div>
        <button
          style={{ ...styles.signOut, color: hasKey ? 'var(--text3)' : '#e07b00' }}
          onClick={() => setShowSettings(true)}
          title={hasKey ? 'Settings' : 'API key required — click to add'}
        >
          {hasKey ? '⚙' : '⚠ Key'}
        </button>
        <button style={styles.signOut} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </aside>
  )
}

interface NavItemProps {
  icon: string
  label: string
  badge?: number
  active: boolean
  onClick: () => void
  iconSize?: number
}

function NavItem({ icon, label, badge, active, onClick, iconSize = 14 }: NavItemProps) {
  return (
    <div style={{ ...styles.navItem, ...(active ? styles.navItemActive : {}) }} onClick={onClick}>
      <span style={{ width: 18, textAlign: 'center', fontSize: iconSize, flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {badge != null && (
        <span style={{ ...styles.badge, ...(active ? styles.badgeActive : {}) }}>{badge}</span>
      )}
    </div>
  )
}

interface SourceItemProps {
  src: Source
  active: boolean
  color: string
  onClick: () => void
}

function SourceItem({ src, active, color, onClick }: SourceItemProps) {
  return (
    <div style={{ ...styles.sourceItem, ...(active ? styles.sourceItemActive : {}) }} onClick={onClick}>
      <div style={{ ...styles.sourceDot, background: color }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{src.name}</span>
    </div>
  )
}

interface SectionLabelProps {
  children: ReactNode
}

function SectionLabel({ children }: SectionLabelProps) {
  return <div style={styles.sectionLabel}>{children}</div>
}

function Divider() {
  return <div style={styles.divider} />
}

const styles = {
  sidebar: {
    width: 240,
    flexShrink: 0,
    background: 'var(--sidebar)',
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    userSelect: 'none' as const,
  },
  top: { padding: '14px 12px 8px', borderBottom: '1px solid var(--border)' },
  wsRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 'var(--radius)', cursor: 'pointer' },
  wsIcon: {
    width: 26, height: 26,
    background: 'linear-gradient(135deg, #c4b8f5, #a594f5)',
    borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
  },
  wsName: { fontSize: 13.5, fontWeight: 500 },
  scroll: { flex: 1, overflowY: 'auto' as const, padding: '4px 0' },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '5px 8px 5px 14px',
    cursor: 'pointer', color: 'var(--text2)', fontSize: 13.5,
    transition: 'background 0.1s',
    borderRadius: 0,
    position: 'relative' as const,
  },
  navItemActive: {
    background: 'var(--bg3)',
    color: 'var(--text)',
  },
  badge: {
    fontSize: 11, background: 'var(--bg4)', color: 'var(--text3)',
    padding: '1px 6px', borderRadius: 10,
  },
  badgeActive: { background: 'var(--accent-m)', color: 'var(--accent)' },
  sourceItem: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 8px 4px 22px',
    cursor: 'pointer', color: 'var(--text2)', fontSize: 13,
    transition: 'background 0.1s',
  },
  sourceItemActive: { background: 'var(--bg3)', color: 'var(--text)' },
  sourceDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  addBtn: {
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '5px 8px 5px 14px',
    cursor: 'pointer', color: 'var(--text3)', fontSize: 13,
    transition: 'color 0.1s',
  },
  sectionLabel: {
    padding: '8px 14px 3px',
    fontSize: 11, fontWeight: 500, color: 'var(--text3)',
    letterSpacing: '0.04em', textTransform: 'uppercase' as const,
  },
  divider: { margin: '6px 12px', borderTop: '1px solid var(--border)' },
  emptyNav: {
    padding: '4px 22px 8px',
    fontSize: 12.5, color: 'var(--text3)',
    fontStyle: 'italic' as const, fontFamily: "'Lora', serif",
  },
  footer: {
    padding: '10px 14px',
    borderTop: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', gap: 8,
  },
  footerEmail: { flex: 1, fontSize: 11.5, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  signOut: { background: 'none', border: 'none', fontSize: 11.5, color: 'var(--text3)', cursor: 'pointer', padding: '2px 4px' },
}
