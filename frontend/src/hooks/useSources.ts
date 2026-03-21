import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { Source, AppRecord, Field } from '../types'

export function useSources(userId: string | undefined) {
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(true)

  // Refetch function exposed for manual refresh
  const refetch = useCallback(async () => {
    if (!userId) return
    const { data, error } = await supabase
      .from('sources')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    if (!error) setSources((data as Source[]) || [])
    setLoading(false)
  }, [userId])

  // Initial load — inline query so setState calls stay in .then() callbacks
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    supabase
      .from('sources')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (!cancelled) {
          if (!error) setSources((data as Source[]) || [])
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [userId])

  // ── Sources ──────────────────────────────────────────────────────────────

  async function createSource({ name, type, icon = '📋', fields = [] }: { name: string; type: string; icon?: string; fields?: Field[] }) {
    const { data, error } = await supabase
      .from('sources')
      .insert({ user_id: userId, name, type, icon, fields })
      .select()
      .single()
    if (error) throw error
    setSources(prev => [...prev, data as Source])
    return data as Source
  }

  async function updateSource(id: string, updates: Partial<Source>) {
    const { data, error } = await supabase
      .from('sources')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    setSources(prev => prev.map(s => s.id === id ? data as Source : s))
    return data as Source
  }

  async function deleteSource(id: string) {
    const { error } = await supabase.from('sources').delete().eq('id', id)
    if (error) throw error
    setSources(prev => prev.filter(s => s.id !== id))
  }

  // ── Records ──────────────────────────────────────────────────────────────

  const getRecords = useCallback(async (sourceId: string): Promise<AppRecord[]> => {
    const { data, error } = await supabase
      .from('records')
      .select('*')
      .eq('source_id', sourceId)
      .order('position', { ascending: true })
    if (error) throw error
    return (data as AppRecord[]) || []
  }, [])

  async function createRecord(sourceId: string, recordData: Record<string, unknown>) {
    const { data, error } = await supabase
      .from('records')
      .insert({ source_id: sourceId, user_id: userId, data: recordData })
      .select()
      .single()
    if (error) throw error
    return data as AppRecord
  }

  async function updateRecord(recordId: string, recordData: Record<string, unknown>) {
    const { data, error } = await supabase
      .from('records')
      .update({ data: recordData })
      .eq('id', recordId)
      .select()
      .single()
    if (error) throw error
    return data as AppRecord
  }

  async function deleteRecord(recordId: string) {
    const { error } = await supabase.from('records').delete().eq('id', recordId)
    if (error) throw error
  }

  // Bulk-insert records (used after AI schema inference)
  async function bulkCreateRecords(sourceId: string, recordsData: Record<string, unknown>[]) {
    const rows = recordsData.map((d, i) => ({
      source_id: sourceId,
      user_id: userId,
      data: d,
      position: i
    }))
    const { data, error } = await supabase.from('records').insert(rows).select()
    if (error) throw error
    return (data as AppRecord[]) || []
  }

  // Write-back from vibeDB bridge: replace all records for a source
  async function syncRecords(sourceId: string, recordsData: Record<string, unknown>[]) {
    await supabase.from('records').delete().eq('source_id', sourceId)
    if (recordsData.length > 0) {
      await bulkCreateRecords(sourceId, recordsData)
    }
  }

  return {
    sources, loading, refetch,
    createSource, updateSource, deleteSource,
    getRecords, createRecord, updateRecord, deleteRecord,
    bulkCreateRecords, syncRecords,
  }
}
