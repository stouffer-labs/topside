const { EventEmitter } = require('events');
const { clipboard, screen } = require('electron');
const { log } = require('./logger');
const { parseButtons } = require('./ai-service');

const State = {
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  CONVERSING: 'CONVERSING',
  CANCELLED: 'CANCELLED',
};

class SessionOrchestrator extends EventEmitter {
  constructor({ inputMonitor, overlayWindow, showOverlay, hideOverlay, windowService, captureService, transcribeService, aiService, configService, historyService, breakoutService, isSettingsOpen, highlightService, hideSettings, screenshotPreview }) {
    super();
    this.inputMonitor = inputMonitor;
    this.getOverlayWindow = overlayWindow;
    this.showOverlay = showOverlay || (() => {});
    this.hideOverlay = hideOverlay || (() => {});
    this.windowService = windowService;
    this.captureService = captureService;
    this.transcribeService = transcribeService;
    this.aiService = aiService;
    this.configService = configService;
    this.historyService = historyService;
    this.breakoutService = breakoutService || null;
    this.isSettingsOpen = isSettingsOpen || (() => false);
    this.highlightService = highlightService || null;
    this.hideSettings = hideSettings || (() => {});
    this.screenshotPreview = screenshotPreview || null;

    this.state = State.IDLE;
    this.conversation = { messages: [], screenshot: null, windowInfo: null };
    this.currentRound = { segments: [], segmentCounter: 0, currentPartial: '' };
    this.roundNumber = 0;
    this.sessionStartTime = 0;
    this.contextReady = null;
    this.aiInFlight = false;
    this.finalizing = false;

    this.wireInputEvents();
  }

  wireInputEvents() {
    this.inputMonitor.on('trigger-down', () => this.onTriggerDown());
    this.inputMonitor.on('cancel', () => this.onCancel());
  }

  // ─── Trigger handling ───────────────────────────────────────────────

  async onTriggerDown() {
    if (this.isSettingsOpen()) {
      log('SESSION', 'Settings open — hiding settings and proceeding');
      this.hideSettings();
    }

    // Toggle mode: RECORDING → finalize round (was trigger-up in hold mode)
    if (this.state === State.RECORDING) {
      log('SESSION', 'Toggle: stop recording → finalizing round...');
      await this.finalizeRound();
      return;
    }

    if (this.state === State.CONVERSING) {
      if (this.aiInFlight || this.finalizing) {
        log('SESSION', `Ignoring trigger — ${this.aiInFlight ? 'AI still processing' : 'still finalizing'}`);
        return;
      }
      // New recording round within existing conversation
      log('SESSION', `New recording round (round ${this.roundNumber + 1})`);
      this.roundNumber++;
      this.currentRound = { segments: [], segmentCounter: 0, currentPartial: '' };
      this.state = State.RECORDING;

      const overlay = this.getOverlayWindow();
      if (overlay) overlay.webContents.send('overlay:new-round');

      this.startTranscription();
      return;
    }

    if (this.state !== State.IDLE) {
      log('SESSION', `Ignoring trigger-down in state ${this.state}`);
      return;
    }

    // New session
    log('SESSION', 'Session starting...');
    this.state = State.RECORDING;
    this.roundNumber = 0;
    this.conversation = { messages: [], screenshot: null, windowInfo: null, tokenUsage: { inputTokens: 0, outputTokens: 0 } };
    this.currentRound = { segments: [], segmentCounter: 0, currentPartial: '' };
    this.sessionStartTime = Date.now();

    this.inputMonitor.setSessionActive(true);

    const overlay = this.getOverlayWindow();
    if (overlay) overlay.webContents.send('overlay:show');

    this.startTranscription();

    this.contextReady = this.captureContext();
  }

  // ─── Context capture ────────────────────────────────────────────────

  async captureContext() {
    const captureMode = this.configService?.get('capture.mode') || 'window';

    // Detect active window first (~5ms with native addon)
    if (this.windowService) {
      try {
        const info = await this.windowService.getActiveWindow();
        this.conversation.windowInfo = info;
        if (info) log('SESSION', 'Active window:', info.title || 'unknown');
      } catch (err) {
        log('SESSION', 'Window detection failed (non-fatal):', err.message);
      }
    }

    // Show highlight immediately at the correct bounds
    if (this.highlightService) {
      if (captureMode === 'window' && this.conversation.windowInfo?.bounds) {
        this.highlightService.show(this.conversation.windowInfo.bounds);
      } else {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        this.highlightService.show(display.workArea);
      }
    }

    // Take screenshot
    if (this.captureService) {
      try {
        this.conversation.screenshot = await this.captureService.capture(
          this.conversation.windowInfo, captureMode
        );
        if (this.conversation.screenshot) {
          log('SESSION', 'Screenshot captured');
          // Send screenshot to overlay immediately and show overlay — don't wait for flash
          const overlay = this.getOverlayWindow();
          if (overlay) overlay.webContents.send('overlay:screenshot', this.conversation.screenshot.base64);
          this.showOverlay();
          // Camera flash animation runs in parallel (user already sees overlay)
          if (this.highlightService?.flash) {
            this.highlightService.flash();
            await new Promise(r => setTimeout(r, 2000));
            this.highlightService.hide();
          }
        }
      } catch (err) {
        log('SESSION', 'Screenshot failed (non-fatal):', err.message);
      }
    }

    this.showOverlay(); // fallback if screenshot failed
    this.contextReady = null;
  }

  // ─── Transcription ──────────────────────────────────────────────────

  async startTranscription() {
    if (!this.transcribeService) return;
    try {
      this.transcribeService.on('partial', (text) => {
        if (this.state !== State.RECORDING && this.state !== State.CONVERSING) return;
        this.currentRound.currentPartial = text;
        this.sendTranscriptToOverlay();
      });

      this.transcribeService.on('final', (text) => {
        if (this.state !== State.RECORDING && this.state !== State.CONVERSING) return;
        this.currentRound.segmentCounter++;
        this.currentRound.segments.push({ id: this.currentRound.segmentCounter, text: text.trim(), timestamp: Date.now() });
        this.currentRound.currentPartial = '';
        this.sendTranscriptToOverlay();
      });

      this.transcribeService.on('error', (err) => {
        log('SESSION', 'Transcription runtime error:', err.message);
        this.onServiceError('Transcription error', err);
      });

      await this.transcribeService.start();
      log('SESSION', 'Transcription started');
    } catch (err) {
      log('SESSION', 'Transcription failed:', err.message);
      this.onServiceError('Transcription failed', err);
    }
  }

  onServiceError(title, err) {
    // Stop recording — no point continuing with a dead service
    this.state = State.CONVERSING; // prevent further recording triggers

    // Auto-refresh AWS credentials on signature errors so user doesn't need to restart
    const msg = err.message || '';
    if (/signature.*does not match|signing method/i.test(msg)) {
      this._refreshAwsCredentials();
    }

    const overlay = this.getOverlayWindow();
    if (overlay) {
      overlay.webContents.send('overlay:error', {
        title,
        detail: this.friendlyError(err),
        actions: ['Settings', 'Dismiss'],
      });
    }
  }

  _refreshAwsCredentials() {
    try {
      // Force transcribe service to re-resolve credentials from disk on next start
      if (this.transcribeService?.provider?.loadCredentials) {
        this.transcribeService.provider.loadCredentials().catch(() => {});
        log('SESSION', 'AWS credentials refreshed for transcription');
      }
      // Also invalidate the AI client so it picks up fresh credentials
      if (this.aiService?.invalidateClient) {
        this.aiService.invalidateClient();
        log('SESSION', 'AI client invalidated for credential refresh');
      }
    } catch (_) {}
  }

  friendlyError(err) {
    const msg = err.message || String(err);
    // AWS signature mismatch = expired STS session credentials
    if (/signature.*does not match|signing method/i.test(msg)) {
      return 'AWS credentials expired — refresh your credentials and try again.';
    }
    // Show the first meaningful line of the actual error
    const firstLine = msg.split('\n')[0].trim();
    return firstLine.length > 200 ? firstLine.substring(0, 200) + '...' : firstLine;
  }

  sendTranscriptToOverlay() {
    const display = this.currentRound.segments.map(s => s.text).join(' ');
    const partial = this.currentRound.currentPartial;
    const full = display ? (partial ? display + ' ' + partial : display) : partial;
    const overlay = this.getOverlayWindow();
    if (overlay) overlay.webContents.send('overlay:update-transcription', full);
  }

  async stopTranscription() {
    if (!this.transcribeService) return;
    // Stop FIRST (waits for in-progress inference + runs final pass),
    // THEN remove listeners so the final result is captured in segments.
    try { await this.transcribeService.stop(); } catch (err) {
      log('SESSION', 'Transcription stop error (non-fatal):', err.message);
    }
    this.transcribeService.removeAllListeners('partial');
    this.transcribeService.removeAllListeners('final');
    this.transcribeService.removeAllListeners('error');
  }

  // ─── AI response (single path for all rounds) ──────────────────────

  async finalizeRound() {
    this.state = State.CONVERSING;
    this.finalizing = true;
    const myRound = this.roundNumber;

    // Immediately tell overlay to stop showing recording UI
    const overlay = this.getOverlayWindow();
    if (overlay) overlay.webContents.send('overlay:finalizing');

    try {
      // Wait for screenshot capture (and flash animation) before hiding highlight
      if (this.contextReady) await this.contextReady;
      if (this.roundNumber !== myRound) { log('SESSION', 'New round started during context capture — aborting finalize'); return; }
      if (this.highlightService) this.highlightService.hide();

      // stopTranscription waits for in-progress inference + runs final pass,
      // so all captured audio is processed before we check segments.
      await this.stopTranscription();

      if (this.roundNumber !== myRound) { log('SESSION', 'New round started during transcription stop — aborting finalize'); return; }

      // Build transcript
      const round = this.currentRound;
      let transcript = round.segments.map(s => s.text).join(' ');
      if (!transcript.trim() && round.currentPartial?.trim()) {
        transcript = round.currentPartial.trim();
        log('SESSION', 'Using partial transcript (no finals received)');
      }

      if (!transcript.trim()) {
        log('SESSION', 'No transcript — closing session');
        this.saveAndReset();
        return;
      }

      await this.respondToUser(transcript);
    } finally {
      this.finalizing = false;
    }
  }

  async respondToUser(userMessage) {
    this.conversation.messages.push({ role: 'user', content: userMessage });

    const overlay = this.getOverlayWindow();
    if (overlay) overlay.webContents.send('overlay:button-thinking', userMessage);

    this.aiInFlight = true;
    try {
      const aiText = await this.aiService.converse(
        this.conversation.messages,
        this.conversation.screenshot,
        this.conversation.windowInfo,
        (chunk) => {
          if (this.state !== State.CONVERSING) return;
          // Strip EOS tokens from streaming chunks so they don't flash in the overlay
          const clean = chunk.replace(/<\|(?:endoftext|im_end|end|eot_id)\|>/gi, '');
          if (overlay) overlay.webContents.send('overlay:stream-chunk', clean);
        }
      );

      if (this.state !== State.CONVERSING) {
        log('SESSION', 'Session closed during AI call — discarding result');
        return;
      }

      // Accumulate token usage from this round
      const usage = this.aiService.lastUsage;
      if (usage) {
        this.conversation.tokenUsage.inputTokens += usage.inputTokens || 0;
        this.conversation.tokenUsage.outputTokens += usage.outputTokens || 0;
      }

      const { content, buttons } = parseButtons(aiText);
      this.conversation.messages.push({ role: 'assistant', content, buttons });

      log('SESSION', `Round complete: "${userMessage.substring(0, 60)}" → buttons=[${buttons.join(', ')}]`);
      if (overlay) overlay.webContents.send('overlay:round-complete', { content, buttons });

      // Auto-copy if the response is a single clean code block / command
      this.autoCopyIfClean(content);
    } catch (err) {
      if (this.state !== State.CONVERSING) return;
      log('SESSION', 'AI error:', err.message);
      const detail = this.friendlyError(err);
      const content = `**Error:** ${detail}`;
      const isCredentialError = /not configured|api key|credentials|invalid/i.test(err.message);
      const buttons = isCredentialError ? ['Settings', 'Try again'] : ['Try again'];
      this.conversation.messages.push({ role: 'assistant', content, buttons });
      if (overlay) overlay.webContents.send('overlay:round-complete', { content, buttons });
    } finally {
      this.aiInFlight = false;
    }
  }

  async onButtonClick(label) {
    // Intercept action buttons
    if (label === 'Settings') {
      this.emit('open-settings');
      return;
    }
    if (label === 'Dismiss') {
      this.onClose();
      return;
    }

    if (this.state !== State.CONVERSING) {
      log('SESSION', `Ignoring button click in state ${this.state}`);
      return;
    }
    log('SESSION', `Button clicked: "${label}"`);
    await this.respondToUser(label);
  }

  // ─── Toolbar actions ────────────────────────────────────────────────

  // Extract fenced code blocks from text; if any exist, return them (joined).
  // Otherwise return the full text. This lets Copy/Paste target just the code.
  extractPasteable(text) {
    if (!text) return '';
    const blocks = [];
    const re = /```[\s\S]*?\n([\s\S]*?)```/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const code = match[1].trim();
      if (code) blocks.push(code);
    }
    return blocks.length > 0 ? blocks.join('\n') : text;
  }

  onCopyAction() {
    const lastAssistant = [...this.conversation.messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant?.content) {
      const pasteable = this.extractPasteable(lastAssistant.content);
      clipboard.writeText(pasteable);
      log('SESSION', `Copied to clipboard (${pasteable.length} chars)`);
    }
  }

  // Auto-copy: if the AI response is a single clean code block / command, copy it
  autoCopyIfClean(content) {
    if (!content) return;
    const blocks = [];
    const re = /```[\s\S]*?\n([\s\S]*?)```/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      const code = match[1].trim();
      if (code) blocks.push(code);
    }
    if (blocks.length !== 1) return; // only auto-copy single clean code blocks

    // Check it's a "clean" command: the text outside code blocks is minimal
    const outside = content.replace(/```[\s\S]*?```/g, '').trim();
    if (outside.length > 120) return; // too much surrounding text, not a clean command

    clipboard.writeText(blocks[0]);
    log('SESSION', `Auto-copied command to clipboard (${blocks[0].length} chars)`);
    const overlay = this.getOverlayWindow();
    if (overlay) overlay.webContents.send('overlay:auto-copied');
  }

  async onBreakoutAction() {
    if (!this.breakoutService) {
      log('SESSION', 'Breakout service not available');
      return;
    }
    try {
      const result = await this.breakoutService.breakout(this.conversation, this.configService);
      log('SESSION', `Breakout launched (method: ${result?.method})`);

      // Show clipboard fallback message in overlay before closing
      if (result?.method === 'clipboard' && result.message) {
        const overlay = this.getOverlayWindow();
        if (overlay) {
          overlay.webContents.send('overlay:breakout-clipboard', result.message);
          // Give user time to read the message before closing
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    } catch (err) {
      log('SESSION', 'Breakout error:', err.message);
    }
    await this.onClose();
  }

  async onClose() {
    if (this.state === State.IDLE) return;
    log('SESSION', 'Session closed');
    await this.saveAndReset();
  }

  async onCancel() {
    if (this.state === State.IDLE) return;
    log('SESSION', 'Session cancelled');
    this.state = State.CANCELLED;
    if (this.screenshotPreview) this.screenshotPreview.hide();
    await this.stopTranscription();

    const overlay = this.getOverlayWindow();
    if (overlay) overlay.webContents.send('overlay:cancel');
    setTimeout(() => this.hideAndReset(), 300);
  }

  // ─── Session lifecycle ──────────────────────────────────────────────

  async saveAndReset() {
    // Always stop transcription when a session ends — prevents zombie Whisper/WebSockets.
    // Must await to ensure the provider fully stops before resetting state.
    try { await this.stopTranscription(); } catch (_) {}
    if (this.screenshotPreview) this.screenshotPreview.hide();
    if (this.historyService && this.conversation.messages.length > 0) {
      const transcript = this.conversation.messages
        .filter(m => m.role === 'user').map(m => m.content).join(' → ');
      const lastAssistant = [...this.conversation.messages].reverse().find(m => m.role === 'assistant');

      this.historyService.save({
        id: Date.now().toString(36),
        timestamp: Date.now(),
        transcript,
        aiText: lastAssistant?.content || '',
        windowTitle: this.conversation.windowInfo?.title || 'unknown',
        durationMs: Date.now() - this.sessionStartTime,
        rounds: Math.ceil(this.conversation.messages.length / 2),
        messages: this.conversation.messages.map(m => ({ role: m.role, content: m.content })),
        screenshot: this.conversation.screenshot?.base64 || null,
        tokenUsage: this.conversation.tokenUsage.inputTokens > 0 ? this.conversation.tokenUsage : null,
      });
    }
    this.hideAndReset();
  }

  hideAndReset() {
    this.hideOverlay();
    const overlay = this.getOverlayWindow();
    if (overlay) overlay.webContents.send('overlay:hide');
    this.reset();
  }

  reset() {
    if (this.highlightService) this.highlightService.hide();
    if (this.screenshotPreview) this.screenshotPreview.hide();
    this.state = State.IDLE;
    this.aiInFlight = false;
    this.finalizing = false;
    this.conversation = { messages: [], screenshot: null, windowInfo: null, tokenUsage: { inputTokens: 0, outputTokens: 0 } };
    this.currentRound = { segments: [], segmentCounter: 0, currentPartial: '' };
    this.roundNumber = 0;
    this.contextReady = null;
    this.inputMonitor.setSessionActive(false);
    if (this.aiService) this.aiService.reset();
    log('SESSION', 'State reset to IDLE');
  }
}

module.exports = { SessionOrchestrator, State };
