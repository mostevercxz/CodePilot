import { NextRequest } from 'next/server';
import { listClaudeSessions } from '@/lib/claude-session-parser';
import { sshManager } from '@/lib/remote/ssh-manager';

export async function GET(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get('connection_id');

    // Remote: fetch sessions from relay
    if (connectionId) {
      const tunnelPort = sshManager.getTunnelPort(connectionId);
      if (!tunnelPort) {
        return Response.json({ error: 'Not connected to remote' }, { status: 400 });
      }
      const resp = await fetch(`http://127.0.0.1:${tunnelPort}/claude-sessions`);
      const data = await resp.json();
      return Response.json(data);
    }

    // Local
    const sessions = listClaudeSessions();
    return Response.json({ sessions });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[GET /api/claude-sessions] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
