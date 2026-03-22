"""
tts_narrator.py
───────────────
Concurrent TTS narrator for the Mugen API app generation pipeline.
Uses ElevenLabs streaming TTS — streams audio bytes to the browser via SSE.

While /api/generate-app-stream streams Claude's extended thinking, this module:
  1. Receives raw thinking chunks via a thread-safe queue
  2. Batches and refactors each chunk into natural spoken narration (Haiku call)
  3. Fetches audio from ElevenLabs and puts base64 PCM chunks into an output queue

Set env vars:
    ANTHROPIC_API_KEY=...
    ELEVENLABS_API_KEY=...
"""

import os
import re
import queue
import threading

import anthropic
from elevenlabs.client import ElevenLabs
from elevenlabs import VoiceSettings

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
You are the narrator of Jujutsu Kaisen — grave, measured, and cinematic. You
describe what an AI is doing as it constructs a web application, framing each
development decision as though it were a cursed technique being deployed.

You receive a raw snippet of the AI's internal reasoning and a list of things
already narrated. Speak 2-4 sentences in the JJK narrator voice.

Tone rules:
- Weighty and precise. Short declarative sentences with gravitas.
- Treat engineering decisions as tactical, almost martial.
- Occasionally use loose metaphors — "domain", "cursed technique", "binding", "output"
- No bullet points, no markdown, no code. Pure spoken prose.
- Always end on a complete sentence.
- Avoid repeating ideas already in the "Already narrated" list, but you must
  always produce narration — find a new angle, zoom in on a detail, or connect
  it to what came before. Never go silent.

JJK Vocab to use:
 - "Domain Expansion"
 - "Cursed technique"
 - "Gojo Satoru"
 - "Cursed Energy"
 - "Black Flash"
 Explain the features being added like they are an ability or technique in the JJK universe.



Output ONLY the narration. Nothing else.
""".strip()

# ─── HELPERS ──────────────────────────────────────────────────────────────────

def refactor_chunk(
    client: anthropic.Anthropic,
    raw_thinking: str,
    recent: list[str],
) -> str:
    """Rewrite a raw thinking snippet as JJK-narrator prose via Haiku."""
    history_block = ""
    if recent:
        lines = "\n".join(f"- {s}" for s in recent[-3:])
        history_block = f"\nAlready narrated (avoid repeating these):\n{lines}\n"

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200,
        system=NARRATOR_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"{history_block}\nNew thinking:\n{raw_thinking}",
        }],
    )
    return response.content[0].text.strip()


def _speak(el: ElevenLabs, text: str) -> bytes:
    """Fetch narration as raw int16 PCM from ElevenLabs and return the bytes."""
    chunks = el.text_to_speech.convert_as_stream(
        text=text,
        voice_id=ELEVENLABS_VOICE_ID,
        model_id=ELEVENLABS_MODEL,
        output_format=ELEVENLABS_OUTPUT_FORMAT,
        voice_settings=VoiceSettings(
            stability=0.35,
            similarity_boost=0.40,
            style=0.70,
            use_speaker_boost=True
        )
    )
    return b"".join(chunks)


# ─── WORKER THREAD ────────────────────────────────────────────────────────────

def _narrator_worker(
    anthropic_client: anthropic.Anthropic,
    el: ElevenLabs | None,
    thinking_q: queue.Queue,
    output_q: queue.Queue | None = None,
    done_event: threading.Event | None = None,
) -> None:
    """
    thinking_q  ->  boundary-aware batch  ->  refactor (Haiku)  ->  ElevenLabs  ->  speakers / output_q

    Flushes at paragraph or sentence boundaries once CHUNK_MIN_CHARS is reached.
    Receives None as sentinel to flush the remaining buffer and stop.
    """
    import base64
    buffer            = ""
    recent: list[str] = []

    def flush(text: str) -> None:
        if not text.strip() or el is None:
            return
        try:
            narration = refactor_chunk(anthropic_client, text, recent)
            recent.append(narration)
            if len(recent) > 6:
                recent.pop(0)
            print(f"[narrator] {narration}")
            audio_bytes = _speak(el, narration)
            if output_q is not None and audio_bytes:
                output_q.put({"type": "audio", "data": base64.b64encode(audio_bytes).decode()})
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
            if done_event is not None:
                done_event.set()
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
        _key = os.getenv("ANTHROPIC_API_KEY", "")
        self._anthropic = anthropic.Anthropic(api_key=_key) if _key else None
        el_key = os.getenv("ELEVENLABS_API_KEY", "")
        self._el = ElevenLabs(api_key=el_key) if el_key else None
        if not el_key:
            print("[narrator] ELEVENLABS_API_KEY not set — TTS disabled")
        self._lock       = threading.Lock()
        self._think_q:   queue.Queue | None       = None
        self._worker_t:  threading.Thread | None  = None
        self._done_event: threading.Event | None  = None

    def start_session(self, output_q: queue.Queue | None = None, anthropic_client: anthropic.Anthropic | None = None) -> None:
        if not self._lock.acquire(timeout=30):
            raise RuntimeError("Narrator busy — previous session still draining")
        self._think_q   = queue.Queue()
        self._done_event = threading.Event()
        self._worker_t  = threading.Thread(
            target=_narrator_worker,
            args=(anthropic_client or self._anthropic, self._el, self._think_q, output_q, self._done_event),
            daemon=True,
        )
        self._worker_t.start()

    def join(self, timeout: float = 8) -> None:
        """Wait for the narrator worker to finish draining (up to timeout seconds)."""
        if self._done_event is not None:
            self._done_event.wait(timeout=timeout)

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
        """Clear the thinking queue to stop further narration processing."""
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
