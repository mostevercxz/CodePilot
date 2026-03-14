import { NextRequest } from 'next/server';
import { sshManager } from '@/lib/remote/ssh-manager';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const dir = request.nextUrl.searchParams.get('dir') || '~';

    const tunnelPort = sshManager.getTunnelPort(id);
    if (!tunnelPort) {
      return Response.json({ error: 'Not connected' }, { status: 400 });
    }

    const response = await fetch(
      `http://127.0.0.1:${tunnelPort}/files/browse?dir=${encodeURIComponent(dir)}`
    );
    const data = await response.json();
    return Response.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
