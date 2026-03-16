import { NextRequest } from 'next/server';
import { getRemoteConnection } from '@/lib/db';
import { encryptPassword } from '@/lib/remote/ssh-manager';
import fs from 'fs';
import path from 'path';
import os from 'os';

function decryptPassword(encrypted: string): string {
  const crypto = require('crypto') as typeof import('crypto');
  const material = `codepilot-${os.hostname()}-${os.userInfo().username}`;
  const key = crypto.createHash('sha256').update(material).digest();
  const data = Buffer.from(encrypted, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const conn = getRemoteConnection(id);
    if (!conn) {
      return Response.json({ error: 'Connection not found' }, { status: 404 });
    }

    // Set up debug log file
    const dataDir = path.join(os.homedir(), '.codepilot');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const logPath = path.join(dataDir, 'ssh-debug.log');
    const logLines: string[] = [];
    const timestamp = () => new Date().toISOString();
    const log = (msg: string) => { logLines.push(`[${timestamp()}] ${msg}`); };

    log(`=== SSH TEST: ${conn.username}@${conn.host}:${conn.port} auth=${conn.auth_method} ===`);

    const { Client } = await import('ssh2');
    const ssh = new Client();

    const result = await new Promise<{ success: boolean; message: string; claudeVersion?: string; nodeVersion?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        log('TIMEOUT after 15s');
        ssh.end();
        resolve({ success: false, message: 'Connection timed out' });
      }, 15000);

      ssh.on('ready', () => {
        clearTimeout(timeout);
        log('SSH ready');

        ssh.exec('node --version && (claude --version 2>/dev/null || echo "claude: NOT_FOUND")', (err, stream) => {
          if (err) {
            log(`exec error: ${err.message}`);
            ssh.end();
            resolve({ success: false, message: `Command execution failed: ${err.message}` });
            return;
          }

          let output = '';
          stream.on('data', (data: Buffer) => { output += data.toString(); });
          stream.on('close', () => {
            log(`exec output: ${output.trim()}`);
            ssh.end();
            const lines = output.trim().split('\n');
            const nodeVersion = lines[0] || 'unknown';
            const claudeLine = lines[1] || '';
            const claudeFound = !claudeLine.includes('NOT_FOUND');

            resolve({
              success: true,
              message: claudeFound
                ? `Connected successfully. Node ${nodeVersion}, Claude ${claudeLine}`
                : `Connected, but Claude CLI not found. Node ${nodeVersion}. Please install Claude Code CLI on the remote.`,
              nodeVersion,
              claudeVersion: claudeFound ? claudeLine : undefined,
            });
          });
        });
      });

      ssh.on('error', (err: Error) => {
        clearTimeout(timeout);
        log(`SSH error: ${err.message}`);
        resolve({ success: false, message: `SSH connection failed: ${err.message}` });
      });

      const config: Record<string, unknown> = {
        host: conn.host,
        port: conn.port,
        username: conn.username,
        readyTimeout: 15000,
        debug: (msg: string) => { log(msg); },
      };

      if (conn.auth_method === 'key') {
        const keyPath = conn.private_key_path || path.join(os.homedir(), '.ssh', 'id_rsa');
        log(`Key path: ${keyPath}, exists: ${fs.existsSync(keyPath)}`);
        if (fs.existsSync(keyPath)) {
          config.privateKey = fs.readFileSync(keyPath);
          log(`Key loaded, ${(config.privateKey as Buffer).length} bytes`);
        } else {
          log('WARNING: Key file not found!');
        }
      } else if (conn.auth_method === 'password') {
        if (conn.password_encrypted) {
          try {
            config.password = decryptPassword(conn.password_encrypted);
            log(`Password decrypted OK, length: ${(config.password as string).length}`);
          } catch (e) {
            log(`Password decrypt FAILED: ${e instanceof Error ? e.message : e}`);
          }
        } else {
          log('WARNING: No encrypted password stored!');
        }
      } else if (conn.auth_method === 'agent') {
        config.agent = process.env.SSH_AUTH_SOCK;
        log(`SSH_AUTH_SOCK: ${process.env.SSH_AUTH_SOCK || 'NOT SET'}`);
      }

      log(`Connecting with config: host=${conn.host} port=${conn.port} user=${conn.username} auth=${conn.auth_method} hasKey=${!!config.privateKey} hasPassword=${!!config.password} hasAgent=${!!config.agent}`);
      ssh.connect(config);
    });

    // Write debug log to file
    fs.appendFileSync(logPath, logLines.join('\n') + '\n');
    log(`Debug log written to: ${logPath}`);

    return Response.json({ ...result, debugLogPath: logPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
