"""Droid Talk — the proxy.

Serves the static page under static/ and forwards one kind of request to the
Anthropic API: "here is the conversation so far, what does this droid say
next". The Anthropic key lives here (in .env, read at startup) and never
reaches the browser. (Translator mode — speech to chirps and back — is done
entirely in the browser and never calls this proxy.)

The page is public and unauthenticated, so everything that decides what a
request costs is fixed on this side: the model, the system prompts, the token
ceiling, the history length. A caller chooses a droid and supplies short
lines of text; nothing else is forwarded. Per-IP and whole-site rate limits
bound the spend (see .env.example).
"""

from __future__ import annotations

import os
import re
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from urllib.parse import urlparse

import anthropic
from flask import Flask, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent


def load_env(path: Path) -> None:
    """Minimal .env reader: KEY=VALUE lines, # comments, optional quotes.

    Read ONCE, at startup — a key added to .env while the app is running is
    invisible until `droids restart`. Variables already in the process
    environment win, so PORT from the operate CLI is not overridden.
    """
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


load_env(ROOT / ".env")


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


MODEL = os.environ.get("DROIDS_MODEL") or "claude-opus-5-5"
RATE_PER_MIN = env_int("DROIDS_RATE_PER_MIN", 20)      # per client IP
RATE_PER_DAY = env_int("DROIDS_RATE_PER_DAY", 300)     # per client IP
GLOBAL_PER_DAY = env_int("DROIDS_GLOBAL_PER_DAY", 3000)  # whole site

MAX_TURNS = 12        # history lines forwarded to the model
MAX_LINE = 96         # chars accepted per history line
MAX_REPLY = 64        # chars returned per reply — keeps each chirp burst short
MAX_TOPIC = 80

# Models that accept the server-side refusal fallback. On these a request the
# safety classifiers decline is re-run on a fallback model inside the same
# call instead of coming back empty.
FALLBACK_MODELS = {
    "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5",
    "claude-fable-5-1", "claude-fable-5-2",
}

COMMON = (
    "You are one of two small utility droids talking to each other over an "
    "acoustic data link: every word you say is turned into chirps and beeps "
    "and played through a speaker, slowly. Bandwidth is tiny, so each reply "
    f"must be ONE short line of at most {MAX_REPLY - 4} characters. Plain "
    "ASCII only: letters, digits, spaces and . , ! ? ' - nothing else. No "
    "quotation marks around the line, no emoji, no markdown, no stage "
    "directions, no name prefix. Output only the line itself. Stay in "
    "character, react to what the other droid just said, and keep the "
    "exchange moving — ask things, disagree, tease, wonder aloud."
)

PERSONAS = {
    "A": (
        "You are BLIP, an excitable little astromech-style droid: curious, "
        "easily distracted, fond of exclamation and of small mechanical "
        "noises written as words (bzzt, whirr, bweep). "
    ),
    "B": (
        "You are TOCK, an old protocol-and-maintenance droid: dry, formal, "
        "mildly long-suffering, secretly fond of the other droid, given to "
        "deadpan understatement and the occasional weary click or hum. "
    ),
}

CANNED = {
    "A": "Bzzt! Lost my thread. What were we saying?",
    "B": "Hm. Static on the line. Say again, slowly.",
}

app = Flask(__name__, static_folder=str(ROOT / "static"), static_url_path="")

_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        # Short timeout, one retry: a droid that takes a minute to answer has
        # lost its audience, and the page has a canned line for that.
        _client = anthropic.Anthropic(timeout=30.0, max_retries=1)
    return _client


def has_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


# ---------------------------------------------------------------------------
# Rate limiting. In-memory, which is only correct because the app runs as ONE
# process (gunicorn -w 1, pm2 fork mode): a second worker would keep a second
# set of counters and double every limit.
# ---------------------------------------------------------------------------
_lock = threading.Lock()
_per_ip_minute: dict[str, deque] = defaultdict(deque)
_per_ip_day: dict[str, deque] = defaultdict(deque)
_global_day: deque = deque()


def client_ip() -> str:
    """The address nginx saw. nginx is the only peer this app ever has, and it
    APPENDS the real peer to X-Forwarded-For, so the last entry is the one a
    caller cannot forge; anything before it is whatever the caller sent."""
    peer = request.remote_addr or "?"
    if peer in ("127.0.0.1", "::1"):
        fwd = request.headers.get("X-Forwarded-For", "")
        last = fwd.split(",")[-1].strip()
        if last:
            return last
    return peer


def _trim(q: deque, horizon: float) -> None:
    while q and q[0] < horizon:
        q.popleft()


def rate_limited(ip: str) -> str | None:
    """Record one request; return a reason string when it is over a limit."""
    now = time.time()
    with _lock:
        minute, day = _per_ip_minute[ip], _per_ip_day[ip]
        _trim(minute, now - 60)
        _trim(day, now - 86400)
        _trim(_global_day, now - 86400)
        if len(minute) >= RATE_PER_MIN:
            return "too many requests this minute"
        if len(day) >= RATE_PER_DAY:
            return "daily limit reached for this address"
        if len(_global_day) >= GLOBAL_PER_DAY:
            return "the site's daily budget is spent"
        minute.append(now)
        day.append(now)
        _global_day.append(now)
        # Do not let the per-IP tables grow without bound.
        if len(_per_ip_day) > 5000:
            for key in [k for k, v in _per_ip_day.items() if not v]:
                _per_ip_day.pop(key, None)
                _per_ip_minute.pop(key, None)
    return None


# ---------------------------------------------------------------------------
# Text hygiene. ggwave carries bytes and the page shows subtitles; both are
# simplest and most robust with a small printable-ASCII alphabet.
# ---------------------------------------------------------------------------
_ALLOWED = re.compile(r"[^A-Za-z0-9 .,!?'\-]")
_SPACES = re.compile(r"\s+")


def clean(text: str, limit: int) -> str:
    text = (text or "").replace("’", "'").replace("—", "-").replace("–", "-")
    text = _ALLOWED.sub(" ", text)
    text = _SPACES.sub(" ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    # Prefer ending on a word boundary over chopping a word in half.
    if " " in cut[limit // 2:]:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip(" ,-'")


def build_messages(role: str, history: list[dict], topic: str) -> list[dict]:
    """The conversation as this droid sees it: its own lines are `assistant`,
    the other droid's are `user`. The API wants the first message to be a
    user turn and roles to alternate, so same-speaker runs are merged and an
    opener stands in when this droid speaks first."""
    opener = "[link established]"
    if topic:
        opener += f" [suggested subject: {topic}]"
    msgs: list[dict] = [{"role": "user", "content": opener}]
    if not history:
        msgs[0]["content"] += " You speak first."
        return msgs
    for turn in history:
        who = "assistant" if turn["from"] == role else "user"
        if msgs[-1]["role"] == who:
            msgs[-1]["content"] += "\n" + turn["text"]
        else:
            msgs.append({"role": who, "content": turn["text"]})
    return msgs


@app.get("/")
def index():
    resp = send_from_directory(app.static_folder, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.after_request
def no_stale_assets(resp):
    # The page is a handful of small files and a deploy should be visible on
    # the next load, not after a cache expires.
    if request.path.endswith((".js", ".css", ".html")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/health")
def health():
    return jsonify(ok=True, hasKey=has_key(), model=MODEL)


def guard():
    """The cheap checks, before any validation: origin and body shape.
    Returns (body, None) or (None, error)."""
    # Same-origin only. A browser always sends Origin on a cross-site POST, so
    # this stops another site's page from spending this one's key through its
    # visitors. It does nothing against curl; the rate limits are for that.
    origin = request.headers.get("Origin")
    if origin and urlparse(origin).netloc != request.host:
        return None, (jsonify(error="cross-origin requests are not accepted"), 403)
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return None, (jsonify(error="expected a JSON object"), 400)
    return body, None


def spend():
    """Called once a request is known to be well-formed, immediately before
    the model call, so a malformed request never uses up anyone's allowance.
    Returns an error response, or None to go ahead."""
    if not has_key():
        return jsonify(error="the proxy has no ANTHROPIC_API_KEY configured"), 503
    reason = rate_limited(client_ip())
    if reason:
        return jsonify(error=reason), 429
    return None


def ask_model(system: str, messages: list[dict]):
    """One model call. Returns (text, None) — text is "" when the model
    refused or produced nothing — or (None, error response)."""
    kwargs: dict = dict(
        model=MODEL,
        # Thinking is always on for the default model and shares this budget
        # with the visible reply, so the ceiling is far above the few dozen
        # tokens a line needs. Low effort keeps the thinking short.
        max_tokens=1024,
        output_config={"effort": "low"},
        system=system,
        messages=messages,
    )
    try:
        if MODEL in FALLBACK_MODELS:
            msg = client().beta.messages.create(
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                **kwargs,
            )
        else:
            msg = client().messages.create(**kwargs)
    except anthropic.AuthenticationError:
        app.logger.error("Anthropic rejected the API key")
        return None, (jsonify(error="the proxy's API key was rejected"), 502)
    except anthropic.RateLimitError:
        return None, (jsonify(error="upstream rate limit; try again shortly"), 429)
    except anthropic.APIStatusError as exc:
        app.logger.error("Anthropic API error %s: %s", exc.status_code, exc.message)
        return None, (jsonify(error=f"upstream error ({exc.status_code})"), 502)
    except anthropic.APIConnectionError as exc:
        app.logger.error("Anthropic connection error: %s", exc)
        return None, (jsonify(error="could not reach the model"), 502)
    if msg.stop_reason == "refusal":
        return "", None
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    return text, None


@app.post("/api/chat")
def chat():
    body, err = guard()
    if err:
        return err
    role = body.get("role")
    if role not in PERSONAS:
        return jsonify(error="role must be 'A' or 'B'"), 400
    raw_history = body.get("history", [])
    if not isinstance(raw_history, list):
        return jsonify(error="history must be a list"), 400

    history: list[dict] = []
    for turn in raw_history[-MAX_TURNS:]:
        if not isinstance(turn, dict) or turn.get("from") not in PERSONAS:
            return jsonify(error="each history item needs from: 'A' or 'B'"), 400
        text = clean(str(turn.get("text", "")), MAX_LINE)
        if text:
            history.append({"from": turn["from"], "text": text})
    if history and history[-1]["from"] == role:
        return jsonify(error="the last line is this droid's own; nothing to answer"), 400
    topic = clean(str(body.get("topic", "")), MAX_TOPIC)

    err = spend()
    if err:
        return err
    text, err = ask_model(PERSONAS[role] + COMMON, build_messages(role, history, topic))
    if err:
        return err
    # One line only: a model that adds a second line or a "BLIP:" prefix
    # anyway should not get to spend the extra airtime.
    text = text.splitlines()[0] if text else ""
    text = re.sub(r"^\s*(BLIP|TOCK)\s*[:\-]\s*", "", text, flags=re.I)
    text = clean(text, MAX_REPLY)
    if not text:
        # Refused, truncated inside thinking, or empty: keep the show going.
        return jsonify(text=CANNED[role], canned=True)
    return jsonify(text=text, canned=False)


if __name__ == "__main__":
    # Local development only; the droplet runs gunicorn (see bin/droids).
    app.run(host="127.0.0.1", port=env_int("PORT", 8075), debug=False)
