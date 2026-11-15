/* Droid Talk — the page.
 *
 * Three layers, top to bottom of this file:
 *
 *   Radio       the modem. Turns text into ggwave tones and plays them;
 *               listens on the microphone and turns tones back into text.
 *   Droid       one agent loop (conversation mode). Hears a line, asks the
 *               proxy what to say, says it.
 *   Translator  an interpreter between a person and droid-speak (translator
 *               mode). Chirps what its human said; reads aloud what it hears.
 *   UI          controls, speech in and out, subtitles, the scope.
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
  // The speed control multiplies both voices' rates. A sender may use any of
  // these and change between bursts: a receiver runs one decoder per voice
  // per speed, and only the one matching what was played ever produces
  // anything (checked for all 36 sender/listener pairings), so the two ends
  // never have to agree on a setting.
  const SPEEDS = { slow: 0.75, normal: 1, fast: 1.25 };
  const other = (id) => (id === 'A' ? 'B' : 'A');

  // Control frames. '~' is stripped from everything the model says, so a
  // droid cannot utter one by accident.
  const HELO = '~HELO~';
  const BYE = '~BYE~';

  // Translator-mode frames. A phrase is cut into pieces small enough to keep
  // each burst short; a piece travels as  ~t <seq> <more?> <text>:
  //   seq   one digit, so a repeated frame can be told from a repeated phrase
  //   more  '+' when another piece follows, '.' on the last
  // and every such frame is answered with ACK.
  const ACK = '~K~';
  const PIECE_BYTES = 64;       // text bytes per frame (ggwave's limit is 140 in all)
  const PHRASE_CHARS = 240;
  const ACK_WAIT_MS = 9000;
  const ACK_TRIES = 2;
  const XFRAME = /^~t(\d)([.+])([\s\S]*)$/;

  // The human side of the translator: the language spoken into it and read
  // out of it. The browser's own, falling back to English.
  const SPEECH_LANG = (navigator.language || 'en-US');

  const HAIL_EVERY_MS = 7000;   // re-hail interval while nobody answers
  const HAIL_TRIES = 8;
  const REPLY_WAIT_MS = 30000;  // silence after speaking before repeating
  const REPEATS = 2;
  const GAP_MS = 450;           // breath between transmissions

  // -------------------------------------------------------------------------
  // Radio
  // -------------------------------------------------------------------------

  /* ggwave allows four instances per loaded module, and a receiver that
   * listens for both voices at every speed needs seven with its transmitter.
   * Each call to the factory is a separate module with its own four, so the
   * pool just loads another when the ones it has are full. */
  const modem = {
    mods: [],
    async acquire() {
      for (const gg of this.mods) {
        const p = gg.getDefaultParameters();
        p.sampleRateInp = GG_RATE;
        p.sampleRateOut = GG_RATE;
        const inst = gg.init(p);
        if (inst >= 0) return { gg, inst };
      }
      const gg = await window.ggwave_factory();
      if (gg.disableLog) gg.disableLog();
      this.mods.push(gg);
      return this.acquire();
    },
    release(h) { if (h) { try { h.gg.free(h.inst); } catch (_) { /* already gone */ } } },
  };

  /* Streaming linear resampler + ggwave decoder for ONE voice at ONE speed. Captured audio
   * at the device rate goes in; whenever a ggwave frame's worth has been
   * produced it is handed to the decoder. */
  class Listener {
    constructor(handle, voiceId, speed, deviceRate, onText) {
      this.handle = handle;
      this.gg = handle.gg;
      this.inst = handle.inst;
      this.voiceId = voiceId;
      this.onText = onText;
      // The sender played a 48 kHz waveform at `rate`, so one second of the
      // original occupies 1/rate seconds here. Reading the capture at this
      // step puts it back on ggwave's clock.
      this.step = deviceRate / (GG_RATE * VOICES[voiceId].rate * SPEEDS[speed]);
      this.pos = 0;     // read position relative to the current chunk
      this.prev = 0;    // last sample of the previous chunk
      this.frame = new Float32Array(GG_FRAME);
      this.bytes = new Int8Array(this.frame.buffer);
      this.fill = 0;
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
        // The payload is UTF-8 (embind encodes the JS string that way on the
        // sending side). Copy before decoding: `res` aliases the module heap.
        this.onText(this.voiceId, UTF8.decode(new Uint8Array(res)));
      }
    }
    free() { modem.release(this.handle); }
  }

  const UTF8 = new TextDecoder('utf-8');
  const UTF8_ENC = new TextEncoder();
  const bytes = (str) => UTF8_ENC.encode(str).length;

  class Radio {
    /* opts: { listenFor: ['A'|'B', ...], loopback: bool, speed, volume,
     *         onFrame(voiceId, text), onTxStart(voiceId, text, seconds),
     *         onTxEnd(voiceId, text) } */
    constructor(opts) {
      this.opts = opts;
      this.speed = opts.speed || 'normal';   // may be changed between bursts
      this.queue = Promise.resolve();
      this.closed = false;
      this.current = null;
    }

    /* 0..1. Safe to call at any time, including mid-burst. */
    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v));
      if (this.out) this.out.gain.value = this.volume;
    }

    async open() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      await this.ctx.resume();

      this.txh = await modem.acquire();

      // Everything this page plays goes through `mix`; `out` is the volume
      // knob between it and the speaker. The scope and the no-microphone
      // path tap `mix`, so turning the volume down changes what a listener
      // in the room hears and nothing else.
      this.mix = this.ctx.createGain();
      this.out = this.ctx.createGain();
      this.setVolume(this.opts.volume == null ? 0.9 : this.opts.volume);
      this.mix.connect(this.out);
      this.out.connect(this.ctx.destination);

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      this.mix.connect(this.analyser);

      // Everything the decoders hear arrives on this bus.
      this.inBus = this.ctx.createGain();
      this.inBus.connect(this.analyser);

      if (this.opts.loopback) {
        this.mix.connect(this.inBus);
      } else {
        // The browser's voice processing is built to REMOVE exactly what this
        // page needs to hear: steady tones, and its own speaker.
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        this.mic = this.ctx.createMediaStreamSource(this.stream);
        this.mic.connect(this.inBus);
      }

      this.listeners = [];
      for (const id of this.opts.listenFor) {
        for (const speed of Object.keys(SPEEDS)) {
          this.listeners.push(new Listener(await modem.acquire(), id, speed, this.ctx.sampleRate,
            (v, t) => { if (!this.closed) this.opts.onFrame(v, t); }));
        }
      }

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

      const gg = this.txh.gg;
      const view = gg.encode(this.txh.inst, text, gg.ProtocolId[v.proto], 30);
      // `view` aliases the module's heap and is overwritten by the next
      // encode — copy it out before anything else touches ggwave.
      const native = new Float32Array(new Uint8Array(view).buffer);
      // Slow it down here rather than with AudioBufferSourceNode.playbackRate.
      // Stretching the waveform ourselves, straight to the device's own rate,
      // gives every browser the same samples to play; a 48 kHz buffer with a
      // playbackRate in a 44.1 kHz context came out ~9% short in Chromium,
      // which no receiver can undo.
      const step = (GG_RATE * v.rate * SPEEDS[this.speed]) / this.ctx.sampleRate;
      const n = Math.floor((native.length - 1) / step);
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const samples = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        const x = i * step, j = Math.floor(x);
        samples[i] = native[j] + (native[j + 1] - native[j]) * (x - j);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.mix);
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
        osc.connect(g); g.connect(this.mix);
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
      modem.release(this.txh);
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

  // -------------------------------------------------------------------------
  // Translator — an interpreter between a person and droid-speak
  // -------------------------------------------------------------------------

  /* Cut a phrase into pieces of at most `max` UTF-8 bytes whose concatenation
   * is exactly the phrase. Breaks after a space where there is one, so words
   * stay whole; scripts without spaces are cut between characters. */
  function pieces(text, max) {
    const out = [];
    let cur = '', lastSpace = -1;
    for (const ch of text) {
      if (bytes(cur + ch) > max) {
        if (lastSpace >= 0 && lastSpace < cur.length - 1) {
          out.push(cur.slice(0, lastSpace + 1));
          cur = cur.slice(lastSpace + 1);
        } else {
          out.push(cur);
          cur = '';
        }
        lastSpace = cur.lastIndexOf(' ');
      }
      cur += ch;
      if (ch === ' ') lastSpace = cur.length - 1;
    }
    if (cur) out.push(cur);
    return out;
  }

  class Translator {
    /* hooks: { say(id, text) -> Promise, note(text, kind),
     *          result(id, phrase) } */
    constructor(id, hooks) {
      this.id = id;
      this.hooks = hooks;
      this.state = 'idle';
      this.queue = [];        // frames waiting to go out
      this.inFlight = false;  // the head of the queue is out, awaiting its ACK
      this.tries = 0;
      this.seq = 0;
      this.timer = null;
      this.parts = [];        // pieces of the phrase currently arriving
      this.lastFrame = null;
    }

    start() { this.state = 'ready'; }
    stop() { this.state = 'done'; clearTimeout(this.timer); }

    /* The human at this end said something. */
    send(phrase) {
      if (this.state !== 'ready') return;
      const cut = pieces(phrase, PIECE_BYTES);
      cut.forEach((piece, i) => {
        this.seq = (this.seq + 1) % 10;
        this.queue.push(`~t${this.seq}${i < cut.length - 1 ? '+' : '.'}${piece}`);
      });
      this.pump();
    }

    async pump() {
      if (this.inFlight || !this.queue.length || this.state !== 'ready') return;
      this.inFlight = true;
      await this.hooks.say(this.id, this.queue[0]);
      if (this.state !== 'ready' || !this.inFlight) return;
      this.timer = setTimeout(() => {
        this.inFlight = false;
        if (++this.tries > ACK_TRIES) {
          this.queue = [];
          this.tries = 0;
          this.hooks.note('The other droid never acknowledged — that phrase was dropped.', 'bad');
          return;
        }
        this.hooks.note('No acknowledgement — sending it again.');
        this.pump();
      }, ACK_WAIT_MS);
    }

    /* A frame from the other end arrived over the air. */
    async hear(text) {
      if (this.state !== 'ready') return;
      if (text === ACK) {
        if (!this.inFlight) return;
        clearTimeout(this.timer);
        this.inFlight = false;
        this.tries = 0;
        this.queue.shift();
        if (!this.queue.length) this.hooks.note('Delivered.', 'ok');
        this.pump();
        return;
      }
      const m = XFRAME.exec(text);
      if (!m) return;
      const [, , more, piece] = m;
      // The same frame again means our ACK was lost: acknowledge it again,
      // but do not add its text twice.
      const repeat = text === this.lastFrame;
      this.lastFrame = text;
      let phrase = null;
      if (!repeat) {
        this.parts.push(piece);
        if (more === '.') { phrase = this.parts.join(''); this.parts = []; }
      }
      // Acknowledge first and speak once the chirp has finished — never
      // over it.
      await this.hooks.say(this.id, ACK);
      if (phrase !== null && this.state === 'ready') this.hooks.result(this.id, phrase);
    }
  }

  async function postJSON(path, payload) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (_) {
      throw new Error('the proxy is unreachable');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `proxy error ${res.status}`);
    return data || {};
  }

  async function askProxy(role, history, topic) {
    const data = await postJSON('api/chat', { role, history, topic });
    const text = String(data.text || '').replace(/~/g, '').trim();
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
    mode: $('mode'), speed: $('speed'), volume: $('volume'),
    talkbar: $('talkbar'), talk: $('talk'), say: $('say'), send: $('send'),
    panel: { A: $('droid-A'), B: $('droid-B') },
  };

  let ready = false;    // the ggwave module has loaded
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

  const label = (text) => {
    if (text === HELO) return '[handshake]';
    if (text === BYE) return '[signing off]';
    if (text === ACK) return '[received]';
    const m = XFRAME.exec(text);
    return m ? m[3] + (m[2] === '+' ? ' …' : '') : text;
  };

  // --- speech out -----------------------------------------------------------

  function speak(text) {
    if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return false;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = SPEECH_LANG;
    window.speechSynthesis.speak(u);
    return true;
  }

  /* iOS only lets a page speak if the first utterance was started by a tap.
   * A silent one from the Start button opens the door for the ones that
   * arrive later on their own. */
  function unlockSpeech() {
    if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }

  // --- speech in ------------------------------------------------------------

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;

  function stopListening() {
    if (rec) { try { rec.abort(); } catch (_) {} }
    rec = null;
    els.talk.classList.remove('listening');
    els.talk.textContent = 'Tap to talk';
  }

  function toggleTalk() {
    if (!session || session.mode !== 'translate') return;
    if (rec) { try { rec.stop(); } catch (_) {} return; }   // finish and send
    if (!Recognition) {
      setStatus('This browser has no speech recognition — type the phrase instead.', 'bad');
      els.say.focus();
      return;
    }
    const r = new Recognition();
    r.lang = SPEECH_LANG;
    r.interimResults = true;
    r.maxAlternatives = 1;
    let heard = '';
    r.onresult = (e) => {
      heard = '';
      for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript;
      els.say.value = heard;
    };
    r.onerror = (e) => {
      const why = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Speech recognition was refused — allow the microphone, or type the phrase.'
        : e.error === 'no-speech' ? 'Heard nothing. Tap and try again.'
        : `Speech recognition failed (${e.error}) — type the phrase instead.`;
      setStatus(why, 'bad');
    };
    r.onend = () => {
      if (rec !== r) return;            // aborted by Stop
      rec = null;
      els.talk.classList.remove('listening');
      els.talk.textContent = 'Tap to talk';
      if (heard.trim()) sendPhrase(heard);
    };
    rec = r;
    els.talk.classList.add('listening');
    els.talk.textContent = 'Listening… tap when done';
    setStatus('Listening…');
    try { r.start(); } catch (err) { rec = null; stopListening(); setStatus(`Could not start speech recognition: ${err.message}`, 'bad'); }
  }

  function sendPhrase(raw) {
    const s = session;
    if (!s || s.mode !== 'translate') return;
    const phrase = String(raw).replace(/\s+/g, ' ').trim().slice(0, PHRASE_CHARS);
    if (!phrase) return;
    els.say.value = '';
    setStatus('Saying it in droid…');
    s.droids[s.talker].send(phrase);
  }

  function startSession() {
    const role = els.role.value;
    const local = role === 'both' ? ['A', 'B'] : [role];
    const mode = els.mode.value;
    const cfg = { linesEach: parseInt(els.turns.value, 10) || 6, topic: els.topic.value.trim() };
    const s = { droids: {}, pendingRow: {}, local, ended: false, mode, spoken: [] };
    // Translator mode: the human at this device talks through `talker`. With
    // both droids on one device BLIP says the phrase and TOCK hears it,
    // acknowledges, and reads it back — the whole round trip on one screen.
    s.talker = role === 'both' ? 'A' : role;

    const hooks = {
      say: (id, text, opts) => s.radio.transmit(id, text, opts),
      thinking: (id, on) => els.panel[id].classList.toggle('thinking', on),
      note: (text, kind) => setStatus(text, kind),
      done: (reason, kind) => endSession(reason, kind),
      result: (id, phrase) => readOut(id, phrase),
    };

    // A decoded line, read aloud for the human.
    const readOut = (id, phrase) => {
      els.panel[id].querySelector('.line').textContent = phrase;
      logLine(id, phrase).classList.add('spoken');
      s.spoken.push({ id, text: phrase });
      if (!speak(phrase)) setStatus('This browser cannot speak — read the subtitle instead.', 'bad');
      else setStatus(`${VOICES[id].name} said: ${phrase}`, 'ok');
    };

    s.radio = new Radio({
      speed: els.speed.value,
      volume: els.volume.value / 100,
      // Each local droid needs to hear the OTHER voice. With both droids
      // here that is both voices; with one, only the far end's. A translator
      // listens to everything, so it can also interpret two droids that are
      // talking to each other.
      listenFor: mode === 'translate' ? ['A', 'B'] : local.map(other),
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
        const own = pending && pending.text === text;   // our own speaker, heard back
        // In translator mode, a line that is not one of the translator's own
        // frames came from a droid in conversation mode.
        const overheard = mode === 'translate' && !own && text !== ACK && !XFRAME.test(text);
        if (own) {
          pending.row.classList.add('decoded');
          // One voice on this device: hearing ourselves is an echo, not news.
          if (mode === 'translate' && local.length === 1) return;
        } else if ((!local.includes(id) || mode === 'translate') && !(overheard && text !== HELO && text !== BYE)) {
          const shown = label(text);
          els.panel[id].querySelector('.line').textContent = shown;
          logLine(id, shown).classList.add('decoded');
        }
        if (overheard) {
          // Interpret its lines for the human (readOut adds the subtitle);
          // its handshakes need no reading out.
          if (text !== HELO && text !== BYE) readOut(id, text);
          return;
        }
        if (mode === 'translate' && own && !XFRAME.test(text) && text !== ACK) return;
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
      for (const id of local) {
        s.droids[id] = mode === 'translate'
          ? new Translator(id, hooks)
          : new Droid(id, cfg, hooks);
      }
      // B first, so that in one-device mode it is listening before A hails.
      if (s.droids.B) s.droids.B.start();
      if (s.droids.A) s.droids.A.start();
      if (mode === 'translate') {
        for (const el of [els.talk, els.say, els.send]) el.disabled = false;
        setStatus(Recognition ? 'Ready. Tap to talk, or type a phrase.'
          : 'Ready. This browser has no speech recognition, so type a phrase.');
      }
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
    stopListening();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    for (const el of [els.talk, els.say, els.send]) el.disabled = true;
    for (const id of ['A', 'B']) els.panel[id].classList.remove('talking', 'thinking');
    if (reason) { setStatus(reason, kind); logNote(reason); }
    els.go.textContent = 'Start';
    els.go.classList.remove('stop');
    setControlsDisabled(false);
  }

  function setControlsDisabled(on) {
    for (const el of [els.mode, els.role, els.turns, els.topic, els.loopback]) el.disabled = on;
  }

  /* Show the controls that belong to the chosen mode and role. */
  function syncControls() {
    const xlate = els.mode.value === 'translate';
    document.querySelectorAll('.only-chat').forEach((el) => { el.hidden = xlate; });
    els.talkbar.hidden = !xlate;
    // The role labels describe a conversation; in translator mode the choice
    // is simply which voice this device uses.
    for (const opt of els.role.options) {
      if (opt.value === 'A') opt.textContent = xlate ? 'BLIP — droid A' : 'BLIP — droid A (speaks first)';
      if (opt.value === 'B') opt.textContent = xlate ? 'TOCK — droid B' : 'TOCK — droid B (answers)';
    }
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
    if (!ready) return;
    els.go.textContent = 'Stop';
    els.go.classList.add('stop');
    setControlsDisabled(true);
    setStatus(els.loopback.checked ? 'Opening the audio link…' : 'Asking for the microphone…');
    if (els.mode.value === 'translate') unlockSpeech();   // must be inside the tap
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

  // Speed and volume stay live during a session: neither needs the far end
  // to know.
  els.speed.addEventListener('change', () => { if (session) session.radio.speed = els.speed.value; });
  els.volume.addEventListener('input', () => { if (session) session.radio.setVolume(els.volume.value / 100); });
  els.mode.addEventListener('change', syncControls);
  els.role.addEventListener('change', syncControls);
  els.talk.addEventListener('click', toggleTalk);
  els.talkbar.addEventListener('submit', (e) => { e.preventDefault(); sendPhrase(els.say.value); });

  // Controls can be preset from the URL:
  //   ?mode=chat|translate&role=A|B|both&turns=3&topic=...&speed=slow|normal|fast&volume=0-100&loopback=1
  if (['chat', 'translate'].includes(new URLSearchParams(location.search).get('mode'))) {
    els.mode.value = new URLSearchParams(location.search).get('mode');
  }
  const q = new URLSearchParams(location.search);
  if (['A', 'B', 'both'].includes(q.get('role'))) els.role.value = q.get('role');
  if (['3', '6', '10'].includes(q.get('turns'))) els.turns.value = q.get('turns');
  if (q.get('topic')) els.topic.value = q.get('topic').slice(0, 80);
  if (q.get('loopback') === '1') els.loopback.checked = true;
  if (SPEEDS[q.get('speed')]) els.speed.value = q.get('speed');
  if (/^\d{1,3}$/.test(q.get('volume') || '')) els.volume.value = Math.min(100, +q.get('volume'));
  syncControls();

  els.go.disabled = true;
  (async () => {
    try {
      modem.release(await modem.acquire());   // load the first module now
      ready = true;
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
