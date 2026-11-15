/* Droid Talk — the page.
 *
 * Three layers, top to bottom of this file:
 *
 *   Radio   the modem. Turns text into ggwave tones and plays them; listens
 *           on the microphone and turns tones back into text.
 *   Droid   one agent loop. Hears a line, asks the proxy what to say, says it.
 *   UI      controls, subtitles, the scope.
 *
 * The droids only ever reach each other through the Radio. In "both droids"
 * mode the two loops share one page, but a line still leaves through the
 * speaker and comes back through the microphone before the other loop sees it.
 */
(() => {
  'use strict';

  // ggwave runs at its native rate throughout; anything else is resampled
  // here. Its own built-in resampler decoded well under half of test frames
  // at a 44.1 kHz device rate, where this path decoded all of them.
  const GG_RATE = 48000;
  const GG_FRAME = 1024;

  // The two voices. Different protocol => different tone structure (BLIP is
  // six-tone chords high up, TOCK is the two-tone "DT" family lower down).
  // `rate` is the playback speed: below 1 stretches every burst and drops its
  // pitch, which is the "deliberately slowed" part. A receiver has to know
  // the sender's rate to undo it, so the pair below is fixed on both ends.
  const VOICES = {
    A: { name: 'BLIP', proto: 'GGWAVE_PROTOCOL_AUDIBLE_NORMAL', rate: 0.8,
         flourish: [1320, 1760, 2640] },
    B: { name: 'TOCK', proto: 'GGWAVE_PROTOCOL_DT_FASTEST', rate: 0.7,
         flourish: [660, 440, 330] },
  };
  const other = (id) => (id === 'A' ? 'B' : 'A');

  // Control frames. '~' is stripped from everything the model says, so a
  // droid cannot utter one by accident.
  const HELO = '~HELO~';
  const BYE = '~BYE~';

  const HAIL_EVERY_MS = 7000;   // re-hail interval while nobody answers
  const HAIL_TRIES = 8;
  const REPLY_WAIT_MS = 30000;  // silence after speaking before repeating
  const REPEATS = 2;
  const GAP_MS = 450;           // breath between transmissions

  // -------------------------------------------------------------------------
  // Radio
  // -------------------------------------------------------------------------

  /* Streaming linear resampler + ggwave decoder for ONE voice. Captured audio
   * at the device rate goes in; whenever a ggwave frame's worth has been
   * produced it is handed to the decoder. */
  class Listener {
    constructor(gg, voiceId, deviceRate, onText) {
      this.gg = gg;
      this.voiceId = voiceId;
      this.onText = onText;
      // The sender played a 48 kHz waveform at `rate`, so one second of the
      // original occupies 1/rate seconds here. Reading the capture at this
      // step puts it back on ggwave's clock.
      this.step = deviceRate / (GG_RATE * VOICES[voiceId].rate);
      this.pos = 0;     // read position relative to the current chunk
      this.prev = 0;    // last sample of the previous chunk
      this.frame = new Float32Array(GG_FRAME);
      this.bytes = new Int8Array(this.frame.buffer);
      this.fill = 0;
      const p = gg.getDefaultParameters();
      p.sampleRateInp = GG_RATE;
      p.sampleRateOut = GG_RATE;
      this.inst = gg.init(p);
    }
    feed(chunk) {
      const n = chunk.length, step = this.step;
      let pos = this.pos;
      while (pos < n - 1) {
        const j = Math.floor(pos), fr = pos - j;
        const a = j < 0 ? this.prev : chunk[j];
        this.frame[this.fill++] = a + (chunk[j + 1] - a) * fr;
        if (this.fill === GG_FRAME) { this.fill = 0; this.flush(); }
        pos += step;
      }
      this.prev = chunk[n - 1];
      this.pos = pos - n;
    }
    flush() {
      const res = this.gg.decode(this.inst, this.bytes);
      if (res && res.length) {
        let text = '';
        for (let i = 0; i < res.length; i++) text += String.fromCharCode(res[i] & 0xff);
        this.onText(this.voiceId, text);
      }
    }
    free() { try { this.gg.free(this.inst); } catch (_) { /* already gone */ } }
  }

  class Radio {
    /* opts: { listenFor: ['A'|'B', ...], loopback: bool,
     *         onFrame(voiceId, text), onTxStart(voiceId, text, seconds),
     *         onTxEnd(voiceId, text) } */
    constructor(gg, opts) {
      this.gg = gg;
      this.opts = opts;
      this.queue = Promise.resolve();
      this.closed = false;
      this.current = null;
    }

    async open() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      await this.ctx.resume();

      const p = this.gg.getDefaultParameters();
      p.sampleRateInp = GG_RATE;
      p.sampleRateOut = GG_RATE;
      this.tx = this.gg.init(p);

      this.out = this.ctx.createGain();
      this.out.gain.value = 0.9;
      this.out.connect(this.ctx.destination);

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      this.out.connect(this.analyser);

      // Everything the decoders hear arrives on this bus.
      this.inBus = this.ctx.createGain();
      this.inBus.connect(this.analyser);

      if (this.opts.loopback) {
        this.out.connect(this.inBus);
      } else {
        // The browser's voice processing is built to REMOVE exactly what this
        // page needs to hear: steady tones, and its own speaker.
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        this.mic = this.ctx.createMediaStreamSource(this.stream);
        this.mic.connect(this.inBus);
      }

      this.listeners = this.opts.listenFor.map(
        (id) => new Listener(this.gg, id, this.ctx.sampleRate, (v, t) => {
          if (!this.closed) this.opts.onFrame(v, t);
        }));

      const hear = (data) => {
        if (this.closed) return;
        this.heard += data.length;
        for (const l of this.listeners) l.feed(data);
      };
      this.heard = 0;
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;      // a capture node must be connected to run
      this.sink.connect(this.ctx.destination);
      // Capture on the audio thread where the browser can (see
      // capture-worklet.js for why). ScriptProcessor is the fallback: it
      // works everywhere but runs on the main thread and drops audio
      // whenever the page is busy, which costs long frames.
      let tap = null;
      if (this.ctx.audioWorklet && window.AudioWorkletNode) {
        try {
          await this.ctx.audioWorklet.addModule('capture-worklet.js');
          tap = new AudioWorkletNode(this.ctx, 'capture-tap', {
            numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
            channelCountMode: 'explicit', channelInterpretation: 'speakers',
          });
          tap.port.onmessage = (e) => hear(e.data);
          this.capture = 'worklet';
        } catch (_) { tap = null; }
      }
      if (!tap) {
        tap = this.ctx.createScriptProcessor(4096, 1, 1);
        tap.onaudioprocess = (e) => hear(e.inputBuffer.getChannelData(0));
        this.capture = 'script-processor';
      }
      this.proc = tap;
      this.inBus.connect(tap);
      tap.connect(this.sink);
    }

    /* Queue a transmission; resolves when it has finished playing. */
    transmit(voiceId, text, { flourish = false } = {}) {
      const job = this.queue.then(() => this.closed ? null : this.play(voiceId, text, flourish));
      this.queue = job.catch(() => {});
      return job;
    }

    async play(voiceId, text, flourish) {
      const v = VOICES[voiceId];
      if (flourish) await this.blips(v.flourish);
      if (this.closed) return;

      const view = this.gg.encode(this.tx, text, this.gg.ProtocolId[v.proto], 30);
      // `view` aliases the module's heap and is overwritten by the next
      // encode — copy it out before anything else touches ggwave.
      const native = new Float32Array(new Uint8Array(view).buffer);
      // Slow it down here rather than with AudioBufferSourceNode.playbackRate.
      // Stretching the waveform ourselves, straight to the device's own rate,
      // gives every browser the same samples to play; a 48 kHz buffer with a
      // playbackRate in a 44.1 kHz context came out ~9% short in Chromium,
      // which no receiver can undo.
      const step = (GG_RATE * v.rate) / this.ctx.sampleRate;
      const n = Math.floor((native.length - 1) / step);
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const samples = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        const x = i * step, j = Math.floor(x);
        samples[i] = native[j] + (native[j + 1] - native[j]) * (x - j);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.out);
      const seconds = buf.duration;

      this.opts.onTxStart(voiceId, text, seconds);
      await new Promise((resolve) => {
        this.current = { src, resolve };
        src.onended = resolve;
        src.start();
      });
      this.current = null;
      this.opts.onTxEnd(voiceId, text);
      await sleep(GAP_MS);
    }

    /* The handshake tone: three plain sine blips, rising for BLIP and falling
     * for TOCK. Purely for the ear — the machine-readable half of the
     * handshake is the ~HELO~ frame that follows. */
    async blips(freqs) {
      const t0 = this.ctx.currentTime + 0.02;
      freqs.forEach((f, i) => {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const at = t0 + i * 0.13;
        osc.frequency.value = f;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.25, at + 0.015);
        g.gain.linearRampToValueAtTime(0, at + 0.11);
        osc.connect(g); g.connect(this.out);
        osc.start(at); osc.stop(at + 0.12);
      });
      await sleep(freqs.length * 130 + 180);
    }

    spectrum(into) { if (this.analyser) this.analyser.getByteFrequencyData(into); }

    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.current) { try { this.current.src.stop(); } catch (_) {} this.current.resolve(); }
      if (this.proc) {
        this.proc.onaudioprocess = null;
        if (this.proc.port) this.proc.port.onmessage = null;
        this.proc.disconnect();
      }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      (this.listeners || []).forEach((l) => l.free());
      if (this.tx != null) { try { this.gg.free(this.tx); } catch (_) {} }
      if (this.ctx) this.ctx.close().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Droid — one agent loop
  // -------------------------------------------------------------------------

  class Droid {
    /* hooks: { say(id, text, opts) -> Promise, thinking(id, bool),
     *          note(text, kind), done(reason, kind) } */
    constructor(id, cfg, hooks) {
      this.id = id;
      this.cfg = cfg;           // { linesEach, topic }
      this.hooks = hooks;
      this.history = [];        // [{from, text}] as this droid knows it
      this.state = 'idle';      // idle | hailing | waiting | linked | done
      this.busy = false;        // a model call or transmission is in flight
      this.lastHeard = null;
      this.lastSaid = null;
      this.spoken = 0;
      this.timer = null;
    }

    start() {
      if (this.id === 'A') { this.state = 'hailing'; this.hail(1); }
      else { this.state = 'waiting'; this.hooks.note(`${VOICES.B.name} is listening for a hail…`); }
    }

    stop() { this.state = 'done'; clearTimeout(this.timer); }

    async hail(attempt) {
      if (this.state !== 'hailing') return;
      this.hooks.note(`${VOICES.A.name} is hailing… (${attempt}/${HAIL_TRIES})`);
      await this.hooks.say(this.id, HELO, { flourish: true });
      if (this.state !== 'hailing') return;
      this.timer = setTimeout(() => {
        if (attempt >= HAIL_TRIES) this.hooks.done('Nobody answered the hail.', 'bad');
        else this.hail(attempt + 1);
      }, HAIL_EVERY_MS);
    }

    /* A frame from the other droid arrived over the air. */
    async hear(text) {
      if (this.state === 'done' || this.state === 'idle') return;
      clearTimeout(this.timer);

      if (text === BYE) { this.hooks.done('Conversation complete.', 'ok'); return; }

      if (text === HELO) {
        if (this.id === 'B') {
          // Answer every hail, including a repeat: a repeat means ours was
          // not heard.
          if (this.busy) return;
          this.state = 'linked';
          this.busy = true;
          await this.hooks.say(this.id, HELO, { flourish: true });
          this.busy = false;
        } else if (this.state === 'hailing') {
          this.state = 'linked';
          this.hooks.note('Link established.');
          this.speak();
        }
        return;
      }

      if (this.busy) return;                 // talking over us; ignore
      if (this.state === 'waiting') this.state = 'linked';   // missed the hail
      if (this.state === 'hailing') this.state = 'linked';

      if (text === this.lastHeard && this.lastSaid) {
        // The same line again: our answer was lost. Repeat it rather than
        // asking the model for a second, different answer.
        this.busy = true;
        await this.hooks.say(this.id, this.lastSaid);
        this.busy = false;
        this.awaitReply(0);
        return;
      }
      this.lastHeard = text;
      this.history.push({ from: other(this.id), text });
      this.speak();
    }

    async speak() {
      if (this.state === 'done') return;
      if (this.spoken >= this.cfg.linesEach) {
        // B finishes the exchange; A, which spoke first, just stops talking
        // once it has had its lines and lets B have the last word.
        if (this.id === 'A') { this.awaitReply(REPEATS); return; }
        this.busy = true;
        await this.hooks.say(this.id, BYE);
        this.hooks.done('Conversation complete.', 'ok');
        return;
      }
      this.busy = true;
      this.hooks.thinking(this.id, true);
      let text;
      try {
        text = await askProxy(this.id, this.history, this.cfg.topic);
      } catch (err) {
        this.hooks.thinking(this.id, false);
        this.busy = false;
        if (this.state !== 'done') {
          try { await this.hooks.say(this.id, BYE); } catch (_) {}
          this.hooks.done(`${VOICES[this.id].name} could not think: ${err.message}`, 'bad');
        }
        return;
      }
      this.hooks.thinking(this.id, false);
      if (this.state === 'done') return;
      this.history.push({ from: this.id, text });
      this.lastSaid = text;
      this.spoken++;
      await this.hooks.say(this.id, text);
      this.busy = false;
      if (this.state === 'done') return;
      if (this.id === 'B' && this.spoken >= this.cfg.linesEach) {
        this.busy = true;
        await this.hooks.say(this.id, BYE);
        this.hooks.done('Conversation complete.', 'ok');
        return;
      }
      this.awaitReply(0);
    }

    /* After speaking: if nothing comes back, say it again a couple of times,
     * then give up. */
    awaitReply(repeatsUsed) {
      clearTimeout(this.timer);
      this.timer = setTimeout(async () => {
        if (this.state === 'done' || this.busy) return;
        if (repeatsUsed >= REPEATS || !this.lastSaid) {
          this.hooks.done('The link went quiet.', 'bad');
          return;
        }
        this.hooks.note(`${VOICES[this.id].name} heard nothing back — repeating.`);
        this.busy = true;
        await this.hooks.say(this.id, this.lastSaid);
        this.busy = false;
        this.awaitReply(repeatsUsed + 1);
      }, REPLY_WAIT_MS);
    }
  }

  async function askProxy(role, history, topic) {
    let res;
    try {
      res = await fetch('api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, history, topic }),
      });
    } catch (_) {
      throw new Error('the proxy is unreachable');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `proxy error ${res.status}`);
    const text = String((data && data.text) || '').replace(/~/g, '').trim();
    if (!text) throw new Error('the proxy returned an empty line');
    return text;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('controls'), go: $('go'), role: $('role'), turns: $('turns'),
    topic: $('topic'), loopback: $('loopback'), status: $('status'),
    log: $('log'), scope: $('scope'),
    panel: { A: $('droid-A'), B: $('droid-B') },
  };

  let gg = null;        // the ggwave module, loaded once
  let session = null;   // { radio, droids: {A?, B?}, pendingRow: {A?, B?} }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = kind || '';
  }

  function logLine(voiceId, text) {
    const li = document.createElement('li');
    li.dataset.voice = voiceId;
    const name = document.createElement('span'); name.className = 'name';
    name.textContent = VOICES[voiceId].name;
    const body = document.createElement('span'); body.className = 'text';
    body.textContent = text;
    const tick = document.createElement('span'); tick.className = 'tick';
    tick.textContent = '✓'; tick.title = 'decoded from sound';
    li.append(name, body, tick);
    els.log.append(li);
    li.scrollIntoView({ block: 'nearest' });
    return li;
  }

  function logNote(text) {
    const li = document.createElement('li');
    li.className = 'sys';
    li.textContent = text;
    els.log.append(li);
  }

  /* Reveal a line a character at a time over roughly the length of its
   * transmission, so the subtitle keeps pace with the chirps. */
  function typeOut(el, text, seconds) {
    const started = performance.now();
    const total = Math.max(300, seconds * 1000 * 0.92);
    el.dataset.typing = text;
    const step = () => {
      if (el.dataset.typing !== text) return;      // superseded
      const k = Math.min(1, (performance.now() - started) / total);
      el.textContent = text.slice(0, Math.ceil(text.length * k));
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  const label = (text) => (text === HELO ? '[handshake]' : text === BYE ? '[signing off]' : text);

  function startSession() {
    const role = els.role.value;
    const local = role === 'both' ? ['A', 'B'] : [role];
    const cfg = { linesEach: parseInt(els.turns.value, 10) || 6, topic: els.topic.value.trim() };
    const s = { droids: {}, pendingRow: {}, local, ended: false };

    const hooks = {
      say: (id, text, opts) => s.radio.transmit(id, text, opts),
      thinking: (id, on) => els.panel[id].classList.toggle('thinking', on),
      note: (text) => setStatus(text),
      done: (reason, kind) => endSession(reason, kind),
    };

    s.radio = new Radio(gg, {
      // Each local droid needs to hear the OTHER voice. With both droids
      // here that is both voices; with one, only the far end's.
      listenFor: local.map(other),
      loopback: els.loopback.checked,
      onTxStart: (id, text, seconds) => {
        els.panel[id].classList.add('talking');
        const shown = label(text);
        typeOut(els.panel[id].querySelector('.line'), shown, seconds);
        const row = logLine(id, '');
        typeOut(row.querySelector('.text'), shown, seconds);
        s.pendingRow[id] = { row, text };
      },
      onTxEnd: (id) => els.panel[id].classList.remove('talking'),
      onFrame: (id, text) => {
        // A frame in voice `id` was decoded from audio.
        const pending = s.pendingRow[id];
        if (pending && pending.text === text) {
          pending.row.classList.add('decoded');     // our own speaker, heard back
        } else if (!local.includes(id)) {
          const shown = label(text);
          els.panel[id].querySelector('.line').textContent = shown;
          logLine(id, shown).classList.add('decoded');
        }
        const listener = s.droids[other(id)];
        if (listener) listener.hear(text);
      },
    });

    for (const id of ['A', 'B']) {
      els.panel[id].classList.toggle('away', !local.includes(id));
      els.panel[id].querySelector('.line').textContent = '';
      els.panel[id].classList.remove('talking', 'thinking');
    }
    els.log.textContent = '';
    session = s;
    window.__droids = s;      // for the test harness and the curious

    return s.radio.open().then(() => {
      if (session !== s) { s.radio.close(); return; }
      for (const id of local) s.droids[id] = new Droid(id, cfg, hooks);
      // B first, so that in one-device mode it is listening before A hails.
      if (s.droids.B) s.droids.B.start();
      if (s.droids.A) s.droids.A.start();
      drawScope();
    });
  }

  function endSession(reason, kind) {
    const s = session;
    if (!s || s.ended) return;
    s.ended = true;
    session = null;
    Object.values(s.droids).forEach((d) => d.stop());
    s.radio.close();
    for (const id of ['A', 'B']) els.panel[id].classList.remove('talking', 'thinking');
    if (reason) { setStatus(reason, kind); logNote(reason); }
    els.go.textContent = 'Start';
    els.go.classList.remove('stop');
    setControlsDisabled(false);
  }

  function setControlsDisabled(on) {
    for (const el of [els.role, els.turns, els.topic, els.loopback]) el.disabled = on;
  }

  function drawScope() {
    const s = session;
    const c = els.scope, g = c.getContext('2d');
    const bins = new Uint8Array(512);
    const css = getComputedStyle(document.documentElement);
    const colA = css.getPropertyValue('--a').trim(), colB = css.getPropertyValue('--b').trim();
    const frame = () => {
      g.clearRect(0, 0, c.width, c.height);
      if (session !== s) return;
      s.radio.spectrum(bins);
      // Show 0 to ~8 kHz: everything either voice emits lives in there.
      const top = Math.min(bins.length, Math.round(8000 / (s.radio.ctx.sampleRate / 1024)));
      const bars = 90, per = top / bars, w = c.width / bars;
      const talking = els.panel.B.classList.contains('talking') ? colB : colA;
      g.fillStyle = talking;
      for (let i = 0; i < bars; i++) {
        let m = 0;
        for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) m = Math.max(m, bins[j]);
        const h = (m / 255) * (c.height - 8);
        g.fillRect(i * w + 1, c.height - 4 - h, w - 2, h);
      }
      requestAnimationFrame(frame);
    };
    frame();
  }

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (session) { endSession('Stopped.', ''); return; }
    if (!gg) return;
    els.go.textContent = 'Stop';
    els.go.classList.add('stop');
    setControlsDisabled(true);
    setStatus(els.loopback.checked ? 'Opening the audio link…' : 'Asking for the microphone…');
    try {
      await startSession();
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      const missing = err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError');
      endSession(
        denied ? 'Microphone access was refused. Allow it and press Start again, or tick "No microphone".'
        : missing ? 'No microphone found. Tick "No microphone" to run without one.'
        : `Could not start audio: ${err && err.message ? err.message : err}`,
        'bad');
    }
  });

  // Controls can be preset from the URL: ?role=A|B|both&turns=3&topic=...&loopback=1
  const q = new URLSearchParams(location.search);
  if (['A', 'B', 'both'].includes(q.get('role'))) els.role.value = q.get('role');
  if (['3', '6', '10'].includes(q.get('turns'))) els.turns.value = q.get('turns');
  if (q.get('topic')) els.topic.value = q.get('topic').slice(0, 80);
  if (q.get('loopback') === '1') els.loopback.checked = true;

  els.go.disabled = true;
  (async () => {
    try {
      gg = await window.ggwave_factory();
      if (gg.disableLog) gg.disableLog();
    } catch (err) {
      setStatus('The modem (ggwave) failed to load in this browser.', 'bad');
      return;
    }
    els.go.disabled = false;
    setStatus('Ready. Turn the volume up and press Start.');
    try {
      const h = await (await fetch('api/health')).json();
      if (!h.hasKey) setStatus('Ready — but the proxy has no API key yet, so the droids will have nothing to say.', 'bad');
    } catch (_) {
      setStatus('Ready — but the proxy is not answering, so the droids will have nothing to say.', 'bad');
    }
  })();
})();
