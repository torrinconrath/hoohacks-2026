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

CHUNK_MIN_CHARS = 300
CHUNK_MAX_CHARS = 800

# How long to wait for a new chunk before Karen takes over
KAREN_TIMEOUT_SECS = 3.0

_SENTENCE_END_RE = re.compile(r'(?<=[.!?])\s+')

# ─── PROMPTS ──────────────────────────────────────────────────────────────────

NARRATOR_SYSTEM = """
You narrate what an AI is doing as it builds a web app. You receive a snippet of its internal reasoning, plus a list of things already said.

Respond with exactly 1-2 short sentences summarising the single most important NEW action or decision in the snippet.

If the snippet contains nothing new — it repeats, elaborates, or just refines something already covered — respond with only the word: SILENT

Rules:
- Never repeat or rephrase an idea already in the "Already said" list. Return SILENT instead.
- No explanations, no "why", no elaboration. Just what it's doing right now.
- Plain spoken English. No bullet points, no markdown, no code.
- If the snippet covers multiple topics, pick the most interesting new one and ignore the rest.
- End on a complete sentence. Never trail off mid-thought.

Good output examples:
"Setting up the click counter and score tracking."
"Wiring up the upgrade system so purchases affect click speed."
"Adding colour themes and flavour text to match the cat aesthetic."

Output ONLY the narration sentence(s), or the single word SILENT. Nothing else.
""".strip()


# ─── HELPERS ──────────────────────────────────────────────────────────────────

def _is_silent(text: str) -> bool:
    """Robust check — handles 'SILENT', 'Silent.', 'silent', etc."""
    return text.strip().rstrip(".!?,").upper() == "SILENT"


def refactor_chunk(
    client: anthropic.Anthropic,
    raw_thinking: str,
    recent: list[str],
    recovering_from_karen: bool = False,
) -> str:
    """
    Rewrite a raw thinking snippet as spoken narration via Haiku.
    Returns 'SILENT' if the content repeats what was already said.
    """
    history_block = ""
    if recent:
        lines = "\n".join(f"- {s}" for s in recent[-3:])
        history_block = f"\nAlready said (do NOT repeat these ideas):\n{lines}\n"

    system_prompt = NARRATOR_SYSTEM

    if recovering_from_karen:
        system_prompt += (
            "\n\nCRITICAL INSTRUCTION: You just got distracted rambling about your "
            "ex-wife Karen. Your first sentence MUST be a quick awkward self-correction "
            "that pivots back to the code — e.g. 'Anyway, sorry — back to it...' "
            "DO NOT return SILENT. You must speak the transition."
        )

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=150,
        system=system_prompt,
        messages=[{
            "role": "user",
            "content": f"{history_block}\nNew thinking:\n{raw_thinking}",
        }],
    )
    return response.content[0].text.strip()


def _generate_karen_ramble(client: anthropic.Anthropic, count: int) -> str:
    """Generate a fresh Karen grievance to fill dead air."""
    if count == 0:
        prompt = (
            "You are a narrator explaining an app build who just realised you're waiting "
            "on the AI to think. Fill the silence with 2 short spoken sentences venting "
            "about your ex-wife Karen taking the house/kids/dog/boat in the divorce. "
            "Start with something like 'Honestly, while we wait...' "
            "Conversational, lightly bitter, a bit funny. No markdown."
        )
    else:
        prompt = (
            "You are a narrator distracted from an app build, still going on about your "
            "ex-wife Karen. Write 2 short spoken sentences with a new ridiculous, oddly "
            "specific grievance — the divorce proceedings, her lawyer, her new boyfriend, "
            "what she took. Conversational and funny. No markdown."
        )

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=150,
        messages=[{"role": "user", "content": prompt}],
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
    Single-thread design with a timeout-based Karen fallback.

      thinking_q  ->  boundary-aware batch  ->  refactor (Haiku)  ->  ElevenLabs  ->  speakers

    If the stream goes quiet for KAREN_TIMEOUT_SECS, Karen fills the dead air.
    When real chunks resume, recovering_from_karen=True causes Haiku to open
    with a self-aware pivot back to the code topic.
    """
    buffer            = ""
    recent: list[str] = []
    karen_mode        = False
    karen_count       = 0

    def flush(text: str, recovering: bool = False) -> None:
        nonlocal karen_mode, karen_count
        if not text.strip() or el is None:
            return
        try:
            narration = refactor_chunk(anthropic_client, text, recent, recovering)
            if _is_silent(narration):
                print("[narrator] (silent — nothing new)")
                return
            recent.append(narration)
            if len(recent) > 6:
                recent.pop(0)
            karen_mode  = False
            karen_count = 0
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
            flush(buffer[: para_idx + 2].strip(), recovering=karen_mode)
            buffer = buffer[para_idx + 2:]
            return

        # 2. Last sentence boundary
        matches = list(_SENTENCE_END_RE.finditer(buffer))
        if matches:
            split = matches[-1].end()
            flush(buffer[:split].strip(), recovering=karen_mode)
            buffer = buffer[split:]
            return

        # 3. Hard ceiling
        if len(buffer) >= CHUNK_MAX_CHARS:
            flush(buffer, recovering=karen_mode)
            buffer = ""

    while True:
        try:
            # ── wait for next chunk, with Karen timeout ──────────────────────
            chunk = thinking_q.get(timeout=KAREN_TIMEOUT_SECS)

        except queue.Empty:
            # Stream stalled — flush any partial buffer first
            if buffer:
                flush(buffer, recovering=karen_mode)
                buffer = ""
            # Then Karen fills the silence
            if el is not None:
                try:
                    karen_text = _generate_karen_ramble(anthropic_client, karen_count)
                    karen_count += 1
                    karen_mode = True
                    print(f"[karen]    {karen_text}")
                    _speak(el, karen_text)
                except Exception as exc:
                    print(f"[karen] error: {exc}")
            continue

        if chunk is None:           # sentinel — stream finished
            flush(buffer, recovering=karen_mode)
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
