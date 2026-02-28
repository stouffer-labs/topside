import { useState, useMemo, useCallback } from 'react';

// ─── Lightweight markdown renderer ──────────────────────────────────────────
// Handles: fenced code blocks (with copy button), inline code, bold, plain text.

export function renderInline(text) {
  const parts = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const tok = match[0];
    if (tok.startsWith('`')) {
      parts.push(<code key={match.index} className="md-inline-code">{tok.slice(1, -1)}</code>);
    } else {
      parts.push(<strong key={match.index}>{tok.slice(2, -2)}</strong>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback((e) => {
    e.stopPropagation();
    window.electronAPI?.copyText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [code]);

  return (
    <div className="md-code-wrapper">
      <pre className="md-code-block"><code>{code}</code></pre>
      <button className="md-code-copy" onClick={handleCopy} title="Copy code">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function Markdown({ text }) {
  const elements = useMemo(() => {
    if (!text) return null;
    const result = [];
    const parts = text.split(/(```[\s\S]*?```)/g);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      if (part.startsWith('```') && part.endsWith('```')) {
        const inner = part.slice(3, -3);
        const newline = inner.indexOf('\n');
        const code = newline >= 0 ? inner.slice(newline + 1) : inner;
        result.push(<CodeBlock key={i} code={code} />);
      } else {
        result.push(<span key={i}>{renderInline(part)}</span>);
      }
    }
    return result;
  }, [text]);
  return <>{elements}</>;
}
