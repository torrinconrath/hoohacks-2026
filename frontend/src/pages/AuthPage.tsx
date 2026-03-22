import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function AuthPage() {
  const [email, setEmail]   = useState('')
  const [sent, setSent]     = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState('')

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    })
    setLoading(false)
    if (error) setError(error.message)
    else setSent(true)
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.icon}>✦</div>
        <h1 style={styles.title}>Mugen</h1>
        <p style={styles.sub}>Infinite possibilities. Connect your data, build anything you can imagine.</p>

        {sent ? (
          <div style={styles.sent}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📬</div>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Check your email</div>
            <div style={{ fontSize: 13, color: 'var(--text3)', lineHeight: 1.6 }}>
              We sent a magic link to <strong>{email}</strong>.<br />
              Click it to sign in — no password needed.
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={styles.form}>
            <label style={styles.label}>Email address</label>
            <input
              style={styles.input}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
            />
            {error && <div style={styles.error}>{error}</div>}
            <button style={styles.btn} disabled={loading}>
              {loading ? 'Sending…' : 'Continue with email →'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const styles = {
  wrap: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg2)',
  },
  card: {
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '48px 40px',
    width: '100%',
    maxWidth: 400,
    textAlign: 'center' as const,
    boxShadow: 'var(--shadow-md)',
  },
  icon: {
    width: 48, height: 48,
    background: 'linear-gradient(135deg, #c4b8f5, #a594f5)',
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    margin: '0 auto 16px',
  },
  title: {
    fontFamily: "'Lora', serif",
    fontSize: 28,
    fontWeight: 500,
    marginBottom: 8,
  },
  sub: {
    fontSize: 14,
    color: 'var(--text3)',
    fontFamily: "'Lora', serif",
    fontStyle: 'italic',
    marginBottom: 32,
    lineHeight: 1.6,
  },
  form: { display: 'flex', flexDirection: 'column' as const, gap: 10, textAlign: 'left' as const },
  label: { fontSize: 12, fontWeight: 500, color: 'var(--text2)' },
  input: {
    padding: '10px 14px',
    border: '1px solid var(--border2)',
    borderRadius: 'var(--radius)',
    fontSize: 14,
    outline: 'none',
    transition: 'border-color 0.15s',
  },
  error: {
    background: 'rgba(224,62,62,0.08)',
    border: '1px solid rgba(224,62,62,0.2)',
    color: 'var(--red)',
    padding: '8px 12px',
    borderRadius: 'var(--radius)',
    fontSize: 13,
  },
  btn: {
    marginTop: 4,
    padding: '11px 20px',
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: 'var(--radius)',
    fontSize: 14,
    fontWeight: 500,
    transition: 'all 0.15s',
  },
  sent: {
    padding: '8px 0',
    lineHeight: 1.5,
  },
}