import { NextRequest } from 'next/server';
import { sshManager } from '@/lib/remote/ssh-manager';
import { getCachedFile, setCachedFile } from '@/lib/remote/remote-cache';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const filePath = request.nextUrl.searchParams.get('path');

    if (!filePath) {
      return Response.json({ error: 'path is required' }, { status: 400 });
    }

    // Try cache first
    const cached = getCachedFile(id, filePath);
    if (cached !== null) {
      return Response.json({
        path: filePath,
        content: cached,
        fromCache: true,
      });
    }

    // Fetch from relay
    const tunnelPort = sshManager.getTunnelPort(id);
    if (!tunnelPort) {
      return Response.json({ error: 'Not connected' }, { status: 400 });
    }

    const response = await fetch(
      `http://127.0.0.1:${tunnelPort}/files/read?path=${encodeURIComponent(filePath)}`
    );
    const data = await response.json();

    if (data.error) {
      return Response.json({ error: data.error }, { status: 500 });
    }

    // Cache the file content
    setCachedFile(id, filePath, data.content, data.hash || '');

    return Response.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
