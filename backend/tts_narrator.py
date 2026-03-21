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
from pathlib import Path

import numpy as np
import sounddevice as sd
import anthropic
from elevenlabs.client import ElevenLabs

# ─── CONFIG ───────────────────────────────────────────────────────────────────

# Voice ID — "Brian" is a clear, warm male narrator voice.
# Browse voices at: https://elevenlabs.io/voice-library
# Or list yours: client.voices.get_all()
ELEVENLABS_VOICE_ID = "nPczCjzI2devNBz1zQrb"   # Brian

# Flash v2.5 = ~75ms latency, ideal for real-time narration
ELEVENLABS_MODEL = "eleven_flash_v2_5"

# PCM 22050 Hz — raw signed-int16, no codec/decoder needed (plays via sounddevice)
ELEVENLABS_OUTPUT_FORMAT = "pcm_22050"
ELEVENLABS_SAMPLE_RATE   = 22050

# Batch raw thinking text before sending to the refactor LLM.
# ~400 chars ≈ 2–3 sentences of thinking — enough for coherent narration.
CHUNK_BATCH_CHARS = 400

# ─── NARRATION PROMPT ─────────────────────────────────────────────────────────

NARRATOR_SYSTEM = """
You are a calm, friendly voice narrating what an AI is currently doing as it 
builds a web application. You receive a raw snippet of the AI's internal 
reasoning and rewrite it as natural, spoken commentary — like a knowledgeable 
colleague explaining their thought process out loud.

Rules:
- Plain prose only. No bullet points, no markdown, no code snippets.
- Short, clear sentences that are easy to absorb when heard, not read.
- Use light signposting: "First...", "So the idea here is...", 
  "What's happening now is...", "The tricky part is..."
- If the thinking mentions a specific technical decision, briefly explain *why* 
  in plain English — don't just restate it.
- Warm and confident tone. Never robotic or overly formal.
- 2–4 sentences maximum per chunk. Be concise.
Output ONLY the spoken narration. Nothing else.
""".strip()

# ─── HELPERS ──────────────────────────────────────────────────────────────────

def refactor_chunk(client: anthropic.Anthropic, raw_thinking: str) -> str:
    """Rewrite a raw thinking snippet as spoken narration via Haiku."""
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200,
        system=NARRATOR_SYSTEM,
        messages=[{"role": "user", "content": raw_thinking}],
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
    sd.wait()  # blocks until playback done (keeps worker thread occupied)


# ─── WORKER THREAD ────────────────────────────────────────────────────────────

def _narrator_worker(
    anthropic_client: anthropic.Anthropic,
    el: ElevenLabs | None,
    thinking_q: queue.Queue,
) -> None:
    """
    thinking_q  ->  batch  ->  refactor (Haiku)  ->  ElevenLabs stream  ->  speakers
    Receives None as sentinel to flush the remaining buffer and stop.
    """
    buffer = ""

    def flush(text: str) -> None:
        if not text.strip() or el is None:
            return
        try:
            narration = refactor_chunk(anthropic_client, text)
            print(f"[narrator] {narration}")
            _speak(el, narration)
        except Exception as exc:
            print(f"[narrator] error: {exc}")

    while True:
        chunk = thinking_q.get()

        if chunk is None:           # sentinel — thinking stream is done
            flush(buffer)
            return

        buffer += chunk

        if len(buffer) >= CHUNK_BATCH_CHARS:
            flush(buffer)
            buffer = ""


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
        self._lock      = threading.Lock()   # prevents overlapping audio
        self._think_q: queue.Queue | None = None
        self._worker_t: threading.Thread | None = None

    def start_session(self) -> None:
        """
        Call before streaming starts. Acquires the lock (waits if previous
        session's TTS is still playing) then starts a fresh worker thread.
        """
        if not self._lock.acquire(timeout=30):
            raise RuntimeError("Narrator busy — previous session still draining")
        self._think_q = queue.Queue()
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
        """
        Signal end of thinking stream. Worker drains in the background —
        returns immediately so the HTTP response is never blocked.
        """
        if self._think_q is not None:
            self._think_q.put(None)     # sentinel

        def _drain() -> None:
            if self._worker_t:
                self._worker_t.join()
            self._lock.release()        # allow next session to start

        threading.Thread(target=_drain, daemon=True).start()


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

    - Thinking deltas  -> fed to narrator in real time
    - Text deltas      -> accumulated and returned as the final HTML string

    Calls narrator.end_thinking() at the first text delta so TTS gets a head
    start draining while the HTML is still streaming in.
    """
    html_parts = []
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