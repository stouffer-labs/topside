const fs = require('fs');
const path = require('path');
const { app, shell, clipboard } = require('electron');
const { log } = require('./logger');

const CLI_TOOLS = [
  { id: 'claude', command: 'claude', label: 'Claude Code', hasVision: true },
  { id: 'kiro', command: 'kiro-cli', label: 'Kiro CLI', hasVision: false },
  { id: 'gemini', command: 'gemini', label: 'Gemini CLI', hasVision: true },
  { id: 'codex', command: 'codex', label: 'OpenAI Codex', hasVision: true },
];

// ─── Tool detection ──────────────────────────────────────────────────────────

function detectTools() {
  // In MAS sandbox we can't exec 'which', so return all tools.
  // The user picks their tool in settings; if it's not installed,
  // Terminal will show "command not found" which is self-explanatory.
  if (process.mas) {
    log('BREAKOUT', 'MAS build — all tools listed as available');
    return [...CLI_TOOLS];
  }

  const { execSync } = require('child_process');
  const available = [];
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  for (const tool of CLI_TOOLS) {
    try {
      execSync(`${whichCmd} ${tool.command}`, { stdio: 'ignore' });
      available.push(tool);
    } catch (_) {}
  }
  log('BREAKOUT', `Detected tools: ${available.map(t => t.id).join(', ') || 'none'}`);
  return available;
}

// ─── Conversation formatting ─────────────────────────────────────────────────

function formatConversation(messages) {
  const lines = ['# Topside Conversation\n'];
  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`## User\n${msg.content}\n`);
    } else if (msg.role === 'assistant') {
      lines.push(`## Assistant\n${msg.content}\n`);
      if (msg.buttons?.length) {
        lines.push(`*Suggested: ${msg.buttons.join(', ')}*\n`);
      }
    }
  }
  return lines.join('\n');
}

function buildPrompt(conversation, tool, sessionDir) {
  const lastUser = [...conversation.messages].reverse().find(m => m.role === 'user');
  const lastAssistant = [...conversation.messages].reverse().find(m => m.role === 'assistant');
  const screenshotPath = conversation.screenshot ? path.join(sessionDir, 'screenshot.jpg') : null;
  const contextLines = [];

  if (conversation.windowInfo) {
    contextLines.push(`The user was looking at: ${conversation.windowInfo.owner} — "${conversation.windowInfo.title}"`);
  }
  if (screenshotPath) {
    if (tool.id === 'gemini') {
      contextLines.push(`Screenshot of what the user was looking at: @${screenshotPath}`);
    } else if (tool.id === 'claude' || tool.id === 'codex') {
      contextLines.push(`A screenshot is saved at: ${screenshotPath}`);
      contextLines.push('Read/view the screenshot file to see what the user was looking at.');
    } else {
      contextLines.push(`A screenshot is saved at: ${screenshotPath} (open it to see what the user was looking at)`);
    }
  }
  contextLines.push(`Full conversation history: ${path.join(sessionDir, 'conversation.md')}`);
  contextLines.push('');
  contextLines.push('Continue helping the user from where this conversation left off.');
  if (lastUser) contextLines.push(`Their last message was: "${lastUser.content}"`);
  if (lastAssistant) contextLines.push(`Your last response was: "${lastAssistant.content}"`);

  return contextLines.join('\n');
}

// ─── Session file writing ────────────────────────────────────────────────────

function writeSessionFiles(sessionDir, conversation) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const conversationMd = formatConversation(conversation.messages);
  fs.writeFileSync(path.join(sessionDir, 'conversation.md'), conversationMd, 'utf8');

  if (conversation.screenshot) {
    try {
      let base64 = typeof conversation.screenshot === 'string'
        ? conversation.screenshot
        : conversation.screenshot.base64;
      // Strip data URI prefix if present (e.g. "data:image/jpeg;base64,...")
      if (base64) {
        const commaIdx = base64.indexOf(',');
        if (commaIdx !== -1 && base64.startsWith('data:')) {
          base64 = base64.slice(commaIdx + 1);
        }
        const buf = Buffer.from(base64, 'base64');
        fs.writeFileSync(path.join(sessionDir, 'screenshot.jpg'), buf);
      }
    } catch (err) {
      log('BREAKOUT', `Failed to save screenshot: ${err.message}`);
    }
  }

  return sessionDir;
}

// ─── Breakout ────────────────────────────────────────────────────────────────
// Writes a .command file (macOS) or .bat file (Windows), then opens it via
// shell.openPath(). On macOS, Terminal.app is the system handler for .command
// files — it opens and runs the script in its own process, outside any sandbox.

async function breakout(conversation, configService) {
  const cliToolId = configService?.get('breakout.cliTool') || 'claude';
  const tool = CLI_TOOLS.find(t => t.id === cliToolId) || CLI_TOOLS[0];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const userDataPath = app.getPath('userData');
  const sessionDir = path.join(userDataPath, 'breakout-sessions', timestamp);

  writeSessionFiles(sessionDir, conversation);

  const prompt = buildPrompt(conversation, tool, sessionDir);
  const promptFile = path.join(sessionDir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, 'utf8');

  // Outside MAS sandbox, check if the tool is installed first
  if (!process.mas) {
    const { execSync } = require('child_process');
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    let toolAvailable = false;
    try {
      execSync(`${whichCmd} ${tool.command}`, { stdio: 'ignore' });
      toolAvailable = true;
    } catch (_) {}

    if (!toolAvailable) {
      log('BREAKOUT', `Tool "${tool.id}" not found, opening session directory instead`);
      shell.openPath(sessionDir);
      return { method: 'folder', tool: tool.label };
    }
  }

  // Build and open a terminal script
  const escapedDir = sessionDir.replace(/'/g, "'\\''");
  const escapedPromptFile = promptFile.replace(/'/g, "'\\''");
  const screenshotPath = path.join(sessionDir, 'screenshot.jpg');
  const hasScreenshot = fs.existsSync(screenshotPath);
  const escapedScreenshot = hasScreenshot ? screenshotPath.replace(/'/g, "'\\''") : null;

  const promptArg = `"$(cat '${escapedPromptFile}')"`;
  const imageFlag = escapedScreenshot ? ` --image '${escapedScreenshot}'` : '';
  const toolCommands = {
    claude:  `${tool.command} ${promptArg}`,
    kiro:    `${tool.command} chat ${promptArg}`,
    gemini:  `${tool.command} -i ${promptArg}`,
    codex:   `${tool.command}${imageFlag} ${promptArg}`,
  };
  const launchCmd = toolCommands[tool.id] || `${tool.command} ${promptArg}`;

  if (process.platform === 'win32') {
    const batFile = path.join(sessionDir, 'launch.bat');
    const batContent = `@echo off\r\ncd /d "${sessionDir}"\r\nset /p PROMPT=<"${promptFile}"\r\n${tool.command} "%PROMPT%"\r\npause`;
    fs.writeFileSync(batFile, batContent);
    await shell.openPath(batFile);
  } else {
    const cmdFile = path.join(sessionDir, 'launch.command');
    const cmdContent = `#!/bin/bash\ncd '${escapedDir}' && ${launchCmd}\n`;
    fs.writeFileSync(cmdFile, cmdContent);
    fs.chmodSync(cmdFile, '755');
    const error = await shell.openPath(cmdFile);
    if (error) {
      log('BREAKOUT', `shell.openPath error: ${error}`);
      clipboard.writeText(prompt);
      return {
        method: 'clipboard',
        tool: tool.label,
        message: `Could not open Terminal. Prompt copied to clipboard — open Terminal and run "${tool.command}" to continue.`,
      };
    }
  }

  log('BREAKOUT', `Launched ${tool.label} in ${sessionDir}`);
  return { method: 'terminal', tool: tool.label };
}

function clearSessions() {
  try {
    const userDataPath = app.getPath('userData');
    const sessionsDir = path.join(userDataPath, 'breakout-sessions');
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      log('BREAKOUT', 'Cleared all breakout sessions');
    }
  } catch (err) {
    log('BREAKOUT', `Failed to clear sessions: ${err.message}`);
  }
}

module.exports = { detectTools, breakout, clearSessions, CLI_TOOLS };
