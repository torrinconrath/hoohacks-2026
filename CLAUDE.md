# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Mugen** — an AI-powered personal productivity app generator built at HooHacks 2026. Users manage structured data sources and prompt Claude to generate custom HTML5 apps that read/write that data.

## Commands

### Backend

```bash
cd backend
source venv/Scripts/activate        # Windows (Git Bash)
python -m uvicorn main:app --reload  # Dev server at http://localhost:8000
# Swagger docs at http://localhost:8000/docs
```

### Frontend

```bash
cd frontend
npm run dev      # Dev server at http://localhost:5173
npm run build    # Production build → dist/
npm run lint     # ESLint
npm run preview  # Preview production build
```

## Environment Variables

**backend/.env**
- `ANTHROPIC_API_KEY` — Claude API key (required)
- `ALLOWED_ORIGINS` — CORS origins (default: `http://localhost:5173`)

**frontend/.env**
- `VITE_SUPABASE_URL` — Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Supabase public anon key
- `VITE_API_URL` — Backend URL (default: `http://localhost:8000`)

## Architecture

### Stack
- **Backend**: Python + FastAPI + Anthropic SDK (Claude Sonnet 4)
- **Frontend**: React 19 + TypeScript + Vite
- **Database & Auth**: Supabase (PostgreSQL + auth)

### Backend (`backend/main.py`)

All API logic lives in a single file. Two main AI-powered endpoints:

- `POST /api/infer-schema` — Takes raw pasted text and converts it into structured fields + records via Claude
- `POST /api/generate-app` — Takes a user prompt + data sources and returns a complete self-contained HTML5 app as a string

### Frontend Data Flow

1. **Auth** — Supabase auth handled in `AuthPage.tsx` via `useAuth` hook
2. **Data sources** — Users create sources (tasks, habits, finances, notes, calendar, custom) in `DataPage.tsx`. Sources have typed `fields[]`; records store JSON `data`. Managed via `useSources` hook.
3. **App generation** — `BuildPage.tsx` detects relevant sources from prompt keywords, calls the backend, and renders the returned HTML in an iframe. Managed via `useApps` hook.

### App ↔ Parent Data Bridge

Generated apps communicate with the parent via two mechanisms:
- **Read**: `window.vibeDB[sourceName]` — array of record data injected before iframe load
- **Write**: `postMessage({ type: 'vibeDB:write', sourceName, records })` — parent listens and syncs records back to Supabase

### Data Model
- **sources**: `id, user_id, name, type, icon, fields[], created_at`
- **records**: `id, source_id, user_id, data (JSON), position`
- **apps**: `id, user_id, name, prompt, html, source_ids[]`

### Key Files
- `backend/main.py` — All API routes and Claude integration
- `frontend/src/lib/supabase.ts` — Supabase client
- `frontend/src/lib/ai.ts` — Backend API calls
- `frontend/src/pages/BuildPage.tsx` — App generation UI and vibeDB bridge
- `frontend/src/pages/DataPage.tsx` — Source/record management
