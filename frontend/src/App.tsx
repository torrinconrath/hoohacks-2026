import { useState } from 'react'
import { useAuth }    from './hooks/useAuth'
import { useSources } from './hooks/useSources'
import { useApps }    from './hooks/useApps'
import AuthPage  from './pages/AuthPage'
import DataPage  from './pages/DataPage'
import BuildPage from './pages/BuildPage'
import Sidebar   from './components/Sidebar'

export default function App() {
  const { user, loading } = useAuth()
  const [view, setView]                         = useState('data')   // 'data' | 'build'
  const [activeSourceId, setActiveSourceId]     = useState<string | null>(null)
  const [activeAppId, setActiveAppId]           = useState<string | null>(null)

  const {
    sources, createSource, updateSource, deleteSource,
    getRecords, createRecord, updateRecord, deleteRecord,
    bulkCreateRecords, syncRecords,
  } = useSources(user?.id)

  const { apps, saveApp, updateApp, deleteApp } = useApps(user?.id)

  if (loading) return <Spinner />
  if (!user)   return <AuthPage />

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <Sidebar
        user={user}
        sources={sources}
        apps={apps}
        activeView={view}
        activeSourceId={activeSourceId}
        activeAppId={activeAppId}
        onNav={v => { setView(v); setActiveAppId(null) }}
        onSelectSource={id => { setActiveSourceId(id); setView('data') }}
        onSelectApp={id => { setActiveAppId(id); setView('build') }}
      />

      <main style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {view === 'data' && (
          <DataPage
            sources={sources}
            activeSourceId={activeSourceId}
            onSelectSource={setActiveSourceId}
            createSource={createSource}
            updateSource={updateSource}
            deleteSource={async id => { await deleteSource(id); setActiveSourceId(null) }}
            getRecords={getRecords}
            createRecord={createRecord}
            updateRecord={updateRecord}
            deleteRecord={deleteRecord}
            bulkCreateRecords={bulkCreateRecords}
          />
        )}
        {view === 'build' && (
          <BuildPage
            sources={sources}
            getRecords={getRecords}
            apps={apps}
            saveApp={saveApp}
            updateApp={updateApp}
            deleteApp={deleteApp}
            activeAppId={activeAppId}
            onSelectApp={id => setActiveAppId(id)}
            syncRecords={syncRecords}
            createSource={createSource}
            updateSource={updateSource}
          />
        )}
      </main>
    </div>
  )
}

function Spinner() {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 32, height: 32, border: '2px solid #e9e7e2', borderTopColor: '#7c6af5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
