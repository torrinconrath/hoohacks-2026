import { useEffect, useState } from 'react'

interface NotionCallbackPageProps {
  onConnect: (code: string) => Promise<void>
  onDone: () => void
}

export default function NotionCallbackPage({ onConnect, onDone }: NotionCallbackPageProps) {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const errorParam = params.get('error')

    if (errorParam) {
      setError(`Notion authorization failed: ${errorParam}`)
      setStatus('error')
      return
    }
    if (!code) {
      setError('No authorization code received from Notion.')
      setStatus('error')
      return
    }

    onConnect(code)
      .then(() => {
        setStatus('success')
        setTimeout(onDone, 1200)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to connect Notion.')
        setStatus('error')
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        {status === 'loading' && (
          <>
            <div style={styles.spinner} />
            <div style={styles.title}>Connecting to Notion…</div>
          </>
        )}
        {status === 'success' && (
          <>
            <div style={styles.checkmark}>✓</div>
            <div style={styles.title}>Notion connected!</div>
            <div style={styles.sub}>Taking you back…</div>
          </>
        )}
        {status === 'error' && (
          <>
            <div style={styles.errorIcon}>✕</div>
            <div style={styles.title}>Connection failed</div>
            <div style={styles.errorMsg}>{error}</div>
            <button style={styles.btn} onClick={onDone}>Back to app</button>
          </>
        )}
      </div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  )
}

const styles = {
  wrap: {
    height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#f9f8f5',
  },
  card: {
    background: 'white', borderRadius: 16, padding: '48px 56px', textAlign: 'center' as const,
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)', display: 'flex', flexDirection: 'column' as const,
    alignItems: 'center', gap: 12, animation: 'fadeIn 0.3s ease',
  },
  spinner: {
    width: 40, height: 40, border: '3px solid #e9e7e2', borderTopColor: '#7c6af5',
    borderRadius: '50%', animation: 'spin 0.7s linear infinite', marginBottom: 8,
  },
  checkmark: {
    width: 48, height: 48, borderRadius: '50%', background: '#e6faf3', color: '#1a9e6a',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
    fontWeight: 700, marginBottom: 8,
  },
  errorIcon: {
    width: 48, height: 48, borderRadius: '50%', background: 'rgba(224,62,62,0.1)', color: '#e03e3e',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
    fontWeight: 700, marginBottom: 8,
  },
  title: { fontSize: 20, fontWeight: 600, color: '#1a1915' },
  sub: { fontSize: 14, color: '#8b8880' },
  errorMsg: { fontSize: 13.5, color: '#e03e3e', maxWidth: 320, lineHeight: 1.5 },
  btn: {
    marginTop: 8, padding: '8px 20px', background: '#7c6af5', color: 'white',
    border: 'none', borderRadius: 8, fontSize: 13.5, fontWeight: 500, cursor: 'pointer',
  },
}
