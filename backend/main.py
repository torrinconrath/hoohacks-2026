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

class GenerateAppRequest(BaseModel):
    prompt: str
    sources: list[SourceData] = []

class GenerateAppResponse(BaseModel):
    html: str
    name: str

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


@app.post("/api/generate-app", response_model=GenerateAppResponse)
def generate_app(req: GenerateAppRequest):
    # Build data context
    data_ctx = ""
    if req.sources:
        data_ctx = "\n\nUSER DATA (available as window.vibeDB at runtime):\n"
        for src in req.sources:
            data_ctx += f'\nSource: "{src.name}" (type: {src.type})\n'
            data_ctx += f"Fields: {', '.join(f['key']+':'+f['type'] for f in src.fields)}\n"
            data_ctx += f"Records ({len(src.records)} total):\n"
            data_ctx += json.dumps(src.records[:12], indent=2) + "\n"

        first = req.sources[0].name
        data_ctx += f"""
window.vibeDB will be injected before the app loads:
  window.vibeDB = {{ "Source Name": {{ fields: [...], records: [...] }} }}

Reading data:
  const data = window.vibeDB["{first}"]
  const records = data.records

Writing back (syncs to the parent app's database):
  window.parent.postMessage({{ type: 'vibeDB:write', sourceName: '{first}', records: updatedRecords }}, '*')

If you need to persist data that isn't in a provided source, post it back using:
  window.parent.postMessage({{ type: 'vibeDB:write', sourceName: '<appropriate-name>', records: [...] }}, '*')
A new data source will be created automatically if one with that name doesn't exist yet.
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
        return GenerateAppResponse(html=html, name=name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))