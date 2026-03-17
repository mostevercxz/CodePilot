import type { Client, SFTPWrapper } from 'ssh2';
import type { RemoteConnection } from '@/types';
import fs from 'fs';
import path from 'path';

export const RELAY_VERSION = '1.5.0';
const RELAY_DIR = '~/.codepilot-relay';
const RELAY_SCRIPT = 'relay.js';

/**
 * Deploy the relay script to the remote server if needed, then start it.
 * Returns the port the relay is listening on.
 */
export async function deployRelay(ssh: Client, conn: RemoteConnection): Promise<number> {
  // Check if relay is already running with correct version
  const existing = await checkExistingRelay(ssh);
  if (existing) {
    return existing;
  }

  // Ensure relay directory exists
  await sshExec(ssh, `mkdir -p ${RELAY_DIR}`);

  // Upload relay script via SFTP
  // Try multiple locations: process.cwd() is project root in both dev and production
  const candidates = [
    path.join(process.cwd(), 'src', 'lib', 'remote', 'relay-server.js'),       // dev mode
    path.join(process.cwd(), 'resources', 'standalone', 'relay-server.js'),     // packaged electron
    path.join(__dirname, 'relay-server.js'),                                     // co-located (production build)
    path.resolve(__dirname, '..', '..', '..', 'src', 'lib', 'remote', 'relay-server.js'),
  ];
  let relayContent: string | undefined;
  let foundAt = '';
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        relayContent = fs.readFileSync(candidate, 'utf-8');
        foundAt = candidate;
        break;
      }
    } catch { /* skip */ }
  }
  if (!relayContent) {
    throw new Error('Relay script not found. Searched:\n' + candidates.join('\n'));
  }
  console.log(`[relay-deploy] Found relay script at: ${foundAt}`);

  await uploadFile(ssh, `${RELAY_DIR}/${RELAY_SCRIPT}`, relayContent);

  // Kill any existing relay process
  await sshExec(ssh, `pkill -f "node.*relay\\.js" 2>/dev/null; pkill -f "node.*codepilot-relay" 2>/dev/null; sleep 0.5; rm -f ${RELAY_DIR}/relay.port; true`);

  // Source user profile to get PATH (nvm, etc.) for non-interactive SSH sessions.
  // Many .bashrc files have an early `return` for non-interactive shells,
  // so we also eval export lines directly from .bashrc as a fallback.
  const sourceProfile = [
    'source ~/.profile 2>/dev/null',
    'source ~/.nvm/nvm.sh 2>/dev/null',
    // Force-eval export lines from .bashrc even in non-interactive mode
    'eval "$(grep -E "^export\\s+" ~/.bashrc 2>/dev/null)" 2>/dev/null',
  ].join('; ') + ';';

  // Resolve claude to the real binary (skip shell wrappers).
  // Handles both command names ("claude") and full paths ("/home/user/.local/bin/claude").
  const claudePathInput = conn.claude_binary_path || 'claude';
  const resolveResult = await sshExec(ssh, `
    ${sourceProfile}
    INPUT="${claudePathInput}"
    CANDIDATES=""
    # If input is a full path, use it directly; otherwise use which
    case "$INPUT" in
      /*) [ -x "$INPUT" ] && CANDIDATES="$INPUT" ;;
      *)  CANDIDATES=$(which -a "$INPUT" 2>/dev/null) ;;
    esac
    # Also search nvm bin dirs for the base command name
    BASE=$(basename "$INPUT")
    for d in $HOME/.nvm/versions/node/*/bin; do
      [ -x "$d/$BASE" ] && CANDIDATES="$CANDIDATES $d/$BASE"
    done
    # Pick the first non-script candidate
    for c in $CANDIDATES; do
      ftype=$(file -b "$c" 2>/dev/null)
      case "$ftype" in *script*) ;; *) echo "$c"; exit 0 ;; esac
    done
    # Fallback: first candidate even if it's a script
    for c in $CANDIDATES; do echo "$c"; exit 0; done
    echo "NOT_FOUND"
  `);
  const claudePath = resolveResult.trim().split('\n').pop()?.trim() || '';
  if (claudePath === 'NOT_FOUND' || claudePath === '') {
    throw new Error(`Claude CLI not found on remote at "${claudePathInput}".`);
  }
  console.log(`[relay-deploy] Remote claude path: ${claudePath}`);

  // Find node: search nvm bin dirs explicitly
  const nodeResolve = await sshExec(ssh, `
    ${sourceProfile}
    NODE=$(which node 2>/dev/null)
    if [ -n "$NODE" ]; then echo "$NODE"; exit 0; fi
    for d in $HOME/.nvm/versions/node/*/bin; do
      [ -x "$d/node" ] && echo "$d/node" && exit 0
    done
    echo "NOT_FOUND"
  `);
  const nodePath = nodeResolve.trim().split('\n').pop()?.trim() || '';
  if (nodePath === 'NOT_FOUND' || nodePath === '') {
    throw new Error('Node.js not found on remote. Make sure node is installed.');
  }
  console.log(`[relay-deploy] Remote node path: ${nodePath}`);

  const nvmBinDir = nodePath.substring(0, nodePath.lastIndexOf('/'));

  // Build env vars string from connection config for the relay process
  let envVars: Record<string, string> = {};
  try { envVars = JSON.parse(conn.env_vars || '{}'); } catch { /* ignore */ }
  const envExports = Object.entries(envVars)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  console.log(`[relay-deploy] Env vars: ${envExports || '(none)'}`);

  // Start relay with nvm PATH + connection env vars
  const startResult = await sshExec(ssh,
    `${sourceProfile} cd ${RELAY_DIR} && PATH="${nvmBinDir}:$PATH" ${envExports} CLAUDE_BINARY="${claudePath}" nohup ${nodePath} ${RELAY_SCRIPT} > relay.log 2>&1 & sleep 1 && cat relay.port 2>/dev/null || echo "FAILED"`
  );

  const port = parseInt(startResult.trim(), 10);
  if (isNaN(port) || port <= 0) {
    // Try to get error from log
    const log = await sshExec(ssh, `cat ${RELAY_DIR}/relay.log 2>/dev/null || echo "No log"`);
    throw new Error(`Failed to start relay on remote. Log: ${log.trim()}`);
  }

  // Verify relay is healthy
  const healthCheck = await sshExec(ssh,
    `curl -s http://127.0.0.1:${port}/health 2>/dev/null || echo "UNREACHABLE"`
  );
  if (healthCheck.includes('UNREACHABLE')) {
    throw new Error('Relay started but health check failed');
  }

  return port;
}

async function checkExistingRelay(ssh: Client): Promise<number | null> {
  try {
    const portStr = await sshExec(ssh, `cat ${RELAY_DIR}/relay.port 2>/dev/null || echo ""`);
    const port = parseInt(portStr.trim(), 10);
    if (isNaN(port) || port <= 0) return null;

    // Check if relay is running and healthy
    const health = await sshExec(ssh,
      `curl -s http://127.0.0.1:${port}/health 2>/dev/null || echo "DOWN"`
    );
    if (health.includes('DOWN')) return null;

    try {
      const healthData = JSON.parse(health);
      if (healthData.relayVersion === RELAY_VERSION) {
        return port;
      }
      // Version mismatch — need to redeploy
      return null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function sshExec(ssh: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ssh.exec(command, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      stream.on('data', (data: Buffer) => { output += data.toString(); });
      stream.stderr.on('data', () => { /* ignore stderr */ });
      stream.on('close', () => resolve(output));
    });
  });
}

function uploadFile(ssh: Client, remotePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ssh.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
      if (err) return reject(err);

      // Expand ~ in path
      const expandedPath = remotePath.replace(/^~/, `/home/${(ssh as unknown as { config: { username: string } }).config?.username || 'user'}`);

      const writeStream = sftp.createWriteStream(expandedPath);
      writeStream.on('error', reject);
      writeStream.on('close', () => {
        sftp.end();
        resolve();
      });
      writeStream.end(content);
    });
  });
}
