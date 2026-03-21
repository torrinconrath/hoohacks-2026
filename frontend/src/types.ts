export interface Field {
  key: string
  label: string
  type: string
  options?: string[]
}

export interface Source {
  id: string
  user_id: string
  name: string
  type: string
  icon: string
  fields: Field[]
  created_at: string
}

export interface AppRecord {
  id: string
  source_id: string
  user_id: string
  data: Record<string, unknown>
  position: number
}

export interface App {
  id: string
  user_id: string
  name: string
  prompt: string
  html: string
  source_ids: string[]
  created_at: string
}
