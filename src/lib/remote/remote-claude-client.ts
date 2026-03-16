import { sshManager } from './ssh-manager';
import { invalidateTree } from './remote-cache';
import fs from 'fs';
import path from 'path';
import os from 'os';

function getLogPath() {
  const dir = path.join(os.homedir(), '.codepilot');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'remote-chat.log');
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(getLogPath(), line); } catch { /* ignore */ }
}

interface RemoteStreamOptions {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;
  workingDirectory?: string;
  model?: string;
  mode?: string;
  permissionMode?: string;
  connectionId: string;
  abortController?: AbortController;
}

/**
 * Stream Claude response from a remote relay server.
 * Returns a ReadableStream<string> in the same SSE format as local streamClaude().
 */
export function streamClaudeRemote(options: RemoteStreamOptions): ReadableStream<string> {
  const { connectionId, abortController } = options;

  return new ReadableStream<string>({
    async start(controller) {
      const tunnelPort = sshManager.getTunnelPort(connectionId);
      log(`streamClaudeRemote: tunnelPort=${tunnelPort} connectionId=${connectionId}`);
      log(`  prompt=${options.prompt.slice(0, 200)} workDir=${options.workingDirectory}`);
      if (!tunnelPort) {
        log('ERROR: No tunnel port — not connected');
        controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: 'Not connected to remote server' })}\n\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'done', data: '' })}\n\n`);
        controller.close();
        return;
      }

      const relayUrl = `http://127.0.0.1:${tunnelPort}/chat/messages`;
      log(`POST ${relayUrl}`);

      try {
        const response = await fetch(relayUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: options.prompt,
            sessionId: options.sessionId,
            sdkSessionId: options.sdkSessionId,
            workingDirectory: options.workingDirectory,
            model: options.model,
            mode: options.mode,
            permissionMode: options.permissionMode,
          }),
          signal: abortController?.signal,
        });

        log(`Response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          log(`ERROR: Relay returned ${response.status}: ${errorText}`);
          controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: `Remote relay error: ${errorText}` })}\n\n`);
          controller.enqueue(`data: ${JSON.stringify({ type: 'done', data: '' })}\n\n`);
          controller.close();
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          log('ERROR: No response body from relay');
          controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: 'No response body from relay' })}\n\n`);
          controller.close();
          return;
        }

        const decoder = new TextDecoder();
        let totalChunks = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          totalChunks++;
          if (totalChunks <= 3) log(`Chunk #${totalChunks}: ${chunk.slice(0, 200)}`);
          controller.enqueue(chunk);
        }
        log(`Stream complete. Total chunks: ${totalChunks}`);

        // After stream completes, invalidate file tree cache (Claude may have written files)
        if (options.workingDirectory) {
          invalidateTree(connectionId, options.workingDirectory);
        }

        controller.close();
      } catch (err) {
        if (abortController?.signal.aborted) {
          // Abort the remote session too
          try {
            const abortUrl = `http://127.0.0.1:${tunnelPort}/chat/abort`;
            fetch(abortUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: options.sessionId }),
            }).catch(() => { /* best effort */ });
          } catch { /* ignore */ }
        }

        const message = err instanceof Error ? err.message : String(err);
        try {
          controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: message })}\n\n`);
          controller.enqueue(`data: ${JSON.stringify({ type: 'done', data: '' })}\n\n`);
          controller.close();
        } catch { /* controller may already be closed */ }
      }
    },
  });
}
