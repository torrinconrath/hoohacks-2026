import type { Field } from '../types'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail || `API error ${res.status}`)
  }
  return res.json()
}

// Returns { fields: [...], records: [...] }
export async function inferSchema(type: string, name: string, rawText: string): Promise<{ fields: Field[]; records: Record<string, unknown>[] }> {
  return post('/api/infer-schema', { type, name, raw_text: rawText }) as Promise<{ fields: Field[]; records: Record<string, unknown>[] }>
}

// Returns { html: string, name: string }
export async function generateApp(prompt: string, sources: unknown[]): Promise<{ html: string; name: string }> {
  return post('/api/generate-app', { prompt, sources }) as Promise<{ html: string; name: string }>
}
