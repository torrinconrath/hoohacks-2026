import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { App } from '../types'

export function useApps(userId: string | undefined) {
  const [apps, setApps]       = useState<App[]>([])
  const [loading, setLoading] = useState(true)

  // Refetch function exposed for manual refresh
  const refetch = useCallback(async () => {
    if (!userId) return
    const { data, error } = await supabase
      .from('apps')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (!error) setApps((data as App[]) || [])
    setLoading(false)
  }, [userId])

  // Initial load — inline query so setState calls stay in .then() callbacks
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    supabase
      .from('apps')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!cancelled) {
          if (!error) setApps((data as App[]) || [])
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [userId])

  async function saveApp({ name, prompt, html, sourceIds = [] }: { name: string; prompt: string; html: string; sourceIds?: string[] }) {
    const { data, error } = await supabase
      .from('apps')
      .insert({ user_id: userId, name, prompt, html, source_ids: sourceIds })
      .select()
      .single()
    if (error) throw error
    setApps(prev => [data as App, ...prev])
    return data as App
  }

  async function deleteApp(id: string) {
    const { error } = await supabase.from('apps').delete().eq('id', id)
    if (error) throw error
    setApps(prev => prev.filter(a => a.id !== id))
  }

  return { apps, loading, saveApp, deleteApp, refetch }
}
