import type { Client, SFTPWrapper } from 'ssh2';
import type { RemoteConnection } from '@/types';
import fs from 'fs';
import path from 'path';

export const RELAY_VERSION = '1.0.0';
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
  const relaySource = path.join(__dirname, 'relay-server.js');
  let relayContent: string;

  if (fs.existsSync(relaySource)) {
    relayContent = fs.readFileSync(relaySource, 'utf-8');
  } else {
    // In development, the file might be at a different location
    const devSource = path.resolve(__dirname, '..', '..', '..', 'src', 'lib', 'remote', 'relay-server.js');
    if (fs.existsSync(devSource)) {
      relayContent = fs.readFileSync(devSource, 'utf-8');
    } else {
      throw new Error('Relay script not found. Expected at: ' + relaySource);
    }
  }

  await uploadFile(ssh, `${RELAY_DIR}/${RELAY_SCRIPT}`, relayContent);

  // Kill any existing relay process
  await sshExec(ssh, `pkill -f "node.*codepilot-relay" 2>/dev/null || true`);

  // Verify Claude CLI is accessible
  const claudePath = conn.claude_binary_path || 'claude';
  const whichResult = await sshExec(ssh, `which ${claudePath} 2>/dev/null || echo "NOT_FOUND"`);
  if (whichResult.trim() === 'NOT_FOUND') {
    throw new Error(`Claude CLI not found on remote at "${claudePath}". Please install Claude Code CLI or specify the correct path.`);
  }

  // Start relay on a random available port
  const startResult = await sshExec(ssh,
    `cd ${RELAY_DIR} && CLAUDE_BINARY="${claudePath}" nohup node ${RELAY_SCRIPT} > relay.log 2>&1 & sleep 1 && cat relay.port 2>/dev/null || echo "FAILED"`
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
