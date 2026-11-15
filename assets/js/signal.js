'use strict';

// Passive signal monitoring. The microphone stream is supplied by the existing
// PTT controller; this module never requests microphone permission itself.
class BifrostSignal {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.graphics = this.canvas.getContext('2d');
    this.state = root.querySelector('[data-signal-state]');
    this.inputMeter = root.querySelector('[data-signal-meter="input"]');
    this.outputMeter = root.querySelector('[data-signal-meter="output"]');
    this.context = null;
    this.inputSource = null;
    this.outputSource = null;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.active = null;
    this.frame = null;
    this.spectrum = null;
    this.samples = null;
    this.pixelRatio = 1;
    this.width = 0;
    this.height = 0;
    this.resize = this.resize.bind(this);
    this.render = this.render.bind(this);

    if ('ResizeObserver' in window) {
      this.observer = new ResizeObserver(this.resize);
      this.observer.observe(this.canvas);
    } else {
      window.addEventListener('resize', this.resize);
    }
    this.resize();
  }

  // Called synchronously from PTT or replay activation, before any awaits.
  prime() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      if (!this.context) this.context = new AudioContextClass();
      if (this.context.state === 'suspended') {
        void this.context.resume().catch(() => {});
      }
    } catch (_) {
      // Audio remains functional if the browser does not support analysis.
    }
  }

  analyser() {
    const node = this.context.createAnalyser();
    node.fftSize = 2048;
    node.smoothingTimeConstant = 0.76;
    node.minDecibels = -95;
    node.maxDecibels = -15;
    return node;
  }

  monitorMicrophone(stream) {
    if (!this.context) return;
    this.stopMicrophone();
    try {
      this.inputSource = this.context.createMediaStreamSource(stream);
      this.inputAnalyser = this.analyser();
      this.inputSource.connect(this.inputAnalyser);
      // Deliberately do NOT route microphone audio to the speakers.
      this.active = 'input';
      this.state.textContent = 'INPUT';
      this.start();
    } catch (_) {
      this.stopMicrophone();
    }
  }

  stopMicrophone() {
    if (this.inputSource) this.inputSource.disconnect();
    if (this.inputAnalyser) this.inputAnalyser.disconnect();
    this.inputSource = null;
    this.inputAnalyser = null;
    this.inputMeter.style.transform = 'scaleX(0)';
    if (this.active === 'input') this.stop();
  }

  // Route through Web Audio only when the context is running. Otherwise leave
  // the HTMLAudioElement untouched so sound always plays normally.
  async monitorPlayback(player) {
    if (!this.context) return;
    this.stopPlayback();
    try {
      if (this.context.state !== 'running') await this.context.resume();
      if (this.context.state !== 'running') return;
      const analyser = this.analyser();
      const source = this.context.createMediaElementSource(player);
      // Establish the audible path first, then attach the passive analyser.
      source.connect(this.context.destination);
      this.outputSource = source;
      this.outputAnalyser = analyser;
      source.connect(analyser);
      this.active = 'output';
      this.state.textContent = 'OUTPUT';
      this.start();
    } catch (_) {
      // The audible connection is left intact if visual analysis fails.
      if (this.outputAnalyser) this.outputAnalyser.disconnect();
      this.outputAnalyser = null;
      this.active = null;
      this.state.textContent = 'STANDBY';
    }
  }

  stopPlayback() {
    if (this.outputSource) this.outputSource.disconnect();
    if (this.outputAnalyser) this.outputAnalyser.disconnect();
    this.outputSource = null;
    this.outputAnalyser = null;
    this.outputMeter.style.transform = 'scaleX(0)';
    if (this.active === 'output') this.stop();
  }

  stop() {
    this.active = null;
    this.state.textContent = 'STANDBY';
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.draw();
  }

  start() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.render);
  }

  resize() {
    if (!this.graphics) return;
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (this.width !== width || this.height !== height || this.pixelRatio !== ratio) {
      this.width = width;
      this.height = height;
      this.pixelRatio = ratio;
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
      this.graphics.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    if (!this.active) this.draw();
  }

  render() {
    this.frame = null;
    const analyser = this.active === 'input' ? this.inputAnalyser : this.outputAnalyser;
    if (!analyser) return this.stop();

    if (!this.spectrum || this.spectrum.length !== analyser.frequencyBinCount) {
      this.spectrum = new Uint8Array(analyser.frequencyBinCount);
      this.samples = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteFrequencyData(this.spectrum);
    analyser.getByteTimeDomainData(this.samples);
    let squares = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const value = (this.samples[i] - 128) / 128;
      squares += value * value;
    }
    const rms = Math.sqrt(squares / this.samples.length);
    const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 0.0001)) + 60) / 60));
    const meter = this.active === 'input' ? this.inputMeter : this.outputMeter;
    meter.style.transform = `scaleX(${level.toFixed(3)})`;
    this.draw(analyser);
    this.frame = requestAnimationFrame(this.render);
  }

  draw(analyser = null) {
    const ctx = this.graphics;
    if (!ctx || !this.width || !this.height) return;
    const width = this.width;
    const height = this.height;
    const left = 15;
    const right = width - 15;
    const top = 14;
    const bottom = height - 26;
    const range = bottom - top;
    ctx.clearRect(0, 0, width, height);

    // Discreet frequency grid, shared by active and standby views.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(225,225,231,0.085)';
    for (let i = 0; i <= 4; i++) {
      const y = top + range * i / 4;
      ctx.beginPath();
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(right, y + 0.5);
      ctx.stroke();
    }
    const xAt = (hz) => left + Math.log(hz / 50) / Math.log(16000 / 50) * (right - left);
    const marks = [[80, '80'], [250, '250'], [1000, '1k'], [4000, '4k'], [12000, '12k']];
    ctx.fillStyle = 'rgba(230,230,237,0.5)';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    for (const [hz, label] of marks) {
      const x = xAt(hz);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, top);
      ctx.lineTo(x + 0.5, bottom);
      ctx.stroke();
      ctx.fillText(label, x, height - 8);
    }
    if (!analyser || !this.spectrum) return;

    const points = [];
    const nyquist = this.context.sampleRate / 2;
    const count = Math.max(72, Math.min(220, Math.round(width / 2.5)));
    for (let i = 0; i <= count; i++) {
      const hz = 50 * Math.pow(16000 / 50, i / count);
      const bin = Math.min(this.spectrum.length - 1, hz / nyquist * (this.spectrum.length - 1));
      const a = Math.floor(bin);
      const b = Math.min(a + 1, this.spectrum.length - 1);
      const magnitude = (this.spectrum[a] * (1 - (bin - a)) + this.spectrum[b] * (bin - a)) / 255;
      const strength = Math.max(0, Math.min(1, (magnitude - 0.10) / 0.9));
      points.push([left + (right - left) * i / count, bottom - strength * range * 0.94]);
    }
    ctx.beginPath();
    ctx.moveTo(points[0][0], bottom);
    for (const point of points) ctx.lineTo(point[0], point[1]);
    ctx.lineTo(right, bottom);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, 'rgba(179,168,197,0.32)');
    gradient.addColorStop(1, 'rgba(179,168,197,0.025)');
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = '#d4c8e5';
    ctx.lineWidth = 1.65;
    ctx.stroke();
  }
}

window.BifrostSignal = BifrostSignal;
