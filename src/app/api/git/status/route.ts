import { NextRequest, NextResponse } from 'next/server';
import * as gitService from '@/lib/git/service';
import { sshManager } from '@/lib/remote/ssh-manager';
import { getCachedGitStatus, setCachedGitStatus } from '@/lib/remote/remote-cache';

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get('cwd');
  const connectionId = req.nextUrl.searchParams.get('connection_id');

  if (!cwd) {
    return NextResponse.json({ error: 'cwd is required' }, { status: 400 });
  }

  // Remote git status: cache-first with short TTL
  if (connectionId) {
    const cached = getCachedGitStatus(connectionId, cwd);
    if (cached) return NextResponse.json(cached);

    const tunnelPort = sshManager.getTunnelPort(connectionId);
    if (!tunnelPort) {
      return NextResponse.json({ error: 'Not connected to remote' }, { status: 400 });
    }

    try {
      const resp = await fetch(`http://127.0.0.1:${tunnelPort}/git/status?dir=${encodeURIComponent(cwd)}`);
      const data = await resp.json();
      setCachedGitStatus(connectionId, cwd, data);
      return NextResponse.json(data);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to get remote git status' },
        { status: 500 }
      );
    }
  }

  try {
    const status = await gitService.getStatus(cwd);
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to get git status' },
      { status: 500 }
    );
  }
}
