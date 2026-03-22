import type { Field, SourcePlan } from '../types'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = localStorage.getItem('vibe_anthropic_key')
  if (key) headers['X-Anthropic-Key'] = key
  return headers
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: getHeaders(),
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

export interface SchemaUpdate {
  source_id: string
  source_name: string
  fields: Field[]
}


export type EditStreamEvent =
  | { type: 'audio'; data: string }
  | { type: 'result'; html: string; schema_updates: SchemaUpdate[] }
  | { type: 'error'; detail: string }

export async function* editAppStream(
  prompt: string,
  currentHtml: string,
  sources: unknown[],
): AsyncGenerator<EditStreamEvent> {
  const res = await fetch(`${API}/api/edit-app-stream`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ prompt, current_html: currentHtml, sources }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail || `API error ${res.status}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return
      try { yield JSON.parse(data) } catch { /* skip malformed */ }
    }
  }
}


export type StreamEvent =
  | { type: 'audio'; data: string }
  | { type: 'result'; html: string; name: string; source_plan: SourcePlan }
  | { type: 'error'; detail: string }

// Streams narration audio + final result via SSE
export async function* generateAppStream(
  prompt: string,
  sources: unknown[],
  allSourceSummaries: unknown[],
  pinnedSourceIds: string[] = [],
): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${API}/api/generate-app-stream`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      prompt,
      sources,
      all_source_summaries: allSourceSummaries,
      pinned_source_ids: pinnedSourceIds,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail || `API error ${res.status}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return
      try { yield JSON.parse(data) } catch { /* skip malformed */ }
    }
  }
}
