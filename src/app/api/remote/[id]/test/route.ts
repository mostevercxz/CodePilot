import { NextRequest } from 'next/server';
import { getRemoteConnection } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const conn = getRemoteConnection(id);
    if (!conn) {
      return Response.json({ error: 'Connection not found' }, { status: 404 });
    }

    const { Client } = await import('ssh2');
    const ssh = new Client();

    const result = await new Promise<{ success: boolean; message: string; claudeVersion?: string; nodeVersion?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        ssh.end();
        resolve({ success: false, message: 'Connection timed out' });
      }, 15000);

      ssh.on('ready', () => {
        clearTimeout(timeout);

        ssh.exec('node --version && (claude --version 2>/dev/null || echo "claude: NOT_FOUND")', (err, stream) => {
          if (err) {
            ssh.end();
            resolve({ success: false, message: `Command execution failed: ${err.message}` });
            return;
          }

          let output = '';
          stream.on('data', (data: Buffer) => { output += data.toString(); });
          stream.on('close', () => {
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
        resolve({ success: false, message: `SSH connection failed: ${err.message}` });
      });

      const config: Record<string, unknown> = {
        host: conn.host,
        port: conn.port,
        username: conn.username,
        readyTimeout: 15000,
      };

      if (conn.auth_method === 'key') {
        const keyPath = conn.private_key_path || path.join(os.homedir(), '.ssh', 'id_rsa');
        if (fs.existsSync(keyPath)) {
          config.privateKey = fs.readFileSync(keyPath);
        }
      } else if (conn.auth_method === 'agent') {
        config.agent = process.env.SSH_AUTH_SOCK;
      }

      ssh.connect(config);
    });

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
