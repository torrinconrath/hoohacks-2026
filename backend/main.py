import os
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import anthropic

from tts_narrator import AppNarrator, generate_app_with_narration

load_dotenv()

# ── Anthropic client ──────────────────────────────────────────────────────────
client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
MODEL       = "claude-sonnet-4-5"
MODEL_FAST  = "claude-haiku-4-5-20251001"   # non-thinking, simple tasks

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
def claude(system: str, user: str, max_tokens: int = 2000, model: str = MODEL_FAST) -> str:
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

class GenerateAppRequest(BaseModel):
    prompt: str
    sources: list[SourceData] = []
    all_source_summaries: list[ExistingSourceSummary] = []
    pinned_source_ids: list[str] = []

class GenerateAppResponse(BaseModel):
    html: str
    name: str
    source_plan: SourcePlan

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/infer-schema", response_model=InferSchemaResponse)
def infer_schema(req: InferSchemaRequest):
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
        raw = claude(system, user, max_tokens=3000)
        data = json.loads(strip_fences(raw))
        return InferSchemaResponse(**data)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=422, detail=f"AI returned invalid JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def plan_sources(prompt: str, all_source_summaries: list[ExistingSourceSummary]) -> SourcePlan:
    system = """You are a data architect for a personal productivity app generator.
A user wants to build a custom HTML5 app. Decide:
1. Which of the user's existing data sources the app should read/write (only link if genuinely needed).
2. What new data sources to create for data the app needs to persist (be intentional — do NOT create generic placeholders).

For new sources, design a complete field schema. Use only these types: text, number, boolean, date, select, url
For select fields, include an "options" array. Always use lowercase_underscores for field keys.
Choose an appropriate emoji icon for each new source.
Type must be one of: tasks, habits, finances, notes, calendar, custom

Return ONLY valid JSON — no markdown, no explanation:
{
  "existing_sources": [{"source_id": "<uuid>", "source_name": "<name>"}],
  "new_sources": [
    {
      "name": "<Human-readable name>",
      "type": "<type>",
      "icon": "<emoji>",
      "fields": [{"key": "<snake_case>", "label": "<Label>", "type": "<type>"}]
    }
  ]
}
If the app needs no persistent data, return empty arrays for both keys."""

    source_lines = "\n".join(
        f"- id: {s.id} | name: {s.name} | type: {s.type} | fields: {', '.join(f['key'] for f in s.fields)}"
        for s in all_source_summaries
    ) or "None"

    user = f'App prompt: "{prompt}"\n\nUser\'s existing data sources:\n{source_lines}'

    try:
        raw = claude(system, user, max_tokens=1200)
        data = json.loads(strip_fences(raw))
        return SourcePlan(**data)
    except Exception:
        return SourcePlan()


@app.post("/api/generate-app", response_model=GenerateAppResponse)
def generate_app(req: GenerateAppRequest):
    # Step 1: Plan sources (Haiku — fast, cheap)
    source_plan = plan_sources(req.prompt, req.all_source_summaries)

    # Force-include pinned sources that Claude's plan didn't select
    planned_existing_ids = {ps.source_id for ps in source_plan.existing_sources}
    for src_summary in req.all_source_summaries:
        if src_summary.id in req.pinned_source_ids and src_summary.id not in planned_existing_ids:
            source_plan.existing_sources.append(
                PlannedExistingSource(source_id=src_summary.id, source_name=src_summary.name)
            )

    # Step 2: Build data context using the plan
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

    app_system = """You are a senior frontend developer building personal productivity apps.
Return ONLY a complete raw HTML file starting with <!DOCTYPE html>. No markdown, no explanation.

Requirements:
1. Fully functional, beautiful, polished single-file app
2. Clean light design — soft whites, warm grays, one tasteful accent color
3. Import Google Fonts via @import url() in a <style> tag
4. ALL CSS and JS inline — no external dependencies
5. If window.vibeDB is provided, display that real data immediately and prominently
6. Let users add, edit, complete, and delete items — persist with localStorage as backup
7. When data changes, post back: window.parent.postMessage({ type: 'vibeDB:write', sourceName, records }, '*')
8. Make it feel like a real product someone would open every day
9. Handle empty states gracefully
10. Smooth micro-interactions and hover states"""

    name_system = "Generate a short 2-4 word app name. Reply with ONLY the name, no punctuation, no quotes."

    try:
        narrator.start_session()
        try:
            html = strip_fences(
                generate_app_with_narration(
                    client=client,
                    model=MODEL,
                    app_system=app_system,
                    user_prompt=f"Build: {req.prompt}{data_ctx}",
                    narrator=narrator,
                    max_tokens=8000,
                )
            )
        except Exception:
            narrator.end_thinking()   # release lock even on error
            raise
        name = claude(name_system, f'App prompt: "{req.prompt}"', max_tokens=20).strip()
        narrator.interrupt()
        return GenerateAppResponse(html=html, name=name, source_plan=source_plan)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))