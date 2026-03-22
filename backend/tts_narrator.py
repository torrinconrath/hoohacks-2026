"""
tts_narrator.py
───────────────
Concurrent TTS narrator for the Vibe API app generation pipeline.
Uses ElevenLabs streaming TTS — no local model files required.

While /api/generate-app streams Claude's extended thinking, this module:
  1. Receives raw thinking chunks via a thread-safe queue
  2. Batches and refactors each chunk into natural spoken narration (Haiku call)
  3. Streams the narration to ElevenLabs and plays it back in a background thread

Fully non-blocking — the HTTP response returns as soon as HTML is ready.
TTS finishes draining in the background.

Install:
    pip install elevenlabs anthropic python-dotenv

Set env vars:
    ANTHROPIC_API_KEY=...
    ELEVENLABS_API_KEY=...
"""

import os
import re
import queue
import threading

import numpy as np
import sounddevice as sd
import anthropic
from elevenlabs.client import ElevenLabs

# ─── CONFIG ───────────────────────────────────────────────────────────────────

ELEVENLABS_VOICE_ID      = "nPczCjzI2devNBz1zQrb"   # Brian
ELEVENLABS_MODEL         = "eleven_flash_v2_5"
ELEVENLABS_OUTPUT_FORMAT = "pcm_22050"
ELEVENLABS_SAMPLE_RATE   = 22050

CHUNK_MIN_CHARS = 500
CHUNK_MAX_CHARS = 1200

_SENTENCE_END_RE = re.compile(r'(?<=[.!?])\s+')

# ─── PROMPTS ──────────────────────────────────────────────────────────────────

NARRATOR_SYSTEM = """
You are the narrator of Jujutsu Kaisen — grave, measured, and precise. You
describe what an AI is doing as it constructs a web application, framing each
development decision as though it were a cursed technique being unleashed.

You receive a raw snippet of the AI's internal reasoning, plus a list of things
already narrated. Distil it into 1-2 spoken sentences in the JJK narrator voice.

If the snippet contains nothing new — it repeats or refines something already
covered — respond with only the word: SILENT

Tone rules:
- Weighty and cinematic. Short declarative sentences with gravitas.
- Treat engineering decisions as tactical, almost martial.
- Occasionally reference "output", "technique", "domain", "cursed energy" as
  loose metaphors — but sparingly. Never force it.
- No bullet points, no markdown, no code. Pure spoken prose.
- End on a complete sentence. Never trail off.

Good output examples:
"The click counter takes shape — a simple binding that tracks each strike."
"He turns now to persistence. Every state, sealed into localStorage before the page can forget."
"The upgrade domain expands. Each purchase reshapes the rate at which power accumulates."

Output ONLY the narration, or the single word SILENT. Nothing else.
""".strip()

# ─── HELPERS ──────────────────────────────────────────────────────────────────

def _is_silent(text: str) -> bool:
    """Robust check — handles 'SILENT', 'Silent.', 'silent', etc."""
    return text.strip().rstrip(".!?,").upper() == "SILENT"


def refactor_chunk(
    client: anthropic.Anthropic,
    raw_thinking: str,
    recent: list[str],
) -> str:
    """
    Rewrite a raw thinking snippet as JJK-narrator prose via Haiku.
    Returns 'SILENT' if the content repeats what was already said.
    """
    history_block = ""
    if recent:
        lines = "\n".join(f"- {s}" for s in recent[-3:])
        history_block = f"\nAlready narrated (do NOT repeat these):\n{lines}\n"

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=120,
        system=NARRATOR_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"{history_block}\nNew thinking:\n{raw_thinking}",
        }],
    )
    return response.content[0].text.strip()


def _speak(el: ElevenLabs, text: str) -> None:
    """Fetch narration as raw PCM from ElevenLabs and play via sounddevice."""
    chunks = el.text_to_speech.convert_as_stream(
        text=text,
        voice_id=ELEVENLABS_VOICE_ID,
        model_id=ELEVENLABS_MODEL,
        output_format=ELEVENLABS_OUTPUT_FORMAT,
    )
    audio_bytes = b"".join(chunks)
    audio_np = np.frombuffer(audio_bytes, dtype=np.int16)
    sd.play(audio_np, samplerate=ELEVENLABS_SAMPLE_RATE)
    sd.wait()


# ─── WORKER THREAD ────────────────────────────────────────────────────────────

def _narrator_worker(
    anthropic_client: anthropic.Anthropic,
    el: ElevenLabs | None,
    thinking_q: queue.Queue,
) -> None:
    """
    thinking_q  ->  boundary-aware batch  ->  refactor (Haiku)  ->  ElevenLabs  ->  speakers

    Flushes at paragraph or sentence boundaries once CHUNK_MIN_CHARS is reached.
    Receives None as sentinel to flush the remaining buffer and stop.
    """
    buffer            = ""
    recent: list[str] = []

    def flush(text: str) -> None:
        if not text.strip() or el is None:
            return
        try:
            narration = refactor_chunk(anthropic_client, text, recent)
            if _is_silent(narration):
                print("[narrator] (silent — nothing new)")
                return
            recent.append(narration)
            if len(recent) > 6:
                recent.pop(0)
            print(f"[narrator] {narration}")
            _speak(el, narration)
        except Exception as exc:
            print(f"[narrator] error: {exc}")

    def try_flush_at_boundary() -> None:
        nonlocal buffer

        if len(buffer) < CHUNK_MIN_CHARS:
            return

        # 1. Paragraph break
        para_idx = buffer.rfind("\n\n")
        if para_idx != -1:
            flush(buffer[: para_idx + 2].strip())
            buffer = buffer[para_idx + 2:]
            return

        # 2. Last sentence boundary
        matches = list(_SENTENCE_END_RE.finditer(buffer))
        if matches:
            split = matches[-1].end()
            flush(buffer[:split].strip())
            buffer = buffer[split:]
            return

        # 3. Hard ceiling
        if len(buffer) >= CHUNK_MAX_CHARS:
            flush(buffer)
            buffer = ""

    while True:
        chunk = thinking_q.get()

        if chunk is None:           # sentinel — stream finished
            flush(buffer)
            return

        buffer += chunk
        try_flush_at_boundary()


# ─── PUBLIC API ───────────────────────────────────────────────────────────────

class AppNarrator:
    """
    Non-blocking narrator. One generation at a time via a lock.
    start_session() spins up a fresh worker thread.
    end_thinking() signals it and drains in the background — never blocks HTTP.
    """

    def __init__(self) -> None:
        self._anthropic = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        el_key = os.getenv("ELEVENLABS_API_KEY", "")
        self._el = ElevenLabs(api_key=el_key) if el_key else None
        if not el_key:
            print("[narrator] ELEVENLABS_API_KEY not set — TTS disabled")
        self._lock     = threading.Lock()
        self._think_q: queue.Queue | None       = None
        self._worker_t: threading.Thread | None = None

    def start_session(self) -> None:
        if not self._lock.acquire(timeout=30):
            raise RuntimeError("Narrator busy — previous session still draining")
        self._think_q  = queue.Queue()
        self._worker_t = threading.Thread(
            target=_narrator_worker,
            args=(self._anthropic, self._el, self._think_q),
            daemon=True,
        )
        self._worker_t.start()

    def feed(self, thinking_chunk: str) -> None:
        """Feed a raw thinking delta into the pipeline."""
        if self._think_q is not None and self._el is not None:
            self._think_q.put(thinking_chunk)

    def end_thinking(self) -> None:
        """Signal end of thinking stream — drains in background, never blocks HTTP."""
        if self._think_q is not None:
            self._think_q.put(None)

        def _drain() -> None:
            if self._worker_t:
                self._worker_t.join()
            self._lock.release()

        threading.Thread(target=_drain, daemon=True).start()

    def interrupt(self) -> None:
        """Cut off TTS immediately."""
        sd.stop()
        if self._think_q is not None:
            while not self._think_q.empty():
                try:
                    self._think_q.get_nowait()
                except queue.Empty:
                    break


# ─── INTEGRATION HELPER ───────────────────────────────────────────────────────

def generate_app_with_narration(
    client: anthropic.Anthropic,
    model: str,
    app_system: str,
    user_prompt: str,
    narrator: AppNarrator,
    max_tokens: int = 8000,
) -> str:
    """
    Streams Claude with extended thinking enabled.

    Thinking deltas -> fed to narrator in real time.
    Text deltas     -> accumulated and returned as the final HTML string.

    Calls narrator.end_thinking() at the first text delta so TTS gets a head
    start draining while the HTML is still streaming in.
    """
    html_parts     = []
    thinking_ended = False

    with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        thinking={"type": "enabled", "budget_tokens": 6000},
        system=app_system,
        messages=[{"role": "user", "content": user_prompt}],
    ) as stream:
        for event in stream:
            etype = getattr(event, "type", None)
            delta = getattr(event, "delta", None)
            dtype = getattr(delta, "type", None) if delta else None

            if etype == "content_block_delta":
                if dtype == "thinking_delta":
                    narrator.feed(delta.thinking)
                elif dtype == "text_delta":
                    if not thinking_ended:
                        narrator.end_thinking()
                        thinking_ended = True
                    html_parts.append(delta.text)

    if not thinking_ended:
        narrator.end_thinking()

    return "".join(html_parts)
