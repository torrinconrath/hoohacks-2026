"""
tts_narrator.py
───────────────
Concurrent TTS narrator for the Vibe API app generation pipeline.

While /api/generate-app streams Claude's extended thinking, this module:
  1. Receives raw thinking chunks via a thread-safe queue
  2. Refactors each chunk into natural spoken narration (second Claude call)
  3. Synthesises and plays each sentence via Kokoro ONNX on CPU

Usage — integrate into main.py:

    from tts_narrator import AppNarrator

    narrator = AppNarrator()

    # Inside generate_app(), replace the claude() call with a streaming version:
    with narrator.run():
        html = generate_app_with_narration(req, narrator)

Install:
    pip install kokoro-onnx sounddevice numpy

Download model files alongside this script:
    https://github.com/thewh1teagle/kokoro-onnx/releases/latest
    → kokoro-v1.0.onnx
    → voices-v1.0.bin
"""

import os
import re
import queue
import threading
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import sounddevice as sd
import anthropic
from kokoro_onnx import Kokoro

# ─── CONFIG ───────────────────────────────────────────────────────────────────

KOKORO_MODEL   = Path(__file__).parent / "tts" / "kokoro-v1.0.int8.onnx"
KOKORO_VOICES  = Path(__file__).parent / "tts" / "voices-v1.0.bin"
KOKORO_VOICE   = "am_adam"   # confident, clear male voice
KOKORO_SPEED   = 1.0
SAMPLE_RATE    = 24_000

# How many raw thinking characters to batch before sending to the refactor step.
# Smaller = more responsive narration. Larger = more coherent sentences.
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

def split_sentences(text: str) -> list[str]:
    """Split narration text into TTS-friendly sentence chunks."""
    sentences = re.split(r'(?<=[.!?])\s+', text.strip())
    return [s.strip() for s in sentences if s.strip()]


def refactor_chunk(client: anthropic.Anthropic, raw_thinking: str) -> str:
    """Turn a raw thinking snippet into a spoken narration sentence."""
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",   # fast + cheap for narration refactor
        max_tokens=200,
        system=NARRATOR_SYSTEM,
        messages=[{"role": "user", "content": raw_thinking}],
    )
    return response.content[0].text.strip()

# ─── WORKER THREADS ───────────────────────────────────────────────────────────

def _refactor_worker(
    client: anthropic.Anthropic,
    thinking_q: "queue.Queue[str | None]",
    audio_q: "queue.Queue[np.ndarray | None]",
    kokoro: Kokoro,
):
    """
    Reads raw thinking chunks → refactors to narration → synthesises audio.
    Puts audio arrays into audio_q for the playback thread.
    """
    buffer = ""

    def flush(text: str):
        if not text.strip():
            return
        try:
            narration = refactor_chunk(client, text)
            print(f"[narrator] {narration}")
            for sentence in split_sentences(narration):
                samples, _ = kokoro.create(
                    sentence,
                    voice=KOKORO_VOICE,
                    speed=KOKORO_SPEED,
                    lang="en-us",
                )
                audio_q.put(samples.astype(np.float32))
        except Exception as e:
            print(f"[narrator] refactor/tts error: {e}")

    while True:
        chunk = thinking_q.get()
        if chunk is None:           # sentinel: generation finished
            flush(buffer)           # flush whatever is left
            audio_q.put(None)       # signal playback thread to stop
            break

        buffer += chunk

        # Flush when we have enough context for a meaningful narration
        if len(buffer) >= CHUNK_BATCH_CHARS:
            flush(buffer)
            buffer = ""


def _playback_worker(audio_q: "queue.Queue[np.ndarray | None]"):
    """Plays audio arrays sequentially as they arrive."""
    while True:
        item = audio_q.get()
        if item is None:
            break
        sd.play(item, samplerate=SAMPLE_RATE)
        sd.wait()


# ─── PUBLIC API ───────────────────────────────────────────────────────────────

class AppNarrator:
    """
    Drop-in narrator that runs alongside app generation.

    Example:
        narrator = AppNarrator()

        with narrator.session():
            # Stream Claude's thinking; feed chunks to narrator
            for chunk in stream_thinking(...):
                narrator.feed(chunk)
        # Session exits → waits for all speech to finish
    """

    def __init__(self):
        self._client  = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        self._kokoro  = Kokoro(str(KOKORO_MODEL), str(KOKORO_VOICES))
        self._think_q: queue.Queue[str | None] = queue.Queue()
        self._audio_q: queue.Queue[np.ndarray | None] = queue.Queue(maxsize=4)
        self._threads: list[threading.Thread] = []

    def _start(self):
        t1 = threading.Thread(
            target=_refactor_worker,
            args=(self._client, self._think_q, self._audio_q, self._kokoro),
            daemon=True,
        )
        t2 = threading.Thread(
            target=_playback_worker,
            args=(self._audio_q,),
            daemon=True,
        )
        t1.start()
        t2.start()
        self._threads = [t1, t2]

    def feed(self, thinking_chunk: str):
        """Send a raw thinking text chunk to the narration pipeline."""
        self._think_q.put(thinking_chunk)

    def _stop(self):
        """Signal end of thinking stream and wait for speech to finish."""
        self._think_q.put(None)     # tell refactor worker we're done
        for t in self._threads:
            t.join()

    @contextmanager
    def session(self):
        """Context manager: starts workers on enter, drains on exit."""
        self._start()
        try:
            yield self
        finally:
            self._stop()


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
    Replacement for the claude() helper in main.py.
    Streams extended thinking from Claude, feeding thinking chunks to the
    narrator in real time, and returns the final HTML string.

    Drop-in usage in main.py:

        from tts_narrator import AppNarrator, generate_app_with_narration

        narrator = AppNarrator()

        @app.post("/api/generate-app", response_model=GenerateAppResponse)
        def generate_app(req: GenerateAppRequest):
            ...
            with narrator.session():
                html = generate_app_with_narration(
                    client, MODEL, app_system, prompt, narrator
                )
            ...
    """
    html_parts: list[str] = []

    with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        thinking={"type": "enabled", "budget_tokens": 6000},
        system=app_system,
        messages=[{"role": "user", "content": user_prompt}],
    ) as stream:
        for event in stream:
            # Thinking delta → feed narrator
            if (
                hasattr(event, "type")
                and event.type == "content_block_delta"
                and hasattr(event, "delta")
                and getattr(event.delta, "type", None) == "thinking_delta"
            ):
                narrator.feed(event.delta.thinking)

            # Text delta → accumulate HTML
            elif (
                hasattr(event, "type")
                and event.type == "content_block_delta"
                and hasattr(event, "delta")
                and getattr(event.delta, "type", None) == "text_delta"
            ):
                html_parts.append(event.delta.text)

    return "".join(html_parts)
