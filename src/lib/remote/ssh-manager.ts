import type { Client, ConnectConfig, ClientChannel } from 'ssh2';
import type { RemoteConnection, RemoteConnectionRuntime, RemoteConnectionStatus } from '@/types';
import { getRemoteConnection, updateRemoteConnectionLastConnected } from '@/lib/db';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deployRelay, RELAY_VERSION } from './relay-deploy';

interface ManagedConnection {
  ssh: Client;
  runtime: RemoteConnectionRuntime;
  tunnelPort: number | null;
  relayPort: number | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  listeners: Set<(runtime: RemoteConnectionRuntime) => void>;
}

type SSHManagerGlobal = {
  __sshManager?: SSHManager;
};

class SSHManager {
  private connections = new Map<string, ManagedConnection>();

  private emitStatus(connId: string, status: RemoteConnectionStatus, error: string | null = null) {
    const managed = this.connections.get(connId);
    if (!managed) return;
    managed.runtime = {
      ...managed.runtime,
      status,
      error,
      tunnelPort: managed.tunnelPort,
      connectedAt: status === 'connected' ? Date.now() : managed.runtime.connectedAt,
    };
    for (const listener of managed.listeners) {
      try { listener(managed.runtime); } catch { /* ignore */ }
    }
  }

  async connect(connectionId: string): Promise<RemoteConnectionRuntime> {
    const existing = this.connections.get(connectionId);
    if (existing?.runtime.status === 'connected') {
      return existing.runtime;
    }

    const connConfig = getRemoteConnection(connectionId);
    if (!connConfig) {
      throw new Error(`Remote connection ${connectionId} not found`);
    }

    // Initialize managed connection
    const { Client: SSH2Client } = await import('ssh2');
    const ssh = new SSH2Client();
    const managed: ManagedConnection = {
      ssh,
      runtime: {
        connectionId,
        status: 'connecting',
        tunnelPort: null,
        error: null,
        connectedAt: null,
      },
      tunnelPort: null,
      relayPort: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      listeners: existing?.listeners || new Set(),
    };
    this.connections.set(connectionId, managed);
    this.emitStatus(connectionId, 'connecting');

    try {
      // Build SSH config
      const sshConfig = this.buildSSHConfig(connConfig);

      // Connect SSH
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SSH connection timed out')), 30000);
        ssh.on('ready', () => {
          clearTimeout(timeout);
          resolve();
        });
        ssh.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
        ssh.connect(sshConfig);
      });

      // Deploy relay if needed and get its port
      const relayPort = await deployRelay(ssh, connConfig);
      managed.relayPort = relayPort;

      // Create SSH tunnel: local random port → remote relay port
      const tunnelPort = await this.createTunnel(ssh, relayPort);
      managed.tunnelPort = tunnelPort;

      // Set up disconnect handler
      ssh.on('close', () => {
        this.handleDisconnect(connectionId);
      });
      ssh.on('end', () => {
        this.handleDisconnect(connectionId);
      });

      managed.reconnectAttempts = 0;
      this.emitStatus(connectionId, 'connected');
      updateRemoteConnectionLastConnected(connectionId);

      return managed.runtime;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitStatus(connectionId, 'error', message);
      try { ssh.end(); } catch { /* ignore */ }
      throw err;
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    const managed = this.connections.get(connectionId);
    if (!managed) return;

    if (managed.reconnectTimer) {
      clearTimeout(managed.reconnectTimer);
      managed.reconnectTimer = null;
    }

    try { managed.ssh.end(); } catch { /* ignore */ }
    this.emitStatus(connectionId, 'disconnected');
    this.connections.delete(connectionId);
  }

  async exec(connectionId: string, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const managed = this.connections.get(connectionId);
    if (!managed || managed.runtime.status !== 'connected') {
      throw new Error(`Not connected to ${connectionId}`);
    }

    return new Promise((resolve, reject) => {
      managed.ssh.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        stream.on('close', (code: number) => {
          resolve({ stdout, stderr, code: code || 0 });
        });
      });
    });
  }

  getStatus(connectionId: string): RemoteConnectionRuntime {
    const managed = this.connections.get(connectionId);
    if (!managed) {
      return {
        connectionId,
        status: 'disconnected',
        tunnelPort: null,
        error: null,
        connectedAt: null,
      };
    }
    return { ...managed.runtime };
  }

  getTunnelPort(connectionId: string): number | null {
    return this.connections.get(connectionId)?.tunnelPort || null;
  }

  onStatusChange(connectionId: string, listener: (runtime: RemoteConnectionRuntime) => void): () => void {
    let managed = this.connections.get(connectionId);
    if (!managed) {
      managed = {
        ssh: null as unknown as Client,
        runtime: { connectionId, status: 'disconnected', tunnelPort: null, error: null, connectedAt: null },
        tunnelPort: null,
        relayPort: null,
        reconnectTimer: null,
        reconnectAttempts: 0,
        listeners: new Set(),
      };
      this.connections.set(connectionId, managed);
    }
    managed.listeners.add(listener);
    return () => { managed.listeners.delete(listener); };
  }

  private buildSSHConfig(conn: RemoteConnection): ConnectConfig {
    // SSH debug log file
    const logPath = path.join(os.homedir(), '.codepilot', 'ssh-debug.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const timestamp = () => new Date().toISOString();
    logStream.write(`\n${'='.repeat(60)}\n[${timestamp()}] SSH connect to ${conn.username}@${conn.host}:${conn.port} auth=${conn.auth_method}\n`);

    const config: ConnectConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      readyTimeout: 30000,
      keepaliveInterval: 10000,
      debug: (msg: string) => {
        logStream.write(`[${timestamp()}] ${msg}\n`);
      },
    };

    if (conn.auth_method === 'key') {
      const keyPath = conn.private_key_path || path.join(os.homedir(), '.ssh', 'id_rsa');
      logStream.write(`[${timestamp()}] Key path: ${keyPath}, exists: ${fs.existsSync(keyPath)}\n`);
      if (fs.existsSync(keyPath)) {
        config.privateKey = fs.readFileSync(keyPath);
        logStream.write(`[${timestamp()}] Key loaded, ${config.privateKey.length} bytes\n`);
      } else {
        logStream.write(`[${timestamp()}] WARNING: Key file not found!\n`);
      }
    } else if (conn.auth_method === 'password') {
      // Password is stored encrypted; decrypt it
      if (conn.password_encrypted) {
        config.password = decryptPassword(conn.password_encrypted);
        logStream.write(`[${timestamp()}] Password decrypted, length: ${config.password?.length}\n`);
      } else {
        logStream.write(`[${timestamp()}] WARNING: No encrypted password stored!\n`);
      }
    } else if (conn.auth_method === 'agent') {
      config.agent = process.env.SSH_AUTH_SOCK;
      logStream.write(`[${timestamp()}] SSH_AUTH_SOCK: ${process.env.SSH_AUTH_SOCK || 'NOT SET'}\n`);
    }

    return config;
  }

  private async createTunnel(ssh: Client, remotePort: number): Promise<number> {
    const net = await import('net');

    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        ssh.forwardOut(
          '127.0.0.1', sock.remotePort || 0,
          '127.0.0.1', remotePort,
          (err: Error | undefined, stream: ClientChannel) => {
            if (err) {
              sock.end();
              return;
            }
            sock.pipe(stream).pipe(sock);
          }
        );
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to get tunnel port'));
        }
      });

      server.on('error', reject);
    });
  }

  private handleDisconnect(connectionId: string) {
    const managed = this.connections.get(connectionId);
    if (!managed) return;
    if (managed.runtime.status === 'disconnected') return;

    this.emitStatus(connectionId, 'disconnected');

    // Auto-reconnect with exponential backoff (max 5 attempts)
    if (managed.reconnectAttempts < 5) {
      const delay = Math.min(1000 * Math.pow(2, managed.reconnectAttempts), 30000);
      managed.reconnectAttempts++;
      managed.reconnectTimer = setTimeout(async () => {
        try {
          await this.connect(connectionId);
        } catch {
          // Will retry automatically via handleDisconnect
        }
      }, delay);
    }
  }
}

// Singleton via globalThis
function getSSHManager(): SSHManager {
  const g = globalThis as SSHManagerGlobal;
  if (!g.__sshManager) {
    g.__sshManager = new SSHManager();
  }
  return g.__sshManager;
}

export const sshManager = getSSHManager();

// Password encryption/decryption using Node crypto
// Uses AES-256-GCM with a machine-specific key derived from hostname + username
function getEncryptionKey(): Buffer {
  const crypto = require('crypto') as typeof import('crypto');
  const material = `codepilot-${os.hostname()}-${os.userInfo().username}`;
  return crypto.createHash('sha256').update(material).digest();
}

export function encryptPassword(password: string): string {
  const crypto = require('crypto') as typeof import('crypto');
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptPassword(encrypted: string): string {
  const crypto = require('crypto') as typeof import('crypto');
  const key = getEncryptionKey();
  const data = Buffer.from(encrypted, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
