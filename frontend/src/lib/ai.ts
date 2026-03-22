import type { Field, SourcePlan } from '../types'

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

export interface SchemaUpdate {
  source_id: string
  source_name: string
  fields: Field[]
}

// Returns { html: string, schema_updates: SchemaUpdate[] }
export async function editApp(
  prompt: string,
  currentHtml: string,
  sources: unknown[],
): Promise<{ html: string; schema_updates: SchemaUpdate[] }> {
  return post('/api/edit-app', {
    prompt,
    current_html: currentHtml,
    sources,
  }) as Promise<{ html: string; schema_updates: SchemaUpdate[] }>
}

// Returns { html: string, name: string, source_plan: SourcePlan }
export async function generateApp(
  prompt: string,
  sources: unknown[],
  allSourceSummaries: unknown[],
  pinnedSourceIds: string[] = [],
): Promise<{ html: string; name: string; source_plan: SourcePlan }> {
  return post('/api/generate-app', {
    prompt,
    sources,
    all_source_summaries: allSourceSummaries,
    pinned_source_ids: pinnedSourceIds,
  }) as Promise<{ html: string; name: string; source_plan: SourcePlan }>
}
