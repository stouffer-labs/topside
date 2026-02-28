import { useState, useEffect, useRef, useCallback } from 'react';
import Markdown from '../shared/Markdown';
import TopsideIcon from '../shared/TopsideIcon';

export default function DetailApp() {
  const [entry, setEntry] = useState(null);
  const [messages, setMessages] = useState([]);
  const [screenshotBase64, setScreenshotBase64] = useState(null);
  const [streamingText, setStreamingText] = useState(null);
  const [inputText, setInputText] = useState('');
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const conversationRef = useRef(null);
  const inputRef = useRef(null);
  const aiInFlight = status === 'Thinking...';

  // Load entry data on mount
  useEffect(() => {
    window.detailAPI.getEntry().then((data) => {
      if (!data) return;
      setEntry(data.entry);
      setMessages(data.messages || []);
      setScreenshotBase64(data.screenshotBase64 || null);
    });
  }, []);

  // Subscribe to IPC push events
  useEffect(() => {
    const unsubs = [];

    unsubs.push(window.detailAPI.on('detail:thinking', (userText) => {
      setStatus('Thinking...');
      setStreamingText(null);
      setError(null);
    }));

    unsubs.push(window.detailAPI.on('detail:stream-chunk', (text) => {
      setStreamingText(text);
    }));

    unsubs.push(window.detailAPI.on('detail:round-complete', ({ content, buttons }) => {
      setMessages(prev => [...prev, { role: 'assistant', content, buttons }]);
      setStreamingText(null);
      setStatus('Ready');
    }));

    unsubs.push(window.detailAPI.on('detail:error', ({ title, detail }) => {
      setError({ title, detail });
      setStreamingText(null);
      setStatus('Ready');
    }));

    return () => unsubs.forEach(fn => fn?.());
  }, []);

  // Auto-scroll on new messages or streaming
  useEffect(() => {
    if (conversationRef.current) {
      conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
    }
  }, [messages, streamingText]);

  const sendMessage = useCallback((text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || aiInFlight) return;
    setMessages(prev => [...prev, { role: 'user', content: trimmed }]);
    setInputText('');
    setError(null);
    window.detailAPI.chat(trimmed);
  }, [aiInFlight]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputText);
    }
  }, [inputText, sendMessage]);

  const handleCopy = useCallback(() => {
    window.detailAPI.copy();
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 1500);
  }, []);

  const handleBreakout = useCallback(() => {
    window.detailAPI.breakout();
  }, []);

  const handleScreenshotClick = useCallback(() => {
    window.detailAPI.viewScreenshot();
  }, []);

  if (!entry) {
    return (
      <div className="detail-container" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <TopsideIcon size={24} color="#525252" />
      </div>
    );
  }

  const dateStr = new Date(entry.timestamp).toLocaleString();
  const roundCount = messages.filter(m => m.role === 'user').length;

  return (
    <div className="detail-container">
      {/* Title bar */}
      <div className="detail-titlebar">
        <div className="detail-titlebar-info">
          <div className="detail-titlebar-label">{entry.windowTitle || 'Conversation'}</div>
          <div className="detail-titlebar-meta">
            {dateStr} &mdash; {roundCount} round{roundCount !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="detail-titlebar-actions">
          <button className="detail-btn" onClick={handleCopy}>
            {copyFeedback ? 'Copied!' : 'Copy'}
          </button>
          <button className="detail-btn detail-btn-primary" onClick={handleBreakout}>
            &#x2934; CLI
          </button>
        </div>
      </div>

      {/* Conversation */}
      <div className="conversation-area" ref={conversationRef}>
        {messages.map((msg, i) => {
          if (msg.role === 'user') {
            return (
              <div key={i}>
                <div className="conv-user">
                  <div className="conv-icon">&#x1F3A4;</div>
                  <div className="conv-content">
                    <div className="conv-text">{msg.content}</div>
                  </div>
                </div>
                {/* Show screenshot after first user message */}
                {i === 0 && screenshotBase64 && (
                  <div className="screenshot-thumb" onClick={handleScreenshotClick}>
                    <img src={`data:image/jpeg;base64,${screenshotBase64}`} alt="Context screenshot" />
                    <span className="screenshot-thumb-label">Context</span>
                  </div>
                )}
              </div>
            );
          }
          return (
            <div key={i} className="conv-assistant slide-in-from-bottom">
              <div className="conv-icon">&#x2726;</div>
              <div className="conv-content">
                <div className="conv-text"><Markdown text={msg.content} /></div>
                {msg.buttons?.length > 0 && (
                  <div className="conv-buttons">
                    {msg.buttons.map((label, bi) => (
                      <button
                        key={bi}
                        className="ai-button"
                        onClick={() => sendMessage(label)}
                        disabled={aiInFlight}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Streaming AI response */}
        {streamingText !== null && (
          <div className="conv-assistant slide-in-from-bottom">
            <div className="conv-icon">&#x2726;</div>
            <div className="conv-content">
              <div className="conv-text"><Markdown text={streamingText} /></div>
            </div>
          </div>
        )}

        {/* Thinking indicator (before streaming starts) */}
        {aiInFlight && streamingText === null && (
          <div className="conv-assistant slide-in-from-bottom">
            <div className="conv-icon">&#x2726;</div>
            <div className="conv-content">
              <div className="typing-dots"><span>.</span><span>.</span><span>.</span></div>
            </div>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="detail-error">
          <span className="detail-error-title">{error.title || 'Error'}</span>
          <span className="detail-error-detail">{error.detail}</span>
          <button className="detail-error-dismiss" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Chat input */}
      <div className="chat-input-area">
        <div className="chat-input-row">
          <input
            ref={inputRef}
            className="chat-input"
            type="text"
            placeholder="Type a follow-up..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={aiInFlight}
          />
          <button
            className="chat-send-btn"
            onClick={() => sendMessage(inputText)}
            disabled={aiInFlight || !inputText.trim()}
            title="Send"
          >
            &#x2191;
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div className="detail-status">
        <div className="status-left">
          <TopsideIcon size={12} color="#525252" />
          <span className="status-text">Topside</span>
        </div>
        <span className="status-text">{status}</span>
      </div>
    </div>
  );
}
