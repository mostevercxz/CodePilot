#!/usr/bin/env node
/**
 * CodePilot Remote Relay Server
 *
 * Self-contained Node.js relay that runs on the remote server.
 * Binds to 127.0.0.1 only (accessed through SSH tunnel).
 * No external dependencies — uses only Node.js built-ins + Claude Agent SDK.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const RELAY_VERSION = '1.2.0';
const CLAUDE_BINARY = process.env.CLAUDE_BINARY || 'claude';
const RELAY_LOG = path.join(__dirname, 'relay-debug.log');

function relayLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(RELAY_LOG, line); } catch { /* ignore */ }
  console.log(msg);
}

// Active sessions: sessionId → { process, abortController }
const activeSessions = new Map();

// Find an available port
function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Parse JSON body from request
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Parse query string from URL
function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const params = {};
  const pairs = url.slice(idx + 1).split('&');
  for (const pair of pairs) {
    const [key, ...rest] = pair.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
  }
  return params;
}

// Get Claude CLI version
function getClaudeVersion() {
  try {
    return execSync(`${CLAUDE_BINARY} --version 2>/dev/null`, { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

// Send SSE event
function sendSSE(res, type, data) {
  const event = JSON.stringify({ type, data: typeof data === 'string' ? data : JSON.stringify(data) });
  res.write(`data: ${event}\n\n`);
}

// ── Route Handlers ──────────────────────────────────────────────────

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    relayVersion: RELAY_VERSION,
    claudeVersion: getClaudeVersion(),
    nodeVersion: process.version,
    uptime: process.uptime(),
  }));
}

async function handleChatMessages(req, res) {
  const body = await parseBody(req);
  const { prompt, sessionId, sdkSessionId, workingDirectory, model, mode, permissionMode } = body;

  if (!prompt || !sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'prompt and sessionId are required' }));
    return;
  }

  // Set up SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const abortController = { aborted: false };

  // Build claude CLI arguments
  const args = ['--output-format', 'stream-json', '--verbose'];

  if (model) args.push('--model', model);
  if (sdkSessionId) args.push('--resume', sdkSessionId);
  if (permissionMode) args.push('--permission-mode', permissionMode);

  // Add the prompt as the last argument
  args.push('-p', prompt);

  const cwd = workingDirectory || process.env.HOME || '/tmp';

  relayLog(`=== CHAT: sessionId=${sessionId} cwd=${cwd}`);
  relayLog(`  CLAUDE_BINARY=${CLAUDE_BINARY}`);
  relayLog(`  args=${JSON.stringify(args)}`);
  relayLog(`  PATH=${process.env.PATH}`);

  // Spawn claude CLI process
  const proc = spawn(CLAUDE_BINARY, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  activeSessions.set(sessionId, { process: proc, abortController });

  let buffer = '';

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        // Map claude CLI events to SSE format
        if (event.type === 'assistant' && event.message) {
          // Process content blocks
          for (const block of (event.message.content || [])) {
            if (block.type === 'text') {
              sendSSE(res, 'text', block.text);
            } else if (block.type === 'tool_use') {
              sendSSE(res, 'tool_use', { id: block.id, name: block.name, input: block.input });
            } else if (block.type === 'tool_result') {
              sendSSE(res, 'tool_result', { tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error });
            }
          }
          // Send usage info
          if (event.message.usage) {
            sendSSE(res, 'result', { usage: event.message.usage, session_id: event.session_id });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            sendSSE(res, 'text', event.delta.text);
          }
        } else if (event.type === 'result') {
          sendSSE(res, 'result', {
            usage: event.usage,
            session_id: event.session_id,
            is_error: event.is_error,
          });
        } else if (event.type === 'error') {
          sendSSE(res, 'error', event.error?.message || 'Unknown error');
        } else if (event.type === 'system' && event.session_id) {
          sendSSE(res, 'status', { session_id: event.session_id, model: event.model });
        }
      } catch {
        // Not JSON or malformed — skip
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.trim()) {
      sendSSE(res, 'tool_output', text);
    }
  });

  proc.on('close', (code) => {
    relayLog(`  Process closed with code ${code}`);
    activeSessions.delete(sessionId);
    if (code !== 0 && !abortController.aborted) {
      sendSSE(res, 'error', `Process exited with code ${code}`);
    }
    sendSSE(res, 'done', '');
    res.end();
  });

  proc.on('error', (err) => {
    relayLog(`  Process error: ${err.message}`);
    activeSessions.delete(sessionId);
    sendSSE(res, 'error', err.message);
    sendSSE(res, 'done', '');
    res.end();
  });

  // Handle client disconnect
  req.on('close', () => {
    if (!proc.killed) {
      abortController.aborted = true;
      proc.kill('SIGTERM');
    }
  });
}

async function handleChatAbort(req, res) {
  const body = await parseBody(req);
  const { sessionId } = body;
  const session = activeSessions.get(sessionId);

  if (session) {
    session.abortController.aborted = true;
    session.process.kill('SIGTERM');
    activeSessions.delete(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
  }
}

function handleFilesTree(req, res) {
  const query = parseQuery(req.url);
  const dir = query.dir || process.env.HOME || '/tmp';
  const depth = parseInt(query.depth || '3', 10);

  try {
    const tree = buildFileTree(dir, depth);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tree, root: dir }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function buildFileTree(dir, maxDepth, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const nodes = [];

    for (const entry of entries) {
      // Skip hidden files and common ignore patterns
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;

      const fullPath = path.join(dir, entry.name);
      const node = {
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
      };

      if (entry.isDirectory()) {
        node.children = buildFileTree(fullPath, maxDepth, currentDepth + 1);
      } else {
        try {
          const stat = fs.statSync(fullPath);
          node.size = stat.size;
          node.extension = path.extname(entry.name).slice(1);
        } catch { /* ignore stat errors */ }
      }

      nodes.push(node);
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

function handleFilesRead(req, res) {
  const query = parseQuery(req.url);
  const filePath = query.path;

  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'path parameter is required' }));
    return;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const stat = fs.statSync(filePath);
    const hash = crypto.createHash('md5').update(content).digest('hex');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      path: filePath,
      content,
      hash,
      size: stat.size,
      language: path.extname(filePath).slice(1),
      line_count: content.split('\n').length,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleFilesWrite(req, res) {
  const body = await parseBody(req);
  const { path: filePath, content } = body;

  if (!filePath || content === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'path and content are required' }));
    return;
  }

  try {
    fs.writeFileSync(filePath, content);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function handleExec(req, res) {
  const body = await parseBody(req);
  const { command, cwd } = body;

  if (!command) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'command is required' }));
    return;
  }

  try {
    const result = execSync(command, {
      cwd: cwd || process.env.HOME,
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stdout: result, code: 0 }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status || 1,
    }));
  }
}

function handleGitStatus(req, res) {
  const query = parseQuery(req.url);
  const dir = query.dir || process.env.HOME;

  try {
    // Check if directory is a git repo
    const repoRoot = execSync('git rev-parse --show-toplevel', { cwd: dir, encoding: 'utf-8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf-8' }).trim();

    let upstream = '';
    let ahead = 0;
    let behind = 0;
    try {
      upstream = execSync('git rev-parse --abbrev-ref @{upstream}', { cwd: dir, encoding: 'utf-8' }).trim();
      const counts = execSync('git rev-list --left-right --count HEAD...@{upstream}', { cwd: dir, encoding: 'utf-8' }).trim();
      const [a, b] = counts.split('\t').map(Number);
      ahead = a;
      behind = b;
    } catch { /* no upstream */ }

    const statusOutput = execSync('git status --porcelain=2 --branch', { cwd: dir, encoding: 'utf-8' });
    const changedFiles = [];
    const lines = statusOutput.split('\n');
    for (const line of lines) {
      if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const parts = line.split(' ');
        const xy = parts[1];
        const filePath = parts[parts.length - 1];
        const staged = xy[0] !== '.';
        let status = 'modified';
        if (xy.includes('A')) status = 'added';
        else if (xy.includes('D')) status = 'deleted';
        else if (xy.includes('R')) status = 'renamed';
        changedFiles.push({ path: filePath, status, staged });
      } else if (line.startsWith('? ')) {
        changedFiles.push({ path: line.slice(2), status: 'untracked', staged: false });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      isRepo: true,
      repoRoot,
      branch,
      upstream,
      ahead,
      behind,
      dirty: changedFiles.length > 0,
      changedFiles,
    }));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ isRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, dirty: false, changedFiles: [] }));
  }
}

function handleBrowseDirectories(req, res) {
  const query = parseQuery(req.url);
  const dir = query.dir || process.env.HOME || '/tmp';

  try {
    const resolvedDir = path.resolve(dir);
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    const directories = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(resolvedDir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      current: resolvedDir,
      parent: path.dirname(resolvedDir) !== resolvedDir ? path.dirname(resolvedDir) : null,
      directories,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Claude Sessions ─────────────────────────────────────────────────

function getClaudeProjectsDir() {
  return path.join(process.env.HOME || '/tmp', '.claude', 'projects');
}

function decodeProjectPath(encodedName) {
  if (!encodedName.startsWith('-')) return encodedName;
  return encodedName.replace(/^-/, '/').replace(/-/g, '/');
}

function handleClaudeSessions(req, res) {
  const projectsDir = getClaudeProjectsDir();
  if (!fs.existsSync(projectsDir)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }

  const sessions = [];
  try {
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = path.join(projectsDir, projectDir.name);
      const decodedPath = decodeProjectPath(projectDir.name);
      try {
        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        for (const jsonlFile of files) {
          const filePath = path.join(projectPath, jsonlFile);
          const sessionId = jsonlFile.replace('.jsonl', '');
          try {
            const stat = fs.statSync(filePath);
            if (stat.size > 50 * 1024 * 1024) continue;
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());
            if (lines.length === 0) continue;

            let cwd = '', gitBranch = '', version = '', preview = '';
            let createdAt = '', updatedAt = '';
            let userCount = 0, assistantCount = 0;

            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.timestamp) {
                  if (!createdAt) createdAt = entry.timestamp;
                  updatedAt = entry.timestamp;
                }
                if (entry.type === 'user') {
                  userCount++;
                  if (!cwd && entry.cwd) cwd = entry.cwd;
                  if (!gitBranch && entry.gitBranch) gitBranch = entry.gitBranch;
                  if (!version && entry.version) version = entry.version;
                  if (!preview && entry.message?.content) {
                    const mc = entry.message.content;
                    if (typeof mc === 'string') preview = mc.slice(0, 120);
                    else if (Array.isArray(mc)) {
                      const tb = mc.find(b => b.type === 'text');
                      if (tb?.text) preview = tb.text.slice(0, 120);
                    }
                  }
                } else if (entry.type === 'assistant') {
                  assistantCount++;
                }
              } catch { /* skip */ }
            }

            if (userCount === 0 && assistantCount === 0) continue;
            const effectivePath = cwd || decodedPath;
            sessions.push({
              sessionId, projectPath: effectivePath,
              projectName: path.basename(effectivePath),
              cwd: effectivePath, gitBranch, version,
              preview: preview || '(no preview)',
              userMessageCount: userCount, assistantMessageCount: assistantCount,
              createdAt: createdAt || stat.birthtime.toISOString(),
              updatedAt: updatedAt || stat.mtime.toISOString(),
              fileSize: stat.size,
            });
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sessions }));
}

function handleClaudeSessionRead(req, res) {
  const query = parseQuery(req.url);
  const sessionId = query.sessionId;
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'sessionId is required' }));
    return;
  }

  const projectsDir = getClaudeProjectsDir();
  if (!fs.existsSync(projectsDir)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No Claude sessions found' }));
    return;
  }

  // Find the session file
  let sessionFile = null;
  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const candidate = path.join(projectsDir, dir.name, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) { sessionFile = candidate; break; }
  }

  if (!sessionFile) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const content = fs.readFileSync(sessionFile, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────

async function main() {
  const port = await getAvailablePort();

  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    try {
      if (req.method === 'GET' && url === '/health') {
        handleHealth(req, res);
      } else if (req.method === 'POST' && url === '/chat/messages') {
        await handleChatMessages(req, res);
      } else if (req.method === 'POST' && url === '/chat/abort') {
        await handleChatAbort(req, res);
      } else if (req.method === 'GET' && url === '/files/tree') {
        handleFilesTree(req, res);
      } else if (req.method === 'GET' && url === '/files/read') {
        handleFilesRead(req, res);
      } else if (req.method === 'PUT' && url === '/files/write') {
        await handleFilesWrite(req, res);
      } else if (req.method === 'POST' && url === '/exec') {
        await handleExec(req, res);
      } else if (req.method === 'GET' && url === '/git/status') {
        handleGitStatus(req, res);
      } else if (req.method === 'GET' && url === '/files/browse') {
        handleBrowseDirectories(req, res);
      } else if (req.method === 'GET' && url === '/claude-sessions') {
        handleClaudeSessions(req, res);
      } else if (req.method === 'GET' && url === '/claude-sessions/read') {
        handleClaudeSessionRead(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
      }
    }
  });

  server.listen(port, '127.0.0.1', () => {
    // Write port file so the deployer can read it
    const portFile = path.join(__dirname, 'relay.port');
    fs.writeFileSync(portFile, String(port));
    relayLog(`v${RELAY_VERSION} listening on 127.0.0.1:${port}`);
    relayLog(`CLAUDE_BINARY=${CLAUDE_BINARY}`);
    relayLog(`PATH=${process.env.PATH}`);
    relayLog(`http_proxy=${process.env.http_proxy || process.env.HTTP_PROXY || '(not set)'}`);
    relayLog(`https_proxy=${process.env.https_proxy || process.env.HTTPS_PROXY || '(not set)'}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[codepilot-relay] Shutting down...');
    for (const [, session] of activeSessions) {
      try { session.process.kill('SIGTERM'); } catch { /* ignore */ }
    }
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[codepilot-relay] Fatal error:', err);
  process.exit(1);
});
