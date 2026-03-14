import { NextRequest } from 'next/server';
import { sshManager } from '@/lib/remote/ssh-manager';
import { getCacheStats } from '@/lib/remote/remote-cache';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const runtime = sshManager.getStatus(id);
    const cache = getCacheStats(id);
    return Response.json({ runtime, cache });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
