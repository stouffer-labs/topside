import { useState, useEffect, useCallback, useRef } from 'react';
import TopsideIcon from '../shared/TopsideIcon';

function playRegisteredSound() {
  try {
    const ctx = new AudioContext();
    const play = (freq, time, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(time);
      osc.stop(time + dur);
    };
    const now = ctx.currentTime;
    play(523, now, 0.08);        // C5
    play(659, now + 0.08, 0.08); // E5
    play(784, now + 0.16, 0.12); // G5
    setTimeout(() => ctx.close(), 500);
  } catch (_) {}
}

const OVERLAY_POSITIONS = [
  { value: 'bottom-center', label: 'Bottom Center' },
  { value: 'bottom-right', label: 'Bottom Right' },
  { value: 'top-center', label: 'Top Center' },
];

// ─── Secret Input ────────────────────────────────────────────────────────────────

function SecretInput({ secretKey, placeholder, onChange, providerType, providerId }) {
  const [value, setValue] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [hasValue, setHasValue] = useState(false);
  const [validationState, setValidationState] = useState(null); // null | 'checking' | 'valid' | 'invalid'
  const [validationReason, setValidationReason] = useState('');

  useEffect(() => {
    window.electronAPI.secrets.has(secretKey).then(has => {
      setHasValue(has);
      if (has) {
        window.electronAPI.secrets.get(secretKey).then(v => {
          setValue(v || '');
          setLoaded(true);
          // Auto-validate existing keys on load
          if (v && providerType && providerId) {
            runValidation();
          }
        });
      } else {
        setLoaded(true);
      }
    });
  }, [secretKey]);

  const runValidation = useCallback(() => {
    if (!providerType || !providerId) return;
    setValidationState('checking');
    window.electronAPI.providers.validate(providerType, providerId).then(result => {
      setValidationState(result.valid === true ? 'valid' : result.valid === false ? 'invalid' : null);
      setValidationReason(result.reason || '');
    }).catch(() => {
      setValidationState(null);
      setValidationReason('');
    });
  }, [providerType, providerId]);

  const validateTimeout = useRef(null);

  const handleChange = (e) => {
    const v = e.target.value;
    setValue(v);
    if (v) {
      window.electronAPI.secrets.set(secretKey, v);
      setHasValue(true);
    } else {
      window.electronAPI.secrets.delete(secretKey);
      setHasValue(false);
      setValidationState(null);
      setValidationReason('');
    }
    if (onChange) onChange(v);

    // Debounced validation after typing
    if (validateTimeout.current) clearTimeout(validateTimeout.current);
    if (v && providerType && providerId) {
      setValidationState('checking');
      validateTimeout.current = setTimeout(runValidation, 800);
    }
  };

  if (!loaded) return <span className="text-text-muted text-xs">Loading...</span>;

  const tooltipText = validationState === 'checking' ? 'Validating...' :
    validationReason || (validationState === 'valid' ? 'Key is valid' : 'Invalid key');

  return (
    <div>
      <div className="secret-input-wrapper">
        <input
          type={visible ? 'text' : 'password'}
          className="setting-input secret-input"
          value={value}
          onChange={handleChange}
          placeholder={placeholder || ''}
          autoComplete="off"
          spellCheck={false}
        />
        {validationState && (
          <span className={`secret-validation secret-validation-${validationState}`} title={tooltipText}>
            {validationState === 'checking' ? '·' : validationState === 'valid' ? '✓' : '✗'}
          </span>
        )}
        <button
          className="secret-toggle"
          onClick={() => setVisible(!visible)}
          title={visible ? 'Hide' : 'Show'}
        >
          {visible ? '◉' : '○'}
        </button>
      </div>
      {validationState === 'invalid' && validationReason && (
        <div className="validation-error">{validationReason}</div>
      )}
    </div>
  );
}

// ─── Profile Select with Validation ─────────────────────────────────────────────

function ProfileSelect({ value, profiles, onChange, providerType, providerId }) {
  const [validationState, setValidationState] = useState(null);
  const [validationReason, setValidationReason] = useState('');
  const validateTimeout = useRef(null);

  const runValidation = useCallback(() => {
    if (!providerType || !providerId) return;
    setValidationState('checking');
    window.electronAPI.providers.validate(providerType, providerId).then(result => {
      setValidationState(result.valid === true ? 'valid' : result.valid === false ? 'invalid' : null);
      setValidationReason(result.reason || '');
    }).catch(() => {
      setValidationState(null);
      setValidationReason('');
    });
  }, [providerType, providerId]);

  // Validate on mount
  useEffect(() => {
    runValidation();
  }, []);

  const handleChange = (e) => {
    onChange(e);
    // Debounced validation after profile change
    if (validateTimeout.current) clearTimeout(validateTimeout.current);
    setValidationState('checking');
    validateTimeout.current = setTimeout(runValidation, 300);
  };

  const tooltipText = validationState === 'checking' ? 'Validating...' :
    validationReason || (validationState === 'valid' ? 'Credentials valid' : 'Invalid credentials');

  return (
    <div>
      <div className="secret-input-wrapper">
        <select
          className="setting-select"
          value={value}
          onChange={handleChange}
        >
          {(profiles || []).map(p => (
            <option key={p.name || p} value={p.name || p}>{p.label || p.name || p}</option>
          ))}
        </select>
        {validationState && (
          <span className={`secret-validation secret-validation-${validationState}`} title={tooltipText}>
            {validationState === 'checking' ? '·' : validationState === 'valid' ? '✓' : '✗'}
          </span>
        )}
      </div>
      {validationState === 'invalid' && validationReason && (
        <div className="validation-error">{validationReason}</div>
      )}
    </div>
  );
}

// ─── Dynamic Provider Fields ─────────────────────────────────────────────────────

function ProviderFields({ fields, providerConfig, providerId, providerType, configPrefix, awsProfiles, whisperModels, downloadedModels, onConfigChange, downloadProgress, onDownloadModel, localAIDownloadProgress, onLocalAIDownloadModel, localAIModels, localAIAvailable }) {
  if (!fields || fields.length === 0) return null;

  return fields.map((field, i) => {
    // Check showWhen condition
    if (field.showWhen) {
      const [condKey, condVal] = Object.entries(field.showWhen)[0];
      const match = Array.isArray(condVal)
        ? condVal.includes(providerConfig[condKey])
        : providerConfig[condKey] === condVal;
      if (!match) return null;
    }

    const configKey = `${configPrefix}.${field.key}`;
    const currentValue = providerConfig[field.key] ?? field.default ?? '';

    return (
      <div key={field.key}>
        <div className="row-separator" />
        <div className="setting-row">
          <div className="setting-row-info">
            <div className="setting-row-label">{field.label}</div>
          </div>
          <div className="setting-row-control">
            {field.type === 'text' && (
              <input
                type="text"
                className="setting-input"
                value={currentValue}
                placeholder={field.placeholder || ''}
                onChange={e => onConfigChange(configKey, e.target.value)}
              />
            )}

            {field.type === 'select' && (
              <select
                className="setting-select"
                value={currentValue}
                onChange={e => onConfigChange(configKey, e.target.value)}
              >
                {field.options.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            )}

            {field.type === 'secret' && (
              <SecretInput
                secretKey={`${providerId}.${field.key}`}
                placeholder={field.placeholder}
                providerType={providerType}
                providerId={providerId}
              />
            )}

            {field.type === 'profile-select' && (
              <ProfileSelect
                value={currentValue}
                profiles={awsProfiles}
                onChange={e => onConfigChange(configKey, e.target.value)}
                providerType={providerType}
                providerId={providerId}
              />
            )}

            {field.type === 'whisper-model-select' && (
              <div className="whisper-model-control">
                <select
                  className="setting-select"
                  value={currentValue}
                  onChange={e => onConfigChange(configKey, e.target.value)}
                >
                  {field.options.map(opt => {
                    const downloaded = (downloadedModels || []).includes(opt.value);
                    return (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}{downloaded ? '' : ' (not downloaded)'}
                      </option>
                    );
                  })}
                </select>
                {(downloadedModels || []).includes(currentValue) ? (
                  <span className="btn btn-sm" style={{ opacity: 0.6, pointerEvents: 'none' }}>Ready</span>
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => onDownloadModel(currentValue)}
                    disabled={downloadProgress !== null}
                  >
                    {downloadProgress !== null ? `${downloadProgress.percent}%` : 'Download'}
                  </button>
                )}
              </div>
            )}

            {field.type === 'local-ai-model-select' && (
              localAIAvailable === false ? (
                <span className="text-text-muted text-sm">Requires macOS with Apple Silicon</span>
              ) : (
                <div className="whisper-model-control">
                  <select
                    className="setting-select"
                    value={currentValue}
                    onChange={e => onConfigChange(configKey, e.target.value)}
                  >
                    {(localAIModels || []).map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {localAIDownloadProgress?.status === 'ready' ? (
                    <span className="btn btn-sm" style={{ opacity: 0.6, pointerEvents: 'none' }}>Ready</span>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => onLocalAIDownloadModel && onLocalAIDownloadModel(currentValue)}
                      disabled={localAIDownloadProgress !== null && localAIDownloadProgress.status !== 'ready'}
                    >
                      {localAIDownloadProgress !== null ? `${localAIDownloadProgress.percent || 0}%` : 'Download'}
                    </button>
                  )}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    );
  });
}


// ─── History Thumbnail ──────────────────────────────────────────────────────────

function HistoryThumbnail({ entryId, hasScreenshot }) {
  const containerRef = useRef(null);
  const [src, setSrc] = useState(null);
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!hasScreenshot || loadedRef.current) return;
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !loadedRef.current) {
        loadedRef.current = true;
        observer.disconnect();
        window.electronAPI.history.getScreenshot(entryId).then(base64 => {
          if (base64 && mountedRef.current) setSrc(`data:image/jpeg;base64,${base64}`);
        });
      }
    }, { threshold: 0.1 });

    observer.observe(el);
    return () => { mountedRef.current = false; observer.disconnect(); };
  }, [entryId, hasScreenshot]);

  if (!hasScreenshot) return null;

  return (
    <div
      ref={containerRef}
      className="history-thumbnail"
      onClick={(e) => {
        e.stopPropagation();
        window.electronAPI.history.openScreenshot(entryId);
      }}
    >
      {src && <img src={src} alt="Screenshot" />}
    </div>
  );
}

// ─── Clear All Button ───────────────────────────────────────────────────────────

function ClearAllButton({ onConfirm }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef(null);

  const handleInitialClick = () => {
    setConfirming(true);
    timerRef.current = setTimeout(() => setConfirming(false), 4000);
  };

  const handleConfirm = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setConfirming(false);
    onConfirm();
  };

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  if (confirming) {
    return (
      <button className="btn btn-sm clear-confirm-btn" style={{ marginRight: 6 }} onClick={handleConfirm}>
        Delete All?
      </button>
    );
  }

  return (
    <button className="btn btn-secondary btn-sm" style={{ marginRight: 6 }} onClick={handleInitialClick}>
      Clear All
    </button>
  );
}

// ─── Summarize helper ────────────────────────────────────────────────────────────

function summarize(text, maxLen) {
  if (!text) return '';
  const clean = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut) + '...';
}

// ─── Help View ──────────────────────────────────────────────────────────────────

const HELP_STEPS = [
  { section: 'Setup' },
  { num: 1, title: 'Open Settings', detail: 'Click the Topside icon in your menu bar and select Settings' },
  { num: 2, title: 'Register a trigger hotkey', detail: 'Choose a key (e.g. F10) that will start and send recordings' },
  { num: 3, title: 'Configure AI and Transcription', detail: 'Set your AI provider and API key, and choose a transcription service' },
  { section: 'Usage' },
  { num: 4, titleFn: (hk) => <>Press {hk ? <kbd>{hk}</kbd> : 'your hotkey'} to start</>, detail: 'Captures a screenshot of your active window and starts recording' },
  { num: 5, title: 'Speak naturally', detail: 'Ask a question, describe what you need, or give an instruction' },
  { num: 6, titleFn: (hk) => <>Press {hk ? <kbd>{hk}</kbd> : 'your hotkey'} again to send</>, detail: 'Your speech is transcribed, sent with the screenshot to AI' },
  { num: 7, titleFn: (hk) => <>View the response</>, detail: <>Click buttons to follow up, or press your hotkey for another round</> },
  { num: 8, title: <>Press <kbd>Escape</kbd> to cancel anytime</> },
];

function HelpView({ hotkeyLabel, appVersion }) {
  const [showOnStartup, setShowOnStartup] = useState(true);

  useEffect(() => {
    window.electronAPI.help.getShowOnStartup().then(v => setShowOnStartup(v));
  }, []);

  const handleToggle = (e) => {
    const val = !e.target.checked; // checkbox is "don't show", we store "show"
    setShowOnStartup(val);
    window.electronAPI.help.setShowOnStartup(val);
  };

  return (
    <div className="help-view">
      <div className="help-header">
        <TopsideIcon size={42} color="#6366f1" className="help-icon" />
        <div className="help-app-name">Topside</div>
        <div className="help-app-meta">v{appVersion} — Created by Eric Stouffer</div>
      </div>
      <div className="help-steps">
        {HELP_STEPS.map((step, i) => {
          if (step.section) {
            return <div key={i} className="help-section-label">{step.section}</div>;
          }
          const title = step.titleFn ? step.titleFn(hotkeyLabel) : step.title;
          return (
            <div key={i} className="help-step">
              <div className="help-step-num">{step.num}</div>
              <div className="help-step-text">
                <strong>{title}</strong>
                {step.detail && <><br /><span className="help-step-detail">{step.detail}</span></>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="help-footer">
        <label className="help-checkbox-label">
          <input type="checkbox" checked={!showOnStartup} onChange={handleToggle} />
          Don't show on startup
        </label>
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeView, setActiveView] = useState('home');
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [audioDevices, setAudioDevices] = useState([]);

  // Provider metadata from main process
  const [aiProviders, setAiProviders] = useState([]);
  const [transcribeProviders, setTranscribeProviders] = useState([]);
  const [awsProfiles, setAwsProfiles] = useState([]);
  const [downloadedModels, setDownloadedModels] = useState([]);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [localAIDownloadProgress, setLocalAIDownloadProgress] = useState(null);
  const [appInfo, setAppInfo] = useState({ version: '', userName: '' });
  const [breakoutTools, setBreakoutTools] = useState([]);

  // Prompt editor state
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [editedPrompt, setEditedPrompt] = useState('');
  const [promptHasChanges, setPromptHasChanges] = useState(false);

  // Enterprise config state
  const [enterpriseConfig, setEnterpriseConfig] = useState('');
  const [enterpriseHasChanges, setEnterpriseHasChanges] = useState(false);
  const [enterpriseValidation, setEnterpriseValidation] = useState(null); // null | 'checking' | 'valid' | 'invalid'
  const [enterpriseValidationMsg, setEnterpriseValidationMsg] = useState('');
  const enterpriseValidateTimeout = useRef(null);

  // History state
  const [history, setHistory] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null); // null = not searching
  const [searching, setSearching] = useState(false);
  const [embeddingStatus, setEmbeddingStatus] = useState(null);
  const [embeddingDownloadProgress, setEmbeddingDownloadProgress] = useState(null);
  const [embeddingIndexProgress, setEmbeddingIndexProgress] = useState(null);
  const [smartSearchComplete, setSmartSearchComplete] = useState(false);
  const searchTimeout = useRef(null);

  const switchView = useCallback((view) => {
    setActiveView(view === 'history' ? 'home' : view);
  }, []);

  // Listen for view switch from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onSwitchView((view) => {
      switchView(view);
    });
    return cleanup;
  }, [switchView]);

  useEffect(() => {
    // Load all data in parallel
    Promise.all([
      window.electronAPI.config.getAll(),
      window.electronAPI.getDefaultPrompt(),
      window.electronAPI.providers.ai(),
      window.electronAPI.providers.transcribe(),
      window.electronAPI.providers.awsProfiles(),
      window.electronAPI.providers.whisperModels(),
      window.electronAPI.appInfo(),
      window.electronAPI.history.getAll(),
      window.electronAPI.breakout?.detectTools?.() || Promise.resolve([]),
    ]).then(([cfg, prompt, ai, transcribe, profiles, whisperModels, info, hist, tools]) => {
      setConfig(cfg);
      setDefaultPrompt(prompt);
      setAiProviders(ai);
      setTranscribeProviders(transcribe);
      setAwsProfiles(profiles);
      setDownloadedModels(whisperModels);
      setAppInfo(info);
      setHistory(hist || []);
      setBreakoutTools(tools || []);
      setLoading(false);

      // Check if local AI model is already loaded
      window.electronAPI.localAI.getStatus().then(status => {
        if (status.loaded) setLocalAIDownloadProgress({ status: 'ready' });
      }).catch(() => {});

      // Check embedding model status
      window.electronAPI.embedding.getStatus().then(setEmbeddingStatus).catch(() => {});
    });

    // Enumerate audio input devices (reusable for refresh)
    const refreshAudioDevices = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
      } catch (err) {
        console.error('Failed to enumerate audio devices:', err);
      }
    };

    // Refresh history, embedding status, and audio devices when popover regains focus
    const onFocus = () => {
      window.electronAPI.history.getAll().then(hist => setHistory(hist || []));
      window.electronAPI.embedding.getStatus().then(setEmbeddingStatus).catch(() => {});
      refreshAudioDevices();
    };
    window.addEventListener('focus', onFocus);

    // Re-enumerate when devices are plugged in / unplugged
    navigator.mediaDevices.addEventListener('devicechange', refreshAudioDevices);

    // Initial enumeration
    refreshAudioDevices();

    // Listen for download progress
    const cleanupWhisper = window.electronAPI.whisper.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
      if (progress.percent >= 100) {
        setTimeout(() => {
          setDownloadProgress(null);
          // Refresh downloaded models list
          window.electronAPI.providers.whisperModels().then(setDownloadedModels);
        }, 500);
      }
    });

    // Listen for local AI download progress
    const cleanupLocalAI = window.electronAPI.localAI.onDownloadProgress((progress) => {
      if (progress.status === 'ready' || progress.status === 'error') return; // handled by handleLocalAIDownloadModel
      setLocalAIDownloadProgress(progress);
    });

    // Listen for embedding download/index progress
    const cleanupEmbeddingDl = window.electronAPI.embedding.onDownloadProgress((progress) => {
      setEmbeddingDownloadProgress(progress);
    });
    const cleanupEmbeddingIdx = window.electronAPI.embedding.onIndexProgress((progress) => {
      setEmbeddingIndexProgress(progress);
      if (progress.percent >= 100) {
        setTimeout(() => {
          setEmbeddingIndexProgress(null);
          window.electronAPI.embedding.getStatus().then(setEmbeddingStatus).catch(() => {});
        }, 500);
      }
    });

    return () => {
      window.removeEventListener('focus', onFocus);
      navigator.mediaDevices.removeEventListener('devicechange', refreshAudioDevices);
      cleanupWhisper();
      cleanupLocalAI();
      cleanupEmbeddingDl();
      cleanupEmbeddingIdx();
    };
  }, []);

  // Sync prompt editor when config loads
  useEffect(() => {
    if (config && defaultPrompt) {
      setEditedPrompt(config.ai?.systemPrompt || defaultPrompt);
    }
  }, [config, defaultPrompt]);

  // Sync enterprise config when config loads
  useEffect(() => {
    if (config?.enterprise) {
      setEnterpriseConfig(JSON.stringify(config.enterprise, null, 2));
      setEnterpriseValidation('valid');
      setEnterpriseValidationMsg('Active');
    }
  }, [config?.enterprise]);

  // Cleanup enterprise validation timeout and search timeout on unmount
  useEffect(() => {
    return () => {
      if (enterpriseValidateTimeout.current) clearTimeout(enterpriseValidateTimeout.current);
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, []);

  // In-renderer hotkey capture via keydown listener
  useEffect(() => {
    if (!capturing) return;

    const handleKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore standalone modifier keys
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      // Build accelerator string from modifiers + key
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');

      // Map event.code to Electron accelerator key name
      let keyName;
      if (e.code.startsWith('Key')) {
        keyName = e.code.slice(3); // KeyA → A
      } else if (e.code.startsWith('Digit')) {
        keyName = e.code.slice(5); // Digit1 → 1
      } else if (e.code.startsWith('F') && /^F\d+$/.test(e.code)) {
        keyName = e.code; // F1, F10, etc.
      } else {
        const codeMap = {
          Space: 'Space', Tab: 'Tab', Enter: 'Return', Backspace: 'Backspace',
          Escape: 'Escape', Delete: 'Delete', Insert: 'Insert',
          Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
          ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
          Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/',
          Backquote: '`', BracketLeft: '[', BracketRight: ']',
          Semicolon: ';', Quote: "'", Backslash: '\\',
          NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
          NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
          NumpadDecimal: 'numdec',
          Numpad0: 'num0', Numpad1: 'num1', Numpad2: 'num2', Numpad3: 'num3',
          Numpad4: 'num4', Numpad5: 'num5', Numpad6: 'num6',
          Numpad7: 'num7', Numpad8: 'num8', Numpad9: 'num9',
        };
        keyName = codeMap[e.code] || e.key;
      }

      if (!keyName) return;
      parts.push(keyName);

      const accelerator = parts.join('+');
      // Build human-readable label
      const label = parts.map(p => {
        if (p === 'CommandOrControl') return window.electronAPI.platform === 'darwin' ? 'Cmd' : 'Ctrl';
        return p;
      }).join('+');

      const hotkey = { accelerator, label };
      window.electronAPI.hotkey.set(hotkey).then(() => {
        setConfig(prev => ({ ...prev, hotkey }));
        setCapturing(false);
        playRegisteredSound();
      });
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [capturing]);

  const updateConfig = useCallback(async (key, value) => {
    await window.electronAPI.config.set(key, value);
    setConfig(prev => {
      const updated = JSON.parse(JSON.stringify(prev));
      const keys = key.split('.');
      let obj = updated;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return updated;
    });
  }, []);

  const handleRegisterHotkey = () => {
    setCapturing(true);
  };

  const handleClearHotkey = async () => {
    setCapturing(false);
    const defaultHotkey = await window.electronAPI.hotkey.clear();
    setConfig(prev => ({ ...prev, hotkey: defaultHotkey }));
  };

  const handlePromptChange = (value) => {
    setEditedPrompt(value);
    const baseline = config.ai?.systemPrompt || defaultPrompt;
    setPromptHasChanges(value !== baseline);
  };

  const handlePromptSave = async () => {
    await updateConfig('ai.systemPrompt', editedPrompt);
    setPromptHasChanges(false);
  };

  const handlePromptCancel = () => {
    setEditedPrompt(config.ai?.systemPrompt || defaultPrompt);
    setPromptHasChanges(false);
  };

  const handlePromptReset = async () => {
    await updateConfig('ai.systemPrompt', null);
    setEditedPrompt(defaultPrompt);
    setPromptHasChanges(false);
  };

  const handleClearHistory = async () => {
    await window.electronAPI.history.clear();
    setHistory([]);
    setSearchQuery('');
    setSearchResults(null);
  };

  const handleSearchChange = (value) => {
    setSearchQuery(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!value.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimeout.current = setTimeout(async () => {
      try {
        const results = await window.electronAPI.history.search(value.trim());
        setSearchResults(results);
      } catch (err) {
        console.error('Search failed:', err);
        setSearchResults([]);
      }
      setSearching(false);
    }, 300);
  };

  const handleEmbeddingDownload = async () => {
    setEmbeddingDownloadProgress({ percent: 0 });
    try {
      await window.electronAPI.embedding.downloadModel();
      setEmbeddingDownloadProgress(null);
      const status = await window.electronAPI.embedding.getStatus();
      setEmbeddingStatus(status);
      // Show confirmation, auto-dismiss after 6 seconds
      setSmartSearchComplete(true);
      setTimeout(() => setSmartSearchComplete(false), 6000);
      // Auto-index after download
      window.electronAPI.embedding.indexAll();
    } catch (err) {
      console.error('Embedding download failed:', err);
      setEmbeddingDownloadProgress(null);
    }
  };

  const handleEnterpriseChange = (value) => {
    setEnterpriseConfig(value);
    const saved = config?.enterprise ? JSON.stringify(config.enterprise, null, 2) : '';
    setEnterpriseHasChanges(value !== saved);

    // Debounced validation
    if (enterpriseValidateTimeout.current) clearTimeout(enterpriseValidateTimeout.current);
    if (!value.trim()) {
      setEnterpriseValidation(null);
      setEnterpriseValidationMsg('');
      return;
    }
    setEnterpriseValidation('checking');
    enterpriseValidateTimeout.current = setTimeout(async () => {
      try {
        const result = await window.electronAPI.providers.validateEnterprise(value);
        setEnterpriseValidation(result.valid ? 'valid' : 'invalid');
        setEnterpriseValidationMsg(result.reason || '');
      } catch (_) {
        setEnterpriseValidation('invalid');
        setEnterpriseValidationMsg('Validation failed');
      }
    }, 500);
  };

  const handleEnterpriseSave = async () => {
    try {
      const parsed = JSON.parse(enterpriseConfig);
      await updateConfig('enterprise', parsed);
      setEnterpriseHasChanges(false);
    } catch (e) {
      setEnterpriseValidation('invalid');
      setEnterpriseValidationMsg('Invalid JSON');
    }
  };

  const handleEnterpriseCancel = () => {
    const saved = config?.enterprise ? JSON.stringify(config.enterprise, null, 2) : '';
    setEnterpriseConfig(saved);
    setEnterpriseHasChanges(false);
    if (saved) {
      setEnterpriseValidation('valid');
      setEnterpriseValidationMsg('Active');
    } else {
      setEnterpriseValidation(null);
      setEnterpriseValidationMsg('');
    }
  };

  const handleEnterpriseClear = async () => {
    await updateConfig('enterprise', null);
    setEnterpriseConfig('');
    setEnterpriseHasChanges(false);
    setEnterpriseValidation(null);
    setEnterpriseValidationMsg('');
  };

  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const deleteTimerRef = useRef(null);

  const handleDeleteEntry = async (e, id) => {
    e.stopPropagation();
    if (confirmingDeleteId !== id) {
      // First click — enter confirmation state
      setConfirmingDeleteId(id);
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = setTimeout(() => setConfirmingDeleteId(null), 4000);
      return;
    }
    // Second click — confirmed, delete
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    setConfirmingDeleteId(null);
    await window.electronAPI.history.delete(id);
    setHistory(prev => prev.filter(h => h.id !== id));
    if (searchResults) {
      setSearchResults(prev => prev ? prev.filter(h => h.id !== id) : null);
    }
  };

  const formatTokens = (entry) => {
    const total = (entry.tokenUsage?.inputTokens || 0) + (entry.tokenUsage?.outputTokens || 0);
    if (total === 0) return '—';
    if (total >= 1000) return `${(total / 1000).toFixed(1)}k`;
    return String(total);
  };

  const timeAgo = (ts) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const formatBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleDownloadModel = async (modelFile) => {
    setDownloadProgress({ percent: 0, downloaded: 0, total: 0 });
    try {
      await window.electronAPI.whisper.downloadModel(modelFile);
      const models = await window.electronAPI.providers.whisperModels();
      setDownloadedModels(models);
    } catch (err) {
      console.error('Download failed:', err);
    }
    setDownloadProgress(null);
  };

  const handleLocalAIDownloadModel = async (modelId) => {
    setLocalAIDownloadProgress({ percent: 0 });
    try {
      await window.electronAPI.localAI.downloadModel(modelId);
      setLocalAIDownloadProgress({ status: 'ready' });
    } catch (err) {
      console.error('Local AI download failed:', err);
      setLocalAIDownloadProgress(null);
    }
  };

  if (loading || !config) {
    return (
      <div className="settings-container">
        <div className="text-text-muted text-sm p-8">Loading...</div>
      </div>
    );
  }

  const hotkeyLabel = config.hotkey?.label || 'Not set';
  const isCustomPrompt = config.ai?.systemPrompt && config.ai.systemPrompt !== defaultPrompt;

  // Current provider metadata
  const currentAiProvider = aiProviders.find(p => p.id === (config.ai?.provider || 'bedrock'));
  const currentTranscribeProvider = transcribeProviders.find(p => p.id === (config.transcribe?.provider || 'aws'));

  // Navigation header for sub-views
  const isSubView = activeView !== 'home';
  const viewTitles = { settings: 'Settings', help: 'Help' };

  return (
    <div className="settings-container">
      {/* ─── Navigation Header ─── */}
      {activeView === 'home' ? (
        <div className="popover-nav popover-nav-home">
          <button className="popover-capture-btn" onClick={() => window.electronAPI.popover.startRecording()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>
            Capture
          </button>
          <div className="popover-nav-brand">
            <TopsideIcon size={22} color="#6366f1" />
            <span className="popover-nav-name">Topside</span>
          </div>
        </div>
      ) : (
        <div className="popover-nav popover-nav-sub">
          <div className="popover-nav-sub-left">
            <button className="popover-back-btn" onClick={() => switchView('home')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
            </button>
            <span className="popover-nav-title">{viewTitles[activeView] || ''}</span>
          </div>
          <div className="popover-nav-brand">
            <TopsideIcon size={18} color="#6366f1" />
            <span className="popover-nav-name">Topside</span>
          </div>
        </div>
      )}

      <div className="settings-body">
        {/* ─── HOME VIEW ─── */}
        {activeView === 'home' && (
          <div className="home-view">
            {history.length > 0 && (
              <div className="history-toolbar">
                <div className="history-search">
                  <span className="history-search-icon">
                    {searching ? (
                      <span className="history-search-spinner" />
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="#737373" strokeWidth="1.5"/><path d="M10.5 10.5L14.5 14.5" stroke="#737373" strokeWidth="1.5" strokeLinecap="round"/></svg>
                    )}
                  </span>
                  <input
                    type="text"
                    className="history-search-input"
                    value={searchQuery}
                    onChange={e => handleSearchChange(e.target.value)}
                    placeholder="Search conversations..."
                  />
                  {searchQuery && (
                    <button
                      className="history-search-clear"
                      onClick={() => handleSearchChange('')}
                    >&times;</button>
                  )}
                </div>
                <ClearAllButton onConfirm={handleClearHistory} />
              </div>
            )}

            {searchQuery && !searching && searchResults !== null && (
              <div className="search-result-count">
                {searchResults.length === 0
                  ? `No results for "${searchQuery}"`
                  : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''} for "${searchQuery}"`}
              </div>
            )}

            <div className="home-entries">
              {history.length === 0 ? (
                <div className="home-empty">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#525252" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 10 }}>
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <div className="home-empty-title">No conversations yet</div>
                  <div className="home-empty-subtitle">Click <strong>Capture</strong> to begin</div>
                </div>
              ) : searchResults !== null && searchResults.length === 0 ? (
                <div className="home-empty">
                  <div className="home-empty-title">No matching conversations</div>
                </div>
              ) : (
                (searchResults || history).map((entry) => (
                  <div
                    key={entry.id}
                    className="home-entry"
                    onClick={() => {
                      window.electronAPI.history.openDetail(entry);
                      window.electronAPI.popover.close();
                    }}
                  >
                    <HistoryThumbnail entryId={entry.id} hasScreenshot={entry.hasScreenshot} />
                    <div className="home-entry-body">
                      <div className="home-entry-top">
                        {entry.similarity != null && <span className="history-similarity" />}
                        <span className="home-entry-transcript">
                          {(entry.transcript || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation'}
                        </span>
                        <span className="home-entry-time">{timeAgo(entry.timestamp)}</span>
                      </div>
                      <div className="home-entry-summary">{summarize(entry.aiText, 100)}</div>
                    </div>
                    <button
                      className={`history-delete-btn${confirmingDeleteId === entry.id ? ' confirming' : ''}`}
                      onClick={(e) => handleDeleteEntry(e, entry.id)}
                      title={confirmingDeleteId === entry.id ? 'Click again to confirm' : 'Delete entry'}
                    >{confirmingDeleteId === entry.id ? 'Delete?' : '\u00d7'}</button>
                  </div>
                ))
              )}

              {/* Smart Search prompt — shown when searching without embedding model */}
              {searchQuery && embeddingStatus && !embeddingStatus.modelDownloaded && !embeddingDownloadProgress && !smartSearchComplete && (
                <div className="smart-search-card">
                  <div className="smart-search-card-title">Want smarter results?</div>
                  <div className="smart-search-card-body">
                    Download a small AI model (~22 MB) that finds conversations by meaning, not just exact words. Runs entirely on your device — nothing leaves your computer.
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={handleEmbeddingDownload}>
                    Enable Smart Search
                  </button>
                </div>
              )}

              {embeddingDownloadProgress && (
                <div className="smart-search-card">
                  <div className="smart-search-card-title">Setting up Smart Search...</div>
                  <div className="smart-search-progress">
                    <div className="smart-search-progress-bar" style={{ width: `${embeddingDownloadProgress.percent || 0}%` }} />
                  </div>
                  <div className="smart-search-card-detail">Downloading model... {embeddingDownloadProgress.percent || 0}%</div>
                </div>
              )}

              {!embeddingDownloadProgress && embeddingIndexProgress && (
                <div className="smart-search-card">
                  <div className="smart-search-card-title">Indexing conversations...</div>
                  <div className="smart-search-progress">
                    <div className="smart-search-progress-bar" style={{ width: `${embeddingIndexProgress.total > 0 ? Math.round((embeddingIndexProgress.indexed / embeddingIndexProgress.total) * 100) : 0}%` }} />
                  </div>
                  <div className="smart-search-card-detail">{embeddingIndexProgress.indexed} of {embeddingIndexProgress.total} conversations</div>
                </div>
              )}

              {smartSearchComplete && (
                <div className="smart-search-card smart-search-complete">
                  <div className="smart-search-complete-row">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" fill="#22c55e"/><path d="M5 8l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <div>
                      <div className="smart-search-card-title">Smart Search enabled</div>
                      <div className="smart-search-card-detail">Your conversations are now searchable by meaning.</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="home-footer">
              <button className="home-footer-link" onClick={() => switchView('settings')}>Settings</button>
              <span className="home-footer-sep">&middot;</span>
              <button className="home-footer-link" onClick={() => switchView('help')}>Help</button>
              <span className="home-footer-sep">&middot;</span>
              <button className="home-footer-link" onClick={() => window.electronAPI.popover.quit()}>Quit</button>
            </div>
          </div>
        )}

        {/* ─── SETTINGS VIEW ─── */}
        {activeView === 'settings' && <div className="settings-tab-content">
        {/* ─── INPUT ─── */}
        <div className="settings-section">
          <h2 className="section-header">Input</h2>
          <div className="settings-card">
            {/* Trigger Hotkey */}
            <div className="setting-row setting-row-hotkey">
              <div className="setting-row-info">
                <div className="setting-row-label">Trigger Hotkey</div>
                <div className="setting-row-subtitle">
                  Tap to start dictation and capture a screenshot, tap again to send
                </div>
              </div>
              <div className="hotkey-controls">
                <div className={`hotkey-display ${capturing ? 'hotkey-capturing' : ''}`}>
                  {capturing ? 'Press any key...' : hotkeyLabel}
                </div>
                <button
                  className="btn btn-primary"
                  onClick={capturing ? () => setCapturing(false) : handleRegisterHotkey}
                >
                  {capturing ? 'Cancel' : 'Register'}
                </button>
                {!capturing && (
                  <button className="btn btn-secondary" onClick={handleClearHotkey}>
                    Clear
                  </button>
                )}
              </div>
            </div>

            <div className="row-separator" />

            {/* Microphone */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Microphone</div>
                <div className="setting-row-subtitle">Audio input device</div>
              </div>
              <div className="setting-row-control">
                <select
                  className="setting-select"
                  value={config.audio?.inputDevice || 'default'}
                  onChange={e => {
                    const deviceId = e.target.value;
                    updateConfig('audio.inputDevice', deviceId);
                    // Save label alongside ID so overlay can verify device identity
                    const device = audioDevices.find(d => d.deviceId === deviceId);
                    updateConfig('audio.inputDeviceLabel', device?.label || null);
                  }}
                >
                  <option value="default">Default Microphone</option>
                  {audioDevices
                    .filter(d => d.deviceId !== 'default')
                    .map(d => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Microphone ${d.deviceId.slice(0, 8)}`}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="row-separator" />

            {/* Microphone Gain */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Microphone Gain</div>
                <div className="setting-row-subtitle">Boost quiet microphones ({config.audio?.gain || 4}x)</div>
              </div>
              <div className="setting-row-control" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="text-text-secondary" style={{ fontSize: '11px' }}>1x</span>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="0.5"
                  value={config.audio?.gain || 4}
                  onChange={e => updateConfig('audio.gain', parseFloat(e.target.value))}
                  style={{ width: '120px', accentColor: '#6366f1' }}
                />
                <span className="text-text-secondary" style={{ fontSize: '11px' }}>10x</span>
              </div>
            </div>

            <div className="row-separator" />

            {/* Sound Effects */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Sound Effects</div>
                <div className="setting-row-subtitle">Play chime when recording starts</div>
              </div>
              <div className="setting-row-control">
                <select
                  className="setting-select"
                  value={config.overlay?.soundEffects !== false ? 'on' : 'off'}
                  onChange={e => updateConfig('overlay.soundEffects', e.target.value === 'on')}
                >
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* ─── TRANSCRIPTION ─── */}
        <div className="settings-section">
          <h2 className="section-header">Transcription</h2>
          <div className="settings-card">
            {/* Provider */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Provider</div>
                <div className="setting-row-subtitle">Speech-to-text service</div>
              </div>
              <div className="setting-row-control">
                <select
                  className="setting-select"
                  value={config.transcribe?.provider || 'aws'}
                  onChange={e => updateConfig('transcribe.provider', e.target.value)}
                >
                  {transcribeProviders.map(p => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Dynamic provider fields */}
            {currentTranscribeProvider && (
              <ProviderFields
                fields={currentTranscribeProvider.configFields}
                providerConfig={config.transcribe?.[config.transcribe?.provider] || {}}
                providerId={config.transcribe?.provider || 'aws'}
                providerType="transcribe"
                configPrefix={`transcribe.${config.transcribe?.provider || 'aws'}`}
                awsProfiles={awsProfiles}
                whisperModels={currentTranscribeProvider.configFields?.find(f => f.type === 'whisper-model-select')?.options}
                downloadedModels={downloadedModels}
                onConfigChange={updateConfig}
                downloadProgress={downloadProgress}
                onDownloadModel={handleDownloadModel}
              />
            )}

            <div className="row-separator" />

            {/* Language */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Language</div>
              </div>
              <div className="setting-row-control">
                <input
                  type="text"
                  className="setting-input"
                  value={config.transcribe?.language || 'en-US'}
                  onChange={e => updateConfig('transcribe.language', e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ─── AI ─── */}
        <div className="settings-section">
          <h2 className="section-header">AI</h2>
          <div className="settings-card">
            {/* Provider */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Provider</div>
                <div className="setting-row-subtitle">AI service for conversations</div>
              </div>
              <div className="setting-row-control">
                <select
                  className="setting-select"
                  value={config.ai?.provider || 'bedrock'}
                  onChange={e => {
                    updateConfig('ai.provider', e.target.value);
                    updateConfig('ai.model', null);
                  }}
                >
                  {aiProviders.map(p => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Dynamic provider fields */}
            {currentAiProvider && (
              <ProviderFields
                fields={currentAiProvider.configFields}
                providerConfig={config.ai?.[config.ai?.provider] || {}}
                providerId={config.ai?.provider || 'bedrock'}
                providerType="ai"
                configPrefix={`ai.${config.ai?.provider || 'bedrock'}`}
                awsProfiles={awsProfiles}
                onConfigChange={updateConfig}
                downloadProgress={null}
                onDownloadModel={() => {}}
                localAIDownloadProgress={localAIDownloadProgress}
                onLocalAIDownloadModel={handleLocalAIDownloadModel}
                localAIModels={currentAiProvider.models}
                localAIAvailable={currentAiProvider.isAvailable}
              />
            )}

            {/* Model — hidden when provider uses local-ai-model-select in its configFields */}
            {currentAiProvider?.models?.length > 0 && !currentAiProvider?.configFields?.some(f => f.type === 'local-ai-model-select') && (
              <>
                <div className="row-separator" />
                <div className="setting-row">
                  <div className="setting-row-info">
                    <div className="setting-row-label">Model</div>
                  </div>
                  <div className="setting-row-control">
                    <select
                      className="setting-select"
                      value={config.ai?.model || currentAiProvider.fastModel || ''}
                      onChange={e => updateConfig('ai.model', e.target.value)}
                    >
                      {currentAiProvider.models.map(m => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </>
            )}

            <div className="row-separator" />

            {/* Continue in CLI */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Continue in CLI</div>
                <div className="setting-row-subtitle">
                  {breakoutTools.length > 0
                    ? (() => {
                        const selected = breakoutTools.find(t => t.id === (config.breakout?.cliTool || 'claude'));
                        if (selected && selected.hasVision === false) {
                          return 'Hand off conversation to a terminal AI agent. This tool cannot view screenshots.';
                        }
                        return 'Hand off conversation to a terminal AI agent for deeper work';
                      })()
                    : 'No AI CLI tools detected. Install Claude Code, Kiro, Gemini, or OpenAI Codex.'}
                </div>
              </div>
              <div className="setting-row-control">
                {breakoutTools.length > 0 ? (
                  <select
                    className="setting-select"
                    value={config.breakout?.cliTool || 'claude'}
                    onChange={e => updateConfig('breakout.cliTool', e.target.value)}
                  >
                    {breakoutTools.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.label}{t.hasVision === false ? ' (no screenshot)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-text-muted text-sm">None installed</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ─── DISPLAY ─── */}
        <div className="settings-section">
          <h2 className="section-header">Display</h2>
          <div className="settings-card">
            {/* Screenshot */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Screenshot</div>
                <div className="setting-row-subtitle">What to capture for AI context</div>
              </div>
              <div className="setting-row-control">
                <select
                  className="setting-select"
                  value={config.capture?.mode || 'window'}
                  onChange={e => updateConfig('capture.mode', e.target.value)}
                >
                  <option value="window">Active Window</option>
                  <option value="screen">Full Screen</option>
                </select>
              </div>
            </div>

            <div className="row-separator" />

            {/* Overlay Position */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Overlay Position</div>
              </div>
              <div className="setting-row-control">
                <select
                  className="setting-select"
                  value={config.overlay?.position || 'bottom-center'}
                  onChange={e => updateConfig('overlay.position', e.target.value)}
                >
                  {OVERLAY_POSITIONS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="row-separator" />

            {/* Overlay Width */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Overlay Width</div>
              </div>
              <div className="setting-row-control">
                <select
                  className="setting-select"
                  value={config.overlay?.width || 500}
                  onChange={e => updateConfig('overlay.width', parseInt(e.target.value, 10))}
                >
                  <option value={400}>400px</option>
                  <option value={500}>500px (Default)</option>
                  <option value={600}>600px</option>
                  <option value={700}>700px</option>
                </select>
              </div>
            </div>

            <div className="row-separator" />

            {/* Font Size */}
            <div className="setting-row">
              <div className="setting-row-info">
                <div className="setting-row-label">Overlay Font Size</div>
              </div>
              <div className="setting-row-control">
                <select
                  className="setting-select"
                  value={config.overlay?.fontSize || 13}
                  onChange={e => updateConfig('overlay.fontSize', parseInt(e.target.value, 10))}
                >
                  <option value={10}>Small (10)</option>
                  <option value={11}>11</option>
                  <option value={12}>12</option>
                  <option value={13}>Default (13)</option>
                  <option value={14}>14</option>
                  <option value={15}>15</option>
                  <option value={16}>Large (16)</option>
                  <option value={18}>XL (18)</option>
                </select>
              </div>
            </div>

          </div>
        </div>

        {/* ─── SYSTEM PROMPT ─── */}
        <div className="settings-section">
          <h2 className="section-header">System Prompt</h2>
          <div className="settings-card">
            <div className="prompt-editor">
              <textarea
                className="prompt-textarea"
                value={editedPrompt}
                onChange={e => handlePromptChange(e.target.value)}
                rows={12}
                spellCheck={false}
              />
              <div className="prompt-footer">
                <span className="prompt-char-count">
                  {editedPrompt.length} chars
                  {isCustomPrompt && <span className="prompt-badge">Custom</span>}
                </span>
                <div className="prompt-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={handlePromptReset}
                    disabled={!isCustomPrompt && !promptHasChanges}
                  >
                    Reset to Default
                  </button>
                  {promptHasChanges && (
                    <>
                      <button className="btn btn-secondary" onClick={handlePromptCancel}>
                        Cancel
                      </button>
                      <button className="btn btn-primary" onClick={handlePromptSave}>
                        Save
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ─── ENTERPRISE ─── */}
        <div className="settings-section">
          <h2 className="section-header">Enterprise</h2>
          <div className="settings-card">
            <div className="prompt-editor">
              <div className="setting-row-subtitle" style={{ marginBottom: 8 }}>
                Paste credential provider configuration to enable corporate authentication.
              </div>
              <textarea
                className="prompt-textarea"
                value={enterpriseConfig}
                onChange={e => handleEnterpriseChange(e.target.value)}
                rows={6}
                spellCheck={false}
                placeholder={'{\n  "credentialEndpoint": "https://...",\n  "authEndpoint": "https://...",\n  "cookiePath": "~/.midway/cookie"\n}'}
              />
              {enterpriseValidation && (
                <div className={`enterprise-validation enterprise-validation-${enterpriseValidation}`}>
                  {enterpriseValidation === 'checking' ? 'Validating...' :
                   enterpriseValidation === 'valid' ? `✓ ${enterpriseValidationMsg || 'Valid'}` :
                   `✗ ${enterpriseValidationMsg || 'Invalid'}`}
                </div>
              )}
              <div className="prompt-footer">
                <span className="prompt-char-count">
                  {enterpriseConfig.length} chars
                  {config?.enterprise && !enterpriseHasChanges && (
                    <span className="prompt-badge">Active</span>
                  )}
                </span>
                <div className="prompt-actions">
                  {config?.enterprise && (
                    <button className="btn btn-secondary" onClick={handleEnterpriseClear}>
                      Clear
                    </button>
                  )}
                  {enterpriseHasChanges && (
                    <>
                      <button className="btn btn-secondary" onClick={handleEnterpriseCancel}>
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={handleEnterpriseSave}
                        disabled={enterpriseValidation !== 'valid'}
                      >
                        Save
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        </div>}

        {/* ─── HELP VIEW ─── */}
        {activeView === 'help' && (
          <HelpView hotkeyLabel={config.hotkey?.label || null} appVersion={appInfo.version} />
        )}
      </div>

    </div>
  );
}
