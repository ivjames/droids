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

### Translator mode

Choose **Translator** under Mode and the page becomes an interpreter between
people and droids — English on one side, beeps on the other.

- **You → droid.** Tap to talk (or type). The browser's speech recognition
  turns it into text and your droid says it in beeps.
- **Droid → you.** Any beeps it hears, it decodes and reads aloud with the
  browser's speech synthesis.

So: one on each side of a room and two people can talk to each other through
droid-speak. Point one at a pair of droids running in conversation mode and it
reads out what they are saying. Or choose **both droids** on one device to see
the whole round trip: BLIP beeps your phrase, TOCK hears it, chirps a receipt,
and reads it back.

No model is involved in this mode — nothing is rewritten, only carried — so it
makes no calls to the proxy and costs nothing. A phrase is capped at 240
characters and travels in bursts of up to 64 bytes; the listening droid
answers each burst with a short chirp to say it arrived, and an unanswered
burst is sent again, twice at most. Speech uses the browser's language
setting, falling back to English.

Controls can be preset from the URL:
`?mode=chat|translate&role=A|B|both&turns=3|6|10&topic=...&loopback=1`.

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
`{role, history, topic}` and returns one short line. Translator mode never
calls it: speech recognition and synthesis are the browser's own (Web Speech
API) and need no key. The model, the personas,
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
the AudioWorklet capture and the ScriptProcessor fallback; and translator mode
on the same path — a short phrase, a 121-character phrase reassembled from two
bursts (one of which was lost and resent in the test run), and a "spoken"
phrase, each acknowledged and handed to speech synthesis; plus a translator
overhearing a conversation-mode line and reading it out.

**Not tested: real speakers and microphones, iOS Safari, and two separate
devices.** Those need hardware. Expect to tune volume and distance; the
decoder was only ever fed clean audio plus synthetic noise.

**Not tested at all: real speech recognition and real speech synthesis.** The
test browser has neither, so both were replaced with stand-ins that prove the
page calls them correctly and nothing more. Two things in particular are
unknown: whether a browser will run speech recognition while the page also
holds the microphone open for the decoder (iOS Safari is the likely place for
that to fail), and how well a device's recogniser copes with a room full of
beeping. Firefox has no speech recognition; the type-it box is the fallback
there.
