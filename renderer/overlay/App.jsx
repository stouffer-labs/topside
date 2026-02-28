import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, Fragment } from 'react';
import TopsideIcon from '../shared/TopsideIcon';
import Markdown from '../shared/Markdown';

// Audio capture state (outside React to persist across renders)
let audioContext = null;
let workletReady = false;
let workletNode = null;
let sourceNode = null;
let gainNode = null;
let mediaStream = null;
let micLevelCallback = null;

function logToMain(msg) {
  window.electronAPI?.logFromRenderer(msg);
}

function playTone(frequency, duration, type = 'sine', volume = 0.15) {
  if (!audioContext) return;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + duration);
}

function playStartSound() {
  if (!audioContext) return;
  playTone(600, 0.08);
  setTimeout(() => playTone(900, 0.1), 80);
}


async function ensureAudioReady() {
  if (!audioContext) {
    // Use the hardware's native sample rate — forcing a specific rate (e.g. 48kHz)
    // can cause CoreAudio to reconfigure the audio subsystem and distort output
    // from other apps (Apple Music, etc.), especially with Bluetooth devices.
    audioContext = new AudioContext();
    logToMain(`AudioContext created (hardware rate: ${audioContext.sampleRate} Hz)`);
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  if (!workletReady) {
    await audioContext.audioWorklet.addModule('../audio-worklet.js');
    workletReady = true;
    logToMain('AudioWorklet loaded (persistent)');
  }
  // Validate existing stream is still alive (catches device sleep, disconnect, driver recycle)
  if (mediaStream) {
    const track = mediaStream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live' || !mediaStream.active) {
      logToMain(`Mic stream stale (track: ${track?.readyState || 'missing'}, active: ${mediaStream.active}) — refreshing`);
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
  }
  if (!mediaStream) {
    const savedDevice = await window.electronAPI?.config.get('audio.inputDevice');
    const savedLabel = await window.electronAPI?.config.get('audio.inputDeviceLabel');
    const audioConstraints = {
      channelCount: 1,
      // Don't force sampleRate — let the mic use its native rate.
      // The worklet resamples to 16kHz regardless of input rate.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    // Validate saved device ID still maps to the expected device
    let useDeviceId = savedDevice;
    if (savedDevice && savedDevice !== 'default') {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        logToMain(`Available audio inputs: ${audioInputs.map(d => `"${d.label}" (${d.deviceId.slice(0,8)}...)`).join(', ')}`);
        const matched = audioInputs.find(d => d.deviceId === savedDevice);
        if (matched) {
          logToMain(`Saved device ID matches: "${matched.label}"`);
          // Verify label if we have one saved
          if (savedLabel && matched.label && !matched.label.includes(savedLabel)) {
            logToMain(`Device ID mapped to "${matched.label}" but expected "${savedLabel}" — searching by label`);
            const byLabel = audioInputs.find(d => d.label && d.label.includes(savedLabel));
            if (byLabel) {
              useDeviceId = byLabel.deviceId;
              logToMain(`Found "${savedLabel}" at new device ID, using that instead`);
            } else {
              logToMain(`"${savedLabel}" not found, falling back to default`);
              useDeviceId = null;
            }
          }
        } else {
          logToMain(`Saved device ID (${savedDevice.slice(0,8)}...) not found in current devices, falling back to default`);
          useDeviceId = null;
        }
      } catch (err) {
        logToMain(`Device enumeration failed: ${err.message}`);
      }
    }

    if (useDeviceId && useDeviceId !== 'default') {
      audioConstraints.deviceId = { exact: useDeviceId };
    }
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    const track = mediaStream.getAudioTracks()[0];
    logToMain(`Mic stream acquired (device: ${track?.label || 'unknown'}, rate: ${track?.getSettings?.()?.sampleRate || 'unknown'} Hz)`);
    // Auto-invalidate if the track dies (device disconnect, driver recycle, OS sleep)
    if (track) {
      track.addEventListener('ended', () => {
        logToMain('Mic track ended — will refresh on next session');
        mediaStream = null;
      });
    }
  }
}

function connectAudioPipeline(gain = 4.0) {
  if (!audioContext || !mediaStream) {
    logToMain('Audio pipeline not ready — mic stream missing');
    return;
  }

  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  gainNode = audioContext.createGain();
  gainNode.gain.value = gain;

  workletNode = new AudioWorkletNode(audioContext, 'pcm-extractor');
  workletNode.port.postMessage({ type: 'init', sampleRate: audioContext.sampleRate });

  let chunkCount = 0;
  workletNode.port.onmessage = (event) => {
    if (event.data.type === 'pcm') {
      const samples = new Float32Array(event.data.samples);
      const int16 = new Int16Array(samples.length);

      // Calculate RMS for mic level meter
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        int16[i] = Math.round(s * 32767);
        sumSq += s * s;
      }

      // Convert RMS to dB scale, map -60dB..0dB → 0..1
      if (micLevelCallback && samples.length > 0) {
        const rms = Math.sqrt(sumSq / samples.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -60;
        const level = Math.max(0, Math.min(1, (db + 60) / 60));
        micLevelCallback(level);
      }

      chunkCount++;
      if (chunkCount === 1) logToMain('First audio chunk sent');
      window.electronAPI?.sendAudioChunk(int16.buffer);
    }
  };

  sourceNode.connect(gainNode);
  gainNode.connect(workletNode);
  logToMain(`Audio pipeline connected (gain: ${gain}x)`);
}

function destroyAudio() {
  disconnectAudioPipeline();
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  workletReady = false;
}

window.addEventListener('beforeunload', destroyAudio);

function disconnectAudioPipeline() {
  micLevelCallback = null;
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (gainNode) {
    gainNode.disconnect();
    gainNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
}

export default function App() {
  const [messages, setMessages] = useState([]);          // conversation history
  const [isRecording, setIsRecording] = useState(false);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [streamingAiText, setStreamingAiText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [cpuUsage, setCpuUsage] = useState(0);
  const [memMB, setMemMB] = useState(0);
  const [visible, setVisible] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const [autoCopied, setAutoCopied] = useState(false);
  const [error, setError] = useState(null);
  const [screenshot, setScreenshot] = useState(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [baseFontSize, setBaseFontSize] = useState(13);
  const [silenceWarning, setSilenceWarning] = useState(false);
  const [chatText, setChatText] = useState('');
  const conversationRef = useRef(null);
  const containerRef = useRef(null);
  const micMeterRef = useRef(null);
  const silenceTimer = useRef(null);
  const chatInputRef = useRef(null);
  const audioGainRef = useRef(4.0);

  // Load overlay settings on mount.
  // NOTE: mic stream is NOT pre-warmed here — deferring AudioContext creation
  // and getUserMedia until first recording prevents the app from disrupting
  // system audio (CoreAudio sample rate reconfiguration on Bluetooth devices).
  useEffect(() => {
    // Load overlay settings
    window.electronAPI?.config.get('overlay.soundEffects').then(val => {
      if (val === false) setSoundEnabled(false);
    });
    window.electronAPI?.config.get('overlay.fontSize').then(val => {
      if (val) setBaseFontSize(val);
    });
    window.electronAPI?.config.get('audio.gain').then(val => {
      if (val) audioGainRef.current = val;
    });
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const cleanups = [];

    cleanups.push(api.on('overlay:show', async () => {
      setVisible(true);
      setMessages([]);
      setIsRecording(true);
      setCurrentTranscript('');
      setStreamingAiText('');
      setThinking(false);
      setMicLevel(0);
      setHasFocus(false);
      setAutoCopied(false);
      setError(null);
      setScreenshot(null);
      setSilenceWarning(false);

      setChatText('');
      if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
      micLevelCallback = (level) => {
        setMicLevel(level);
        if (micMeterRef.current) {
          micMeterRef.current.style.transform = `scaleX(${level})`;
        }
        // Silence detection
        if (level < 0.02) {
          if (!silenceTimer.current) {
            silenceTimer.current = setTimeout(() => setSilenceWarning(true), 5000);
          }
        } else {
          if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
          setSilenceWarning(false);
        }
      };
      // Re-validate mic stream (catches stale streams after device sleep/disconnect)
      await ensureAudioReady();
      connectAudioPipeline(audioGainRef.current);
      // Delay beep so the worklet processes at least one chunk before the user starts speaking
      setTimeout(() => { if (soundEnabled) playStartSound(); }, 200);
    }));

    cleanups.push(api.on('overlay:screenshot', (base64) => {
      setScreenshot(base64);
    }));

    cleanups.push(api.on('overlay:hide', () => {
      disconnectAudioPipeline();
      setVisible(false);
      setIsRecording(false);
      setScreenshot(null);
      setSilenceWarning(false);
      
      setChatText('');
      if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    }));

    cleanups.push(api.on('overlay:update-transcription', (text) => {
      setCurrentTranscript(text);
    }));

    cleanups.push(api.on('overlay:round-complete', ({ content, buttons }) => {
      // User message was already added by overlay:button-thinking
      setMessages(prev => [...prev, { role: 'assistant', content, buttons }]);
      setIsRecording(false);
      setCurrentTranscript('');
      setStreamingAiText('');
      setThinking(false);
      disconnectAudioPipeline();
    }));

    cleanups.push(api.on('overlay:new-round', () => {
      setIsRecording(true);
      setCurrentTranscript('');
      setStreamingAiText('');
      setThinking(false);
      setSilenceWarning(false);
      if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
      micLevelCallback = (level) => {
        setMicLevel(level);
        if (micMeterRef.current) {
          micMeterRef.current.style.transform = `scaleX(${level})`;
        }
        // Silence detection
        if (level < 0.02) {
          if (!silenceTimer.current) {
            silenceTimer.current = setTimeout(() => setSilenceWarning(true), 5000);
          }
        } else {
          if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
          setSilenceWarning(false);
        }
      };
      connectAudioPipeline();
      setTimeout(() => { if (soundEnabled) playStartSound(); }, 200);
    }));

    cleanups.push(api.on('overlay:finalizing', () => {
      // F10 pressed to stop recording — immediately switch UI to thinking
      setIsRecording(false);
      setThinking(true);
      disconnectAudioPipeline();
    }));

    cleanups.push(api.on('overlay:button-thinking', (label) => {
      // Add the label as a user message and show thinking state.
      // Also cleans up recording state — harmless when already not recording
      // (button clicks), essential when transitioning from recording to AI processing.
      setMessages(prev => [...prev, { role: 'user', content: label }]);
      setIsRecording(false);
      setCurrentTranscript('');
      setThinking(true);
      setStreamingAiText('');
      disconnectAudioPipeline();
    }));

    cleanups.push(api.on('overlay:stream-chunk', (chunk) => {
      setStreamingAiText(chunk);
      setThinking(false);
    }));

    cleanups.push(api.on('overlay:mic-level', (level) => {
      setMicLevel(level);
    }));

    cleanups.push(api.on('overlay:resource-stats', ({ cpu, memMB: mem }) => {
      setCpuUsage(cpu);
      setMemMB(mem);
    }));

    cleanups.push(api.on('overlay:error', ({ title, detail, actions }) => {
      setError({ title, detail, actions: actions || [] });
      setIsRecording(false);
      disconnectAudioPipeline();
    }));

    cleanups.push(api.on('overlay:auto-copied', () => {
      setAutoCopied(true);
      setTimeout(() => setAutoCopied(false), 2000);
    }));

    cleanups.push(api.on('overlay:cancel', () => {
      disconnectAudioPipeline();
      setIsRecording(false);
      setTimeout(() => setVisible(false), 300);
    }));

    return () => {
      disconnectAudioPipeline();
      cleanups.forEach(fn => fn && fn());
    };
  }, []);

  // Auto-scroll conversation to keep latest content visible.
  // During thinking (no AI text yet), pin to top so the user's question stays visible.
  // For streaming / completed responses, delay briefly so the resize IPC can grow the
  // window first, then scroll to bottom to keep buttons and chat input in view.
  useEffect(() => {
    if (!conversationRef.current || isRecording) return;
    if (thinking && !streamingAiText) {
      // First round: pin to top so user's question stays visible.
      // Follow-up rounds: scroll to bottom so the thinking hero is visible.
      const el = conversationRef.current;
      el.scrollTop = messages.length <= 1 ? 0 : el.scrollHeight;
      return;
    }
    const timer = setTimeout(() => {
      const el = conversationRef.current;
      if (el && el.scrollHeight > el.clientHeight + 4) {
        el.scrollTop = el.scrollHeight;
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [messages, streamingAiText, thinking, isRecording]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!visible || isRecording) return;
    const handleKeyDown = (e) => {
      // Don't intercept keys when chat input is focused
      if (chatInputRef.current === document.activeElement) {
        if (e.key === 'Escape') {
          e.preventDefault();
          chatInputRef.current.blur();
          setChatText('');
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handleAction('close');
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'c' && !window.getSelection()?.toString()) {
        e.preventDefault();
        handleAction('copy');
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleAction('breakout');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [visible, isRecording]);

  // Dynamic overlay resize — useLayoutEffect measures after DOM update but before paint,
  // so the window expands before the user ever sees clipped content.
  useLayoutEffect(() => {
    if (!containerRef.current || !visible) return;
    let desiredHeight = 0;
    for (const child of containerRef.current.children) {
      desiredHeight += child.scrollHeight;
    }
    desiredHeight += 24; // account for borders, rounding, breathing room
    if (desiredHeight > 0) {
      window.electronAPI?.resizeOverlay(Math.ceil(desiredHeight));
    }
  }, [visible, messages, streamingAiText, currentTranscript, thinking, isRecording, screenshot]);

  const handleButtonClick = (label) => {
    window.electronAPI?.buttonClick(label);
  };

  const handleChatSubmit = () => {
    const text = chatText.trim();
    if (!text) return;
    window.electronAPI?.buttonClick(text);
    
    setChatText('');
  };

  const handleAction = (action) => {
    window.electronAPI?.sessionAction(action);
  };

  const handleContainerClick = () => {
    if (!hasFocus) {
      window.electronAPI?.requestFocus();
      setHasFocus(true);
    }
  };

  if (!visible) return null;

  return (
    <div className="overlay-container slide-in-from-bottom" ref={containerRef} onClick={handleContainerClick} style={{ fontSize: baseFontSize + 'px' }}>
      <div className="overlay-drag-handle" />
      {/* Conversation area — stable layout:
           transcript/user msg (top-left) → screenshot (after first user msg) → hero (centered) → AI content.
           Transcript is always the first element so it never shifts position. */}
      <div className="conversation-area" ref={conversationRef}>

        {/* ── Live transcript (top-left, always first) ── */}
        {currentTranscript && (
          <div className="conv-user conv-active">
            <div className="conv-icon">{'\u{1F3A4}'}</div>
            <div className="conv-content">
              <div className="conv-text text-text-secondary">{currentTranscript}</div>
            </div>
          </div>
        )}

        {/* ── Finalized messages (top-left, same position as transcript) ── */}
        {messages.filter(m => typeof m === 'object' && m.role).map((msg, i) => (
          <Fragment key={i}>
            <div className={`conv-${msg.role}`}>
              <div className="conv-icon">
                {msg.role === 'user' ? '\u{1F3A4}' : '\u2726'}
              </div>
              <div className="conv-content">
                <div className="conv-text"><Markdown text={msg.content} /></div>
                {msg.role === 'assistant' && msg.buttons?.length > 0 && (
                  <div className="conv-buttons">
                    {msg.buttons.map((btn, j) => (
                      <button
                        key={j}
                        className="ai-button"
                        onClick={(e) => { e.stopPropagation(); handleButtonClick(btn); }}
                      >
                        {btn}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* Screenshot context — show after first user message, before AI response */}
            {i === 0 && msg.role === 'user' && screenshot && (
              <div className="screenshot-thumb" onClick={() => window.electronAPI?.openScreenshotPreview()}>
                <img src={`data:image/jpeg;base64,${screenshot}`} alt="Captured context" />
                <span className="screenshot-thumb-label">Context</span>
              </div>
            )}
          </Fragment>
        ))}

        {/* ── State hero (centered, below transcript/messages) ── */}
        {isRecording && (
          <div className="recording-hero">
            <div className="recording-mic-ring">
              <span className="recording-mic-icon">{'\u{1F3A4}'}</span>
            </div>
            <div className="recording-hint">
              {currentTranscript ? 'Recording...' : 'Listening \u2014 press hotkey again to send'}
            </div>
          </div>
        )}

        {!isRecording && thinking && !streamingAiText && (
          <div className="thinking-hero">
            <div className="thinking-ring">
              <span className="thinking-icon">{'\u2726'}</span>
            </div>
            <div className="thinking-hint">Thinking...</div>
          </div>
        )}

        {/* ── AI streaming ── */}
        {!isRecording && streamingAiText && (
          <div className="conv-assistant conv-active">
            <div className="conv-icon ai-refining">{'\u2726'}</div>
            <div className="conv-content">
              <div className="conv-text"><Markdown text={streamingAiText} /></div>
            </div>
          </div>
        )}

        {/* Chat text input — shows after AI responds, when not recording/thinking */}
        {!isRecording && !thinking && !streamingAiText && messages.length > 0 && !error && (
          <div className="chat-input-area">
            <div className="chat-input-row">
              <input
                ref={chatInputRef}
                className="chat-input"
                type="text"
                value={chatText}
                onChange={e => setChatText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleChatSubmit();
                  }
                  e.stopPropagation();
                }}
                placeholder="Type a follow-up..."
              />
              <button
                className="chat-send-btn"
                onClick={(e) => { e.stopPropagation(); handleChatSubmit(); }}
                disabled={!chatText.trim()}
              >
                {'\u2191'}
              </button>
            </div>
          </div>
        )}

      </div>

      {/* Error banner */}
      {error && (
        <div className="overlay-error">
          <div className="overlay-error-text">
            <span className="overlay-error-title">{error.title}</span>
            <span className="overlay-error-detail">{error.detail}</span>
          </div>
          {error.actions?.length > 0 && (
            <div className="overlay-error-actions">
              {error.actions.map((action) => (
                <button
                  key={action}
                  className="btn btn-sm overlay-error-btn"
                  onClick={(e) => { e.stopPropagation(); handleButtonClick(action); }}
                >
                  {action}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Status bar */}
      <div className="overlay-status">
        <div className="status-left">
          <TopsideIcon size={14} color="#6366f1" />
          {isRecording && (
            <>
              <span className="status-dot bg-red-500 animate-pulse" />
              <span className="text-text-secondary text-small">Rec</span>
              <div className="mic-meter">
                <div className="mic-meter-fill" ref={micMeterRef} style={{ transform: `scaleX(${micLevel})` }} />
              </div>
              {silenceWarning && <span className="silence-warning">No mic input</span>}
            </>
          )}
          {!isRecording && (thinking || streamingAiText) && (
            <>
              <span className="status-dot bg-purple-500 animate-pulse" />
              <span className="text-text-secondary text-small">Thinking</span>
            </>
          )}
          {!isRecording && !thinking && !streamingAiText && messages.length > 0 && !error && (
            <>
              <span className="status-dot bg-green-500" />
              <span className="text-text-secondary text-small">
                {autoCopied ? 'Copied to clipboard' : 'Ready'}
              </span>
            </>
          )}
          <span className={`stat-badge${isRecording ? ' stat-dimmed' : ''}`}>CPU {cpuUsage}%</span>
          <span className={`stat-badge${isRecording ? ' stat-dimmed' : ''}`}>{memMB}MB</span>
        </div>
        <div className="toolbar-actions">
          <button className="toolbar-btn" onClick={(e) => { e.stopPropagation(); handleAction('copy'); }} title="Copy response">
            Copy
          </button>
          <button className="toolbar-btn toolbar-btn-breakout" onClick={(e) => { e.stopPropagation(); handleAction('breakout'); }} title="Open in terminal">
            {'\u2934'}
          </button>
          <button className="toolbar-btn toolbar-btn-close" onClick={(e) => { e.stopPropagation(); handleAction('close'); }} title="Close">
            {'\u2715'}
          </button>
        </div>
      </div>
    </div>
  );
}
