import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { notionExchangeCode, notionListDatabases, notionQueryDatabase, notionPushDatabase } from '../lib/ai'
import type { Field } from '../types'

export interface NotionConnection {
  id: string
  user_id: string
  access_token: string
  workspace_id: string
  workspace_name: string
  bot_id: string
  created_at: string
}

export function useNotion(userId: string | undefined) {
  const [connection, setConnection] = useState<NotionConnection | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!userId) { setLoading(false); return }
    let cancelled = false
    supabase
      .from('notion_connections')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setConnection(data as NotionConnection | null)
          if (data?.access_token) {
            localStorage.setItem('vibe_notion_token', data.access_token)
          }
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [userId])

  const connectNotion = useCallback(async (code: string) => {
    const tokenData = await notionExchangeCode(code)
    const { data, error } = await supabase
      .from('notion_connections')
      .upsert({
        user_id: userId,
        access_token: tokenData.access_token,
        workspace_id: tokenData.workspace_id,
        workspace_name: tokenData.workspace_name,
        bot_id: tokenData.bot_id,
      }, { onConflict: 'user_id' })
      .select()
      .single()
    if (error) throw error
    const conn = data as NotionConnection
    localStorage.setItem('vibe_notion_token', conn.access_token)
    setConnection(conn)
    return conn
  }, [userId])

  const disconnectNotion = useCallback(async () => {
    if (!userId) return
    await supabase.from('notion_connections').delete().eq('user_id', userId)
    localStorage.removeItem('vibe_notion_token')
    setConnection(null)
  }, [userId])

  const listDatabases = useCallback((token: string) => {
    return notionListDatabases(token)
  }, [])

  const queryDatabase = useCallback((token: string, databaseId: string) => {
    return notionQueryDatabase(token, databaseId)
  }, [])

  const pushDatabase = useCallback((token: string, databaseId: string, records: Record<string, unknown>[], fields: Field[]) => {
    return notionPushDatabase(token, databaseId, records, fields)
  }, [])

  return {
    connection,
    loading,
    connectNotion,
    disconnectNotion,
    listDatabases,
    queryDatabase,
    pushDatabase,
  }
}
