/* Capture tap for Droid Talk.
 *
 * Runs on the audio thread and forwards what it hears to the page in blocks.
 * Decoding needs every sample in order: a missed block lands in the middle of
 * a burst and the whole frame fails its checksum. Capturing here rather than
 * in a main-thread callback means a busy page delays blocks instead of losing
 * them.
 */
class CaptureTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.fill = 0;
  }
  process(inputs) {
    // With nothing playing into it the input has NO channels rather than a
    // channel of zeros (the no-microphone path, between bursts). Forward
    // silence anyway so the stream the decoders see stays continuous in time
    // instead of having its bursts butted up against each other.
    const ch = (inputs[0] && inputs[0][0]) || CaptureTap.SILENCE;
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(ch.length - i, this.block.length - this.fill);
      this.block.set(ch.subarray(i, i + n), this.fill);
      this.fill += n; i += n;
      if (this.fill === this.block.length) {
        const out = this.block;
        this.block = new Float32Array(4096);
        this.fill = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
CaptureTap.SILENCE = new Float32Array(128);
registerProcessor('capture-tap', CaptureTap);
