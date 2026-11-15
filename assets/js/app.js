'use strict';

const el = (id) => document.getElementById(id);
const ptt = el('ptt');
const stateText = el('state');
const hint = el('hint');
const panel = document.querySelector('.radio-screen');
const messages = el('messages');
const testText = el('test-text');
const replayButton = el('replay');
const signal = window.BifrostSignal ? new window.BifrostSignal(document.querySelector('.signal-panel')) : null;

let phase = 'starting';
let pressed = false;
let token = null;
let micStream = null;
let recorder = null;
let chunks = [];
let timer = null;
let maxSeconds = 20;
let mode = 'mock';
let lastResponse = null;
let activeInput = null;
let recordingStartedAt = null;
let spaceHeld = false;

function setMetric(id, value) {
  el(id).textContent = value == null || value === '' ? 'Not reported' : String(value);
}

function milliseconds(value) {
  return Number.isFinite(value) ? `${Math.round(value).toLocaleString()} ms` : null;
}

function seconds(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : null;
}

function bytes(value) {
  if (!Number.isFinite(value)) return null;
  return value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(2)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
}

function updateConfiguration(status) {
  const models = status.models || {};
  const live = status.mode === 'live';
  for (const [field, id] of [
    ['transcription', 'model-transcription'],
    ['response', 'model-response'],
    ['speech', 'model-speech'],
  ]) {
    setMetric(id, models[field] || (live ? 'Not reported' : 'Inactive / mock'));
  }
  setMetric('model-voice', models.voice || (live ? 'Not reported' : 'inactive'));
  setMetric('system-api', live ? 'OPENAI' : 'SIMULATED');
  setMetric('max-ptt', Number.isFinite(status.max_record_seconds) ? `${status.max_record_seconds} s` : null);
  setMetric('max-upload', Number.isFinite(status.limits?.max_audio_bytes) ? bytes(status.limits.max_audio_bytes) : null);
  setMetric('system-mode', live ? 'OPENAI · LIVE' : 'OFFLINE · MOCK');
  document.querySelectorAll('.stage').forEach((stage) => stage.classList.toggle('inactive', !live));
}

function updateTelemetry(reply, input, roundTripMs) {
  const data = reply.telemetry || {};
  const tokens = data.tokens || {};
  const output = data.output_audio || {};
  const typed = input?.kind === 'text';
  setMetric('telemetry-state', 'LAST EXCHANGE · COMPLETE');
  setMetric('metric-api', milliseconds(data.api_total_ms) || (mode === 'mock' ? 'SIMULATED' : 'Not reported'));
  setMetric('metric-stt', typed ? 'Bypassed / typed' : (milliseconds(data.transcription_ms) || (mode === 'mock' ? 'Not active' : null)));
  setMetric('metric-llm', milliseconds(data.inference_ms) || (mode === 'mock' ? 'Not active' : null));
  setMetric('metric-tts', milliseconds(data.synthesis_ms) || (mode === 'mock' ? 'Browser TTS' : null));
  setMetric('metric-server', milliseconds(data.server_ms));
  setMetric('metric-roundtrip', milliseconds(roundTripMs));

  setMetric('rx-transport', typed ? 'TEXT' : 'MICROPHONE');
  setMetric('rx-subtitle', typed ? 'Typed test · no recording' : 'MediaRecorder upload');
  setMetric('rx-format', typed ? 'Plain text' : (data.input_mime || input?.mime));
  setMetric('rx-duration', typed ? 'N/A' : seconds(input?.durationMs));
  setMetric('rx-size', typed ? 'N/A' : bytes(data.input_bytes ?? input?.size));
  setMetric('rx-rate', typed ? 'N/A' : (input?.sampleRate ? `${input.sampleRate.toLocaleString()} Hz` : null));
  setMetric('rx-channels', typed ? 'N/A' : input?.channels);

  setMetric('tx-format', reply.audio_mime || 'Browser TTS');
  setMetric('tx-duration', seconds(output.duration_ms));
  setMetric('tx-size', bytes(data.output_bytes));
  setMetric('tx-rate', output.sample_rate_hz ? `${output.sample_rate_hz.toLocaleString()} Hz` : null);
  setMetric('tx-channels', output.channels);

  setMetric('tokens-input', tokens.input);
  setMetric('tokens-output', tokens.output);
  setMetric('tokens-total', tokens.total);
}

function display(phaseName, label, description) {
  phase = phaseName;
  document.body.dataset.phase = phaseName;
  const captureLabels = {receiving: 'RECORDING', arming: 'PREPARING'};
  const transferLabels = {receiving: 'HELD LOCALLY', sending: 'UPLOADING', processing: 'API REQUEST', transmitting: 'RESPONSE RECEIVED'};
  el('mic-state').textContent = captureLabels[phaseName] || 'NOT RECORDING';
  el('transfer-state').textContent = transferLabels[phaseName] || 'NOT SENT';
  stateText.textContent = label;
  hint.textContent = description;
  ptt.classList.toggle('pressed', phaseName === 'receiving');
  ptt.setAttribute('aria-pressed', String(phaseName === 'receiving'));
  panel.classList.toggle('active', ['receiving', 'processing', 'transmitting'].includes(phaseName));
  panel.classList.toggle('rx', phaseName === 'receiving');
  panel.classList.toggle('tx', phaseName === 'transmitting');
  el('live-indicator').textContent = phaseName === 'idle' ? 'STANDBY' : phaseName.toUpperCase();
  // The PTT button must remain enabled during reception to receive pointer-up.
  ptt.disabled = ['starting', 'processing', 'transmitting', 'sending'].includes(phaseName);
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `Server error ${response.status}`);
  return data;
}

function jsonPost(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function stopMicrophone() {
  signal?.stopMicrophone();
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  micStream = null;
  recorder = null;
  chunks = [];
  if (timer) clearTimeout(timer);
  timer = null;
}

async function releaseServerSession() {
  const currentToken = token;
  token = null;
  if (!currentToken) return;
  try {
    await jsonPost('/api/rx/cancel', { token: currentToken });
  } catch (_) {
    // The session might already have expired or been completed.
  }
}

function finishIdle(message = 'Channel clear. Ready for another transmission.') {
  pressed = false;
  stopMicrophone();
  display('idle', 'STANDBY', message);
  ptt.disabled = false;
}

function mimeOption() {
  if (!window.MediaRecorder) throw new Error('This browser cannot record audio. Use typed test mode.');
  const formats = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  return formats.find((format) => MediaRecorder.isTypeSupported(format));
}

function filenameFor(mime) {
  if (mime.includes('mp4')) return 'ptt.mp4';
  if (mime.includes('ogg')) return 'ptt.ogg';
  return 'ptt.webm';
}

async function beginTalk() {
  if (phase !== 'idle') return;
  pressed = true;
  signal?.prime();
  display('arming', 'PREPARING', 'Opening the virtual radio channel');
  const typedMode = Boolean(testText.value.trim());
  activeInput = typedMode ? { kind: 'text' } : null;
  recordingStartedAt = null;

  try {
    if (!typedMode) {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access requires localhost or HTTPS.');
      }
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const settings = micStream.getAudioTracks()[0]?.getSettings?.() || {};
      activeInput = { kind: 'audio', sampleRate: settings.sampleRate || null, channels: settings.channelCount || null };
      if (!pressed) { finishIdle(); return; }
      const mime = mimeOption();
      recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
      chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const capturedMime = recorder?.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunks, { type: capturedMime });
        if (activeInput) {
          activeInput.mime = capturedMime;
          activeInput.size = blob.size;
        }
        stopMicrophone();
        if (phase === 'sending') void sendTurn(blob, capturedMime);
      };
    }

    // Do not seize the radio channel while waiting for microphone permissions.
    if (!pressed) { finishIdle(); return; }
    const session = await request('/api/rx/start', { method: 'POST' });
    token = session.token;
    if (!pressed) {
      await releaseServerSession();
      finishIdle();
      return;
    }
    if (recorder) {
      recorder.start();
      signal?.monitorMicrophone(micStream);
      recordingStartedAt = performance.now();
    }
    display('receiving', 'RECEIVING', typedMode ? 'Text test: release PTT to send' : 'Listening. Release PTT to send');
    timer = setTimeout(() => void endTalk(), maxSeconds * 1000);
  } catch (err) {
    await releaseServerSession();
    finishIdle(`Cannot start: ${err.message}`);
  }
}

function endTalk() {
  pressed = false;
  if (phase !== 'receiving') return;
  display('sending', 'UPLOADING', 'Sending the received message to the voice controller');
  if (timer) clearTimeout(timer);
  timer = null;
  if (recorder && recorder.state === 'recording') {
    if (activeInput && recordingStartedAt !== null) activeInput.durationMs = performance.now() - recordingStartedAt;
    recorder.stop();
  } else {
    stopMicrophone();
    void sendTurn(null, null);
  }
}

function addMessage(sender, text) {
  const empty = messages.querySelector('.empty');
  if (empty) empty.remove();
  const wrapper = document.createElement('div');
  wrapper.className = `message ${sender}`;
  const caption = document.createElement('div');
  caption.className = 'message-label';
  caption.textContent = sender === 'user' ? 'RECEIVED' : 'AI TRANSMISSION';
  const bubble = document.createElement('p');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrapper.append(caption, bubble);
  messages.append(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

function speakLocal(text) {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) {
      reject(new Error('Local text-to-speech is unavailable in this browser'));
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.97;
    utterance.onend = resolve;
    utterance.onerror = () => reject(new Error('Local speech playback failed'));
    speechSynthesis.speak(utterance);
  });
}

async function playAudio(src) {
  const player = new Audio(src);
  signal?.prime();
  await signal?.monitorPlayback(player);
  return new Promise((resolve, reject) => {
    player.onended = () => { signal?.stopPlayback(); resolve(); };
    player.onerror = () => { signal?.stopPlayback(); reject(new Error('Audio playback failed')); };
    player.play().catch(() => {
      signal?.stopPlayback();
      reject(new Error('Autoplay was blocked'));
    });
  });
}

function playReply(replyData) {
  if (replyData.audio_base64) {
    const src = `data:${replyData.audio_mime || 'audio/wav'};base64,${replyData.audio_base64}`;
    return playAudio(src);
  }
  return speakLocal(replyData.reply);
}

async function sendTurn(blob, mime) {
  const currentToken = token;
  if (!currentToken) { finishIdle('The radio session expired. Try again.'); return; }
  display('processing', 'PROCESSING', mode === 'mock' ? 'Generating simulated radio response' : 'Transcribing, reasoning, then synthesising speech');
  const turnInput = activeInput;
  try {
    const form = new FormData();
    form.append('token', currentToken);
    form.append('text', testText.value.trim());
    if (blob?.size) form.append('audio', blob, filenameFor(mime || blob.type));
    const requestStartedAt = performance.now();
    const replyData = await request('/api/rx/finish', { method: 'POST', body: form });
    updateTelemetry(replyData, turnInput, performance.now() - requestStartedAt);
    token = currentToken;
    addMessage('user', replyData.transcript);
    addMessage('assistant', replyData.reply);
    lastResponse = replyData;
    replayButton.hidden = false;
    testText.value = '';

    display('transmitting', 'TRANSMITTING', 'Playing the AI response on the virtual channel');
    try {
      await playReply(replyData);
    } catch (error) {
      hint.textContent = `${error.message}. Use Replay response to listen.`;
    } finally {
      try {
        await jsonPost('/api/tx/complete', { token: currentToken });
      } catch (_) {
        // Timeouts may release the simulator before playback finishes.
      }
      token = null;
    }
    finishIdle();
  } catch (err) {
    await releaseServerSession();
    finishIdle(`Transmission failed: ${err.message}`);
  }
}

ptt.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || phase !== 'idle') return;
  event.preventDefault();
  ptt.setPointerCapture(event.pointerId);
  void beginTalk();
});
ptt.addEventListener('pointerup', (event) => {
  event.preventDefault();
  endTalk();
});
ptt.addEventListener('pointercancel', endTalk);
window.addEventListener('blur', endTalk);
// Space is an operator control on this page. Prevent default scrolling on
// every keydown, including auto-repeat. Keep normal typing in editable fields.
function isEditableTarget(target) {
  return target instanceof Element && Boolean(target.closest('textarea, input, select, [contenteditable="true"]'));
}
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (isEditableTarget(event.target) && !spaceHeld) return;
  event.preventDefault();
  if (event.repeat || spaceHeld) return;
  spaceHeld = true;
  if (phase === 'idle') void beginTalk();
});
window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space') return;
  if (isEditableTarget(event.target) && !spaceHeld) return;
  event.preventDefault();
  if (!spaceHeld) return;
  spaceHeld = false;
  endTalk();
});
window.addEventListener('blur', () => { spaceHeld = false; });

replayButton.addEventListener('click', async () => {
  if (!lastResponse || phase !== 'idle') return;
  try { await playReply(lastResponse); }
  catch (err) { hint.textContent = `Playback failed: ${err.message}`; }
});

async function initialise() {
  try {
    const status = await request('/api/status');
    mode = status.mode;
    maxSeconds = status.max_record_seconds;
    updateConfiguration(status);
    el('mode').textContent = mode === 'mock' ? 'SIMULATION' : 'OPENAI LIVE';
    el('test-note').textContent = mode === 'mock'
      ? 'Mock mode does not transcribe speech. Use text for a complete simulated exchange.'
      : 'Typed tests bypass transcription. Voice uses OpenAI.';
    el('footer-mode').textContent = mode === 'mock' ? 'No external API calls' : 'OpenAI API · RF disconnected';
    finishIdle('Channel clear. Hold PTT to speak.');
  } catch (err) {
    display('starting', 'OFFLINE', `Cannot connect to local server: ${err.message}`);
    ptt.disabled = true;
  }
}

void initialise();
