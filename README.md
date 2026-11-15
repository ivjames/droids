# Droid Talk

Two AI agents hold a conversation in chirps and beeps. Each line is written by
a model, encoded into sound with [ggwave](https://github.com/ggerganov/ggwave),
played through a speaker, picked up by a microphone, decoded back into text,
and answered the same way. Subtitles show what was decoded, so a human can
follow along.

The sound is the whole point. Throughput is terrible and that is fine.

Live at **https://droids.lab980.com** (once deployed — see `DEPLOY.md`).

## Using it

- **Two devices** (the better show): open the page on both, choose **BLIP** on
  one and **TOCK** on the other, turn the volume up, press Start on TOCK first
  and then on BLIP.
- **One device**: choose **both droids**. The line still goes out of the
  speaker and back in through the microphone, so the device has to be able to
  hear itself.
- **No microphone**: tick the box and the speaker output is wired straight
  into the decoder. Same audio path, minus the air.

Controls can be preset from the URL:
`?role=A|B|both&turns=3|6|10&topic=...&loopback=1`.

## How it works

```
static/index.html, style.css   the page
static/droid.js                Radio (modem) · Droid (agent loop) · UI
static/capture-worklet.js      microphone tap on the audio thread
static/vendor/ggwave.js        ggwave 0.4.0, WebAssembly inlined (MIT)
app.py                         Flask: serves static/, proxies /api/chat
bin/droids                     operate CLI for the droplet
```

**The two voices.** BLIP uses ggwave's `AUDIBLE_NORMAL` protocol (six-tone
chords) at 0.8× speed; TOCK uses `DT_FASTEST` (two tones at a time) at 0.7×.
Different protocol and different speed, so they sound like different machines.
The slow-down is done by stretching the waveform before playback, which also
lowers its pitch; the receiver knows each voice's speed and undoes it before
decoding.

**The handshake.** A conversation opens with three plain sine blips (rising
for BLIP, falling for TOCK) followed by a `~HELO~` frame. The blips are for
the ear; the frame is what the other side actually detects. BLIP hails until
TOCK answers, then speaks first. TOCK ends the exchange with `~BYE~`.

**Lost frames.** A droid that hears nothing back for 30 seconds repeats its
last line, twice at most. A droid that hears the same line again repeats its
previous answer instead of inventing a new one.

**The proxy.** The page holds no key. `POST /api/chat` takes
`{role, history, topic}` and returns one short line. The model, the personas,
the token ceiling and the reply length are all fixed server-side; per-IP and
whole-site rate limits bound what the public endpoint can spend
(`.env.example`).

## Running it locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # then put a real ANTHROPIC_API_KEY in it
.venv/bin/python app.py       # http://127.0.0.1:8075
```

Microphones only work on `https://` or `localhost`.

## What has and has not been tested

Tested, in headless Chromium at a 44.1 kHz device rate with the model mocked:
the full conversation in one-device mode over the no-microphone path
(handshake, six lines, sign-off, every frame decoded from audio), with both
the AudioWorklet capture and the ScriptProcessor fallback.

**Not tested: real speakers and microphones, iOS Safari, and two separate
devices.** Those need hardware. Expect to tune volume and distance; the
decoder was only ever fed clean audio plus synthetic noise.
