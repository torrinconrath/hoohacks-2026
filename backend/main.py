import os
import json
import queue
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import anthropic

from tts_narrator import AppNarrator, generate_app_with_narration

load_dotenv()

# ── Anthropic client ──────────────────────────────────────────────────────────
# Global fallback client (used only if ANTHROPIC_API_KEY env var is set, e.g. local dev)
_env_api_key = os.getenv("ANTHROPIC_API_KEY")
_fallback_client = anthropic.Anthropic(api_key=_env_api_key) if _env_api_key else None
MODEL       = "claude-sonnet-4-5"
MODEL_FAST  = "claude-haiku-4-5-20251001"   # non-thinking, simple tasks


def get_client(request: Request) -> anthropic.Anthropic:
    """Return an Anthropic client using the per-request API key header, falling back to env var."""
    key = request.headers.get("X-Anthropic-Key", "").strip()
    if key:
        return anthropic.Anthropic(api_key=key)
    if _fallback_client is not None:
        return _fallback_client
    raise HTTPException(
        status_code=400,
        detail="Anthropic API key required. Add yours in Settings."
    )

# ── Narrator ──────────────────────────────────────────────────────────────────
narrator = AppNarrator()

# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Vibe API ready")
    yield

app = FastAPI(title="Vibe API", lifespan=lifespan)

allowed_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in allowed_origins],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ── Helpers ───────────────────────────────────────────────────────────────────
def claude(client: anthropic.Anthropic, system: str, user: str, max_tokens: int = 2000, model: str = MODEL_FAST) -> str:
    msg = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    # find the text block (thinking models may prepend a ThinkingBlock)
    text_block = next((b for b in msg.content if b.type == "text"), None)
    if text_block is None:
        raise ValueError(f"No text block in response: {msg.content}")
    return text_block.text

def strip_fences(text: str) -> str:
    return text.replace("```json", "").replace("```html", "").replace("```", "").strip()

# ── Request / Response models ─────────────────────────────────────────────────

class InferSchemaRequest(BaseModel):
    type: str   # tasks | habits | finances | notes | calendar | custom
    name: str
    raw_text: str

class Field(BaseModel):
    key: str
    label: str
    type: str
    options: list[str] | None = None

class InferSchemaResponse(BaseModel):
    fields: list[dict]
    records: list[dict]

class SourceData(BaseModel):
    id: str = ""   # empty for generate-app, populated for edit-app
    name: str
    type: str
    fields: list[dict]
    records: list[dict]

class ExistingSourceSummary(BaseModel):
    id: str
    name: str
    type: str
    fields: list[dict]

class PlannedNewSource(BaseModel):
    name: str
    type: str
    icon: str
    fields: list[dict]

class PlannedExistingSource(BaseModel):
    source_id: str
    source_name: str

class SourcePlan(BaseModel):
    existing_sources: list[PlannedExistingSource] = []
    new_sources: list[PlannedNewSource] = []

class SchemaUpdate(BaseModel):
    source_id: str
    source_name: str
    fields: list[dict]

class EditAppRequest(BaseModel):
    prompt: str
    current_html: str
    sources: list[SourceData] = []

class GenerateAppRequest(BaseModel):
    prompt: str
    sources: list[SourceData] = []
    all_source_summaries: list[ExistingSourceSummary] = []
    pinned_source_ids: list[str] = []

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/infer-schema", response_model=InferSchemaResponse)
def infer_schema(req: InferSchemaRequest, request: Request):
    c = get_client(request)
    system = """You are a data structuring AI. Convert raw personal data into structured JSON.
Return ONLY valid JSON — no markdown fences, no explanation:
{
  "fields": [{"key":"id","label":"ID","type":"text"}, ...],
  "records": [{"id":"1", ...}, ...]
}

Field types allowed: text, number, boolean, date, select, url
Always include an "id" field (sequential strings "1","2"...).
Field key rules: lowercase, underscores only (e.g. due_date not dueDate).

Infer the best fields for the data type:
- tasks:    title(text), priority(select: high/medium/low), due_date(date), completed(boolean), notes(text)
- habits:   name(text), frequency(select: daily/weekly), streak(number), last_done(date), category(select)
- finances: description(text), amount(number), category(select), date(date), type(select: income/expense)
- notes:    title(text), content(text), date(date), mood(select: great/good/okay/bad), tags(text)
- calendar: title(text), date(date), time(text), location(text), notes(text)
- custom:   infer the best fields from the content

For select fields, add an "options" array.
Parse ALL items from the input. Be thorough."""

    user = f"Type: {req.type}\nName: {req.name}\n\nRaw data:\n{req.raw_text}"

    try:
        raw = claude(c, system, user, max_tokens=3000)
        data = json.loads(strip_fences(raw))
        return InferSchemaResponse(**data)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"AI returned invalid JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def plan_sources(client: anthropic.Anthropic, prompt: str, all_source_summaries: list[ExistingSourceSummary], pinned_source_ids: list[str] = []) -> SourcePlan:
    tools = [
        {
            "name": "link_existing_source",
            "description": "Link one of the user's existing data sources to this app. Call this for each existing source the app should read from or write to.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "source_id":   {"type": "string", "description": "UUID of the existing source"},
                    "source_name": {"type": "string", "description": "Exact name of the existing source"}
                },
                "required": ["source_id", "source_name"]
            }
        },
        {
            "name": "create_new_source",
            "description": "Create a brand-new data source for app-specific data. Only call this if NO existing source covers this data — never create a duplicate of an existing source.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "type": {"type": "string", "enum": ["tasks", "habits", "finances", "notes", "calendar", "custom"]},
                    "icon": {"type": "string", "description": "An appropriate emoji"},
                    "fields": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "key":     {"type": "string", "description": "snake_case field key"},
                                "label":   {"type": "string"},
                                "type":    {"type": "string", "enum": ["text", "number", "boolean", "date", "select", "url"]},
                                "options": {"type": "array", "items": {"type": "string"}}
                            },
                            "required": ["key", "label", "type"]
                        }
                    }
                },
                "required": ["name", "type", "icon", "fields"]
            }
        }
    ]

    system = """You are planning data sources for a personal productivity app.

RULES (follow exactly):
- If an existing source already covers data the app needs, ALWAYS call link_existing_source for it.
- NEVER call create_new_source for something an existing source already covers.
- Only call create_new_source for truly app-specific data that has no existing source.
- If the app needs no persistent data at all, call neither tool.
- Pinned sources MUST be linked unconditionally."""

    source_lines = "\n".join(
        f"- id: {s.id} | name: {s.name} | type: {s.type} | fields: {', '.join(f['key'] for f in s.fields)}"
        for s in all_source_summaries
    ) or "None"

    pinned_note = ""
    if pinned_source_ids:
        pinned = [s for s in all_source_summaries if s.id in pinned_source_ids]
        pinned_note = f"\n\nUser has pinned these sources (MUST link): {[s.name for s in pinned]}"

    user = f'App prompt: "{prompt}"\n\nUser\'s existing data sources:\n{source_lines}{pinned_note}'

    try:
        msg = client.messages.create(
            model=MODEL_FAST,
            max_tokens=1200,
            tools=tools,
            system=system,
            messages=[{"role": "user", "content": user}],
        )

        existing_sources = []
        new_sources = []
        seen_ids: set[str] = set()

        for block in msg.content:
            if block.type != "tool_use":
                continue
            if block.name == "link_existing_source":
                inp = block.input
                if inp["source_id"] not in seen_ids:
                    existing_sources.append(PlannedExistingSource(
                        source_id=inp["source_id"],
                        source_name=inp["source_name"],
                    ))
                    seen_ids.add(inp["source_id"])
            elif block.name == "create_new_source":
                new_sources.append(PlannedNewSource(**block.input))

        return SourcePlan(existing_sources=existing_sources, new_sources=new_sources)

    except Exception:
        return SourcePlan()


@app.post("/api/generate-app-stream")
def generate_app_stream(req: GenerateAppRequest, request: Request):
    """Same as generate-app but streams narration audio chunks as SSE before the final result."""
    c = get_client(request)
    event_q: queue.Queue = queue.Queue()

    def worker():
        try:
            source_plan = plan_sources(c, req.prompt, req.all_source_summaries, req.pinned_source_ids)

            sources_by_name = {s.name: s for s in req.sources}
            all_planned: list[SourceData] = []
            for ps in source_plan.existing_sources:
                src = sources_by_name.get(ps.source_name)
                if src:
                    all_planned.append(src)
            for ns in source_plan.new_sources:
                all_planned.append(SourceData(name=ns.name, type=ns.type, fields=ns.fields, records=[]))

            data_ctx = ""
            if all_planned:
                data_ctx = "\n\nUSER DATA (available as window.vibeDB at runtime):\n"
                for src in all_planned:
                    data_ctx += f'\nSource: "{src.name}" (type: {src.type})\n'
                    data_ctx += f"Fields: {', '.join(f['key']+':'+f['type'] for f in src.fields)}\n"
                    if src.records:
                        data_ctx += f"Records ({len(src.records)} total):\n"
                        data_ctx += json.dumps(src.records[:12], indent=2) + "\n"
                    else:
                        data_ctx += "Records: (empty — will be populated as user adds data)\n"
                names = [s.name for s in all_planned]
                data_ctx += f"""
window.vibeDB will be injected before the app loads with these exact source keys: {names}
  window.vibeDB = {{ "Source Name": {{ fields: [...], records: [...] }} }}

Reading data:
  const data = window.vibeDB["{names[0]}"]
  const records = data.records

Writing back (syncs to the parent app's database):
  window.parent.postMessage({{ type: 'vibeDB:write', sourceName: '{names[0]}', records: updatedRecords }}, '*')

IMPORTANT: Use ONLY these exact source names when reading or writing: {names}
"""

            app_system = """You are a senior React developer building personal productivity apps.
Return ONLY a complete raw HTML file starting with <!DOCTYPE html>. No markdown, no explanation.

Structure:
- Load React 18 + ReactDOM from unpkg CDN (UMD builds) in <head>
- Load @babel/standalone from unpkg in <head> for JSX transform
- Put all CSS in a <style> tag in <head> (Google Fonts via @import url())
- Put a <div id="root"></div> in <body>
- Write the entire app as a <script type="text/babel"> block

CDN URLs to use (exactly):
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

React code requirements:
1. Destructure hooks at the top: const { useState, useEffect, useCallback, useRef, useMemo } = React;
2. Write a single <App /> component using functional components and hooks
3. ALWAYS read from window.vibeDB on mount (useEffect with [] deps) — never generate placeholder data when real data is injected
4. Write changes back immediately: window.parent.postMessage({ type: 'vibeDB:write', sourceName, records }, '*')
5. Fallback to localStorage only when window.vibeDB is absent or empty
6. Mount with: ReactDOM.createRoot(document.getElementById('root')).render(<App />);

Design requirements:
7. Fully functional, beautiful, polished app
8. Clean light design — soft whites, warm grays, one tasteful accent color
9. Make it feel like a real product someone would open every day
10. Handle empty states gracefully with helpful prompts
11. Smooth transitions and hover states via CSS"""

            name_system = "Generate a short 2-4 word app name. Reply with ONLY the name, no punctuation, no quotes."

            narrator.start_session(output_q=event_q, anthropic_client=c)
            try:
                html = strip_fences(
                    generate_app_with_narration(
                        client=c,
                        model=MODEL,
                        app_system=app_system,
                        user_prompt=f"Build: {req.prompt}{data_ctx}",
                        narrator=narrator,
                        max_tokens=8000,
                    )
                )
            except Exception:
                narrator.end_thinking()
                raise

            name = claude(c, name_system, f'App prompt: "{req.prompt}"', max_tokens=20).strip()
            narrator.join(timeout=8)   # wait for remaining audio chunks
            narrator.interrupt()
            event_q.put({"type": "result", "html": html, "name": name, "source_plan": source_plan.model_dump()})
        except Exception as e:
            event_q.put({"type": "error", "detail": str(e)})
        finally:
            event_q.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def sse():
        while True:
            event = event_q.get()
            if event is None:
                yield "data: [DONE]\n\n"
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def plan_schema_updates(client: anthropic.Anthropic, edit_prompt: str, sources: list[SourceData]) -> list[SchemaUpdate]:
    if not sources:
        return []

    tool = {
        "name": "update_source_schema",
        "description": "Update the field list of an existing linked data source to support the requested edit. Only call this if the edit genuinely requires storing a new type of data that the source doesn't already have a field for.",
        "input_schema": {
            "type": "object",
            "properties": {
                "source_id":   {"type": "string"},
                "source_name": {"type": "string"},
                "fields": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "key":     {"type": "string"},
                            "label":   {"type": "string"},
                            "type":    {"type": "string", "enum": ["text","number","boolean","date","select","url"]},
                            "options": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["key", "label", "type"]
                    }
                }
            },
            "required": ["source_id", "source_name", "fields"]
        }
    }

    source_info = "\n".join(
        f"- id: {s.id} | name: {s.name} | fields: {', '.join(f['key']+':'+f['type'] for f in s.fields)}"
        for s in sources
    )

    system = """You are reviewing an edit request for a personal productivity app.
Decide if the edit requires adding or changing fields on any linked data source.
RULES:
- Only call update_source_schema if the edit stores a NEW kind of data not already covered by existing fields.
- When updating, return the COMPLETE new field list (all existing fields plus new ones). Never remove existing fields.
- If no schema changes are needed, call no tools."""

    user = f'Edit request: "{edit_prompt}"\n\nLinked sources:\n{source_info}'

    try:
        msg = client.messages.create(
            model=MODEL_FAST,
            max_tokens=800,
            tools=[tool],
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        updates = []
        for block in msg.content:
            if block.type == "tool_use" and block.name == "update_source_schema":
                updates.append(SchemaUpdate(**block.input))
        return updates
    except Exception:
        return []


@app.post("/api/edit-app-stream")
def edit_app_stream(req: EditAppRequest, request: Request):
    """Same as edit-app but streams narration audio chunks as SSE before the final result."""
    c = get_client(request)
    event_q: queue.Queue = queue.Queue()

    def worker():
        try:
            schema_updates = plan_schema_updates(c, req.prompt, req.sources)

            data_ctx = ""
            if req.sources:
                data_ctx = "\n\nLINKED DATA SOURCES (available as window.vibeDB):\n"
                for src in req.sources:
                    data_ctx += f'\nSource: "{src.name}" (type: {src.type})\n'
                    data_ctx += f"Fields: {', '.join(f['key']+':'+f['type'] for f in src.fields)}\n"
                    if src.records:
                        data_ctx += f"Records ({len(src.records)} total):\n"
                        data_ctx += json.dumps(src.records[:12], indent=2) + "\n"
                if schema_updates:
                    data_ctx += "\nSCHEMA CHANGES BEING APPLIED:\n"
                    for upd in schema_updates:
                        data_ctx += f'- "{upd.source_name}" fields updated to: {", ".join(f["key"] for f in upd.fields)}\n'

            edit_system = """You are a senior React developer editing an existing personal productivity app.
The user has an existing app (full HTML provided) and wants specific changes made.
Return ONLY the complete updated HTML file starting with <!DOCTYPE html>. No markdown, no explanation.

Rules:
- Apply ONLY the requested changes. Preserve overall design, layout, and functionality unless asked to change them.
- Keep the same CDN URLs (React 18, ReactDOM, @babel/standalone from unpkg).
- ALWAYS read from window.vibeDB on mount — never use placeholder data.
- Write changes back via: window.parent.postMessage({ type: 'vibeDB:write', sourceName, records }, '*')
- If schema changes are listed above, update the app to use the new fields."""

            narrator.start_session(output_q=event_q, anthropic_client=c)
            try:
                html = strip_fences(
                    generate_app_with_narration(
                        client=c,
                        model=MODEL,
                        app_system=edit_system,
                        user_prompt=f"Current app HTML:\n{req.current_html}\n\nEdit request: {req.prompt}{data_ctx}",
                        narrator=narrator,
                        max_tokens=12000,
                    )
                )
            except Exception:
                narrator.end_thinking()
                raise

            narrator.join(timeout=8)
            narrator.interrupt()
            event_q.put({"type": "result", "html": html, "schema_updates": [u.model_dump() for u in schema_updates]})
        except Exception as e:
            event_q.put({"type": "error", "detail": str(e)})
        finally:
            event_q.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def sse():
        while True:
            event = event_q.get()
            if event is None:
                yield "data: [DONE]\n\n"
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


