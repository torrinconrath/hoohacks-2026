import { useState } from 'react'

interface SettingsModalProps {
  onClose: () => void
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [key, setKey] = useState(() => localStorage.getItem('vibe_anthropic_key') ?? '')
  const [saved, setSaved] = useState(false)

  function save() {
    localStorage.setItem('vibe_anthropic_key', key.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.title}>Settings</div>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={styles.body}>
          <label style={styles.label}>Anthropic API Key</label>
          <input
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="sk-ant-..."
            style={styles.input}
            autoFocus
          />
          <p style={styles.hint}>
            Your key is stored locally in your browser and sent to the backend only to power AI generation.
            Get a key at <span style={styles.link}>console.anthropic.com</span>.
          </p>
          <button style={styles.saveBtn} onClick={save} disabled={!key.trim()}>
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--bg2)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    width: 420,
    maxWidth: '90vw',
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  },
  header: {
    display: 'flex', alignItems: 'center',
    padding: '16px 20px 12px',
    borderBottom: '1px solid var(--border)',
  },
  title: { flex: 1, fontSize: 15, fontWeight: 600, color: 'var(--text)' },
  closeBtn: {
    background: 'none', border: 'none',
    fontSize: 16, color: 'var(--text3)',
    cursor: 'pointer', padding: '2px 4px',
  },
  body: { padding: '20px' },
  label: { display: 'block', fontSize: 12.5, fontWeight: 500, color: 'var(--text2)', marginBottom: 8 },
  input: {
    width: '100%', boxSizing: 'border-box',
    padding: '9px 12px',
    background: 'var(--bg)', border: '1px solid var(--border)',
    borderRadius: 8, fontSize: 13.5, color: 'var(--text)',
    outline: 'none',
    fontFamily: 'monospace',
  },
  hint: {
    fontSize: 12, color: 'var(--text3)',
    margin: '10px 0 16px', lineHeight: 1.5,
  },
  link: { color: 'var(--accent)', cursor: 'pointer' },
  saveBtn: {
    padding: '8px 20px',
    background: 'var(--accent)', color: '#fff',
    border: 'none', borderRadius: 8,
    fontSize: 13.5, fontWeight: 500,
    cursor: 'pointer',
  },
}
