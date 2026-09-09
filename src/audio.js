/**
 * audio.js — all sounds are synthesised with the WebAudio API, so there are no
 * audio assets to load. Sounds are created on demand and cleaned up when they
 * finish.
 */

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.enabled = true;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  resume() {
    if (!this.enabled) return;
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
          this.enabled = false;
          return;
        }
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);

        // a little room reverb via a convolver with a synthetic impulse
        this.verb = this.ctx.createConvolver();
        this.verb.buffer = this.makeImpulse(1.1, 2.6);
        this.verbGain = this.ctx.createGain();
        this.verbGain.gain.value = 0.22;
        this.verb.connect(this.verbGain);
        this.verbGain.connect(this.master);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      // no audio device (or blocked): the game plays on silently
      this.enabled = false;
      this.ctx = null;
    }
  }

  /** True when a sound can actually be played right now. */
  get ready() {
    return this.enabled && this.ctx && this.ctx.state !== 'closed' && !this.muted;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  noiseBuffer(seconds = 0.12) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Overall output level for a sound at a given impact speed (m/s). */
  level(speed) {
    return Math.min(1, Math.max(0.05, speed / 6));
  }

  /** Sharp phenolic click for ball-on-ball. */
  ballHit(speed, pan = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const lvl = this.level(speed);
    const out = this.ctx.createGain();
    out.gain.value = 0.55 * lvl;
    const panner = this.ctx.createStereoPanner
      ? this.ctx.createStereoPanner()
      : null;
    if (panner) {
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      out.connect(panner);
      panner.connect(this.master);
      panner.connect(this.verb);
    } else {
      out.connect(this.master);
      out.connect(this.verb);
    }

    // noise transient
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.05);
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 2600 + lvl * 3200;
    nf.Q.value = 1.1;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.9, t);
    ng.gain.exponentialRampToValueAtTime(0.0008, t + 0.045);
    n.connect(nf);
    nf.connect(ng);
    ng.connect(out);
    n.start(t);
    n.stop(t + 0.06);

    // a couple of resonant partials give the ball its pitch
    const base = 1750 + lvl * 900;
    for (const [mult, gain, dur] of [
      [1, 0.5, 0.09],
      [1.63, 0.28, 0.06],
      [2.71, 0.16, 0.045],
    ]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(base * mult, t);
      o.frequency.exponentialRampToValueAtTime(base * mult * 0.86, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
  }

  /** Dull thud off the rubber cushion. */
  cushionHit(speed, pan = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const lvl = this.level(speed);
    const out = this.ctx.createGain();
    out.gain.value = 0.4 * lvl;
    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      out.connect(panner);
      panner.connect(this.master);
      panner.connect(this.verb);
    } else {
      out.connect(this.master);
    }

    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.1);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(700 + lvl * 900, t);
    f.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    n.connect(f);
    f.connect(g);
    g.connect(out);
    n.start(t);
    n.stop(t + 0.11);

    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(150 + lvl * 90, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + 0.1);
  }

  /** Ball rattling into a pocket. */
  pocket() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.value = 0.5;
    out.connect(this.master);
    out.connect(this.verb);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.3);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + 0.36);

    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.25);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    n.connect(f);
    f.connect(ng);
    ng.connect(out);
    n.start(t);
    n.stop(t + 0.26);
  }

  /** Cue tip striking the ball. */
  strike(power) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const lvl = 0.25 + power * 0.75;
    const out = this.ctx.createGain();
    out.gain.value = 0.6 * lvl;
    out.connect(this.master);

    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.04);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1500 + power * 2200;
    f.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    n.connect(f);
    f.connect(g);
    g.connect(out);
    n.start(t);
    n.stop(t + 0.05);

    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(420 + power * 380, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.05);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + 0.07);
  }

  /** Soft UI blip. */
  ui(freq = 660) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.1);
  }
}
