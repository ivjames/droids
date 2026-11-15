# Droid Talk — working notes

Two AI agents converse over ggwave data-over-sound, so it sounds like two
droids talking — a static page plus a small Flask proxy that holds the
Anthropic key. `README.md` explains the design; this file is what to know
before changing or deploying it.

Served at **https://droids.lab980.com** from the lab980 droplet.

How work lands here — branch, PR, and the fact that merging is not deploying —
is in `.claude/rules/lab980-conventions.md`, which Claude Code loads
automatically every session. That file is owned by the lab980 scaffold and is
overwritten by it; **this** file is the site's own, and everything below is
about this site rather than about the platform. For the box itself, read the
`ivjames/lab980.com` repo's `CLAUDE.md`.

## Shape

A **proxied app**: nginx fronts a pm2-managed **gunicorn** (Python / Flask)
process on `127.0.0.1:8075`. That one process serves the static page from
`static/` and the `/api/` proxy, so the vhost is the plain one `provision-site`
writes — one `location /`, nothing site-specific — plus one include added by
`droids mic` (below).

- Repo: `ivjames/droids` · droplet dir: `/var/www/droids`
- pm2 process: `droids`, fork mode, started as `.venv/bin/gunicorn` with
  `--interpreter none`. The argv is `START_CMD` in `bin/droids`.
- **One gunicorn worker, on purpose.** The rate limits are in-memory counters;
  a second worker doubles every limit without saying so. Concurrency comes
  from threads.
- No build step and no Node at runtime. `static/vendor/ggwave.js` is a vendored
  copy of the `ggwave` npm package (0.4.0, WebAssembly inlined).
- `.env` (not in git) holds `PORT` and `ANTHROPIC_API_KEY`. There is no
  `data/` — the app keeps no state on disk.
- vhost: `/etc/nginx/sites-available/droids.lab980.com`, written by
  `provision-site`.

## Deploying

On the droplet, as root:

```bash
droids deploy      # fetch + hard reset, venv + pip install, pm2 start/restart, probe, save
droids status      # HEAD, pm2 state, local + public probe, key present?, mic policy, cert
droids logs        # tail this app's pm2 logs
droids mic         # one-time: let this vhost use the microphone
```

Full runbook, including first-time bring-up and `.env` keys: `DEPLOY.md`.

## Things worth knowing

- **The microphone is blocked by default on this box.** Every lab980 vhost
  sends `Permissions-Policy: … microphone=() …`, which makes `getUserMedia`
  fail as if the user had clicked Block. `droids mic` adds the one-vhost
  override; `droids status` reports whether it is in effect. A site that loads
  fine but says "Microphone access was refused" without ever prompting is
  this, not a browser setting.
- **`.env` is read once, at startup.** A key added while the app is running is
  invisible until `droids restart`. `/api/health` reporting `hasKey:false`
  straight after editing `.env` means that and nothing else.
- **The endpoint is public and spends money.** `/api/chat` needs no login, by
  design (no secret can live in a static page). What bounds it: the model,
  prompts, `max_tokens` and reply length are fixed in `app.py`, never taken
  from the request; a same-origin check; and the three rate limits in
  `.env.example`. Loosening any of those is a spending decision.
- **Translator mode never calls the proxy.** It carries the human's words
  as they are — speech to text, text to beeps, beeps to text, text to speech —
  so there is no model call and no cost. An earlier version translated between
  human languages through an `/api/translate` route; that was a misreading of
  the brief and was removed. If a model step is ever wanted here, it is a new
  spending route and needs the same guards as `/api/chat`.
- **Speech in and out is the browser's Web Speech API**, not a server call:
  no key, no cost, and no control over quality or availability. It could not
  be exercised in the test browser — see README, "What has and has not been
  tested" — so treat any claim that it works on a given device as unverified
  until someone has tried that device.
- **A translator listens for both voices** (conversation droids each listen
  for one), which is what lets it interpret two droids talking to each other.
  Frames it sent itself are recognised and not read back, except when one
  device plays both droids, where the read-back is the point.
- **Translator frames are UTF-8 and at most 140 bytes**, ggwave's hard limit
  (141 fails to decode). `PIECE_BYTES` in `droid.js` keeps well under it.
- **The rate limit trusts the last `X-Forwarded-For` entry**, which is the
  address nginx saw. That is only right while nginx is the app's sole peer and
  appends to the header, as the `provision-site` vhost does.
- **Do the audio resampling in `droid.js`, not in the browser or in ggwave.**
  Both alternatives were tried and measured: ggwave's built-in resampler
  decoded under half of test frames at a 44.1 kHz device rate, and Chromium
  played a 48 kHz buffer with a `playbackRate` about 9% short in a 44.1 kHz
  context. ggwave always runs at its native 48 kHz here.
- **ggwave allows four instances per loaded module**, and a fifth `init`
  returns -1 rather than throwing. A session needs up to seven (one
  transmitter, plus a decoder per voice listened for per speed), so `modem` in
  `droid.js` loads a second copy of the module when the first is full. Each
  copy reserves 16 MB of WebAssembly memory. Always take instances through
  `modem.acquire()`; a bare `init` that returns -1 decodes nothing, silently.
- **Voice and speed together are the protocol.** `VOICES` fixes the ggwave
  protocol and base rate per droid, and `SPEEDS` the three multipliers. A
  receiver listens at all three, so the two ends need not agree on a speed —
  but they do need the same `VOICES` and `SPEEDS` tables, so two devices
  running different versions of the page may not hear each other. Measured
  for all 36 sender/listener pairings at 44.1 and 48 kHz: each burst was
  decoded by its matching listener and by no other. Adding a speed adds two
  decoders per session; adding one close to an existing multiplier risks two
  decoders answering the same burst, so re-run that check.
- **Volume sits after the tap.** Everything played goes through `mix`; `out`
  is the gain between `mix` and the speaker. The scope and the no-microphone
  path read `mix`, so the slider cannot make the page deaf to itself.
- **The capture worklet forwards silence deliberately.** An AudioWorklet
  input with nothing playing has no channels at all rather than a channel of
  zeros, so on the no-microphone path the worklet would otherwise skip the
  gaps and hand the decoders bursts butted end to end. Whether ggwave strictly
  needs the gaps was not established; it decodes with them.
- Verify a **clean** clone runs, not just the working tree:

  ```bash
  d=$(mktemp -d) \
    && git archive HEAD | tar -x -C "$d" \
    && ( cd "$d" && python3 -m venv .venv \
         && .venv/bin/pip install -q -r requirements.txt \
         && .venv/bin/python -c 'import app' ) \
    && rm -rf "$d"
  ```
