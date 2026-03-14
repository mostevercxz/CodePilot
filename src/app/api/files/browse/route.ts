import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ErrorResponse } from '@/types';
import { sshManager } from '@/lib/remote/ssh-manager';

async function getWindowsDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const drives: string[] = [];
  for (let i = 65; i <= 90; i++) {
    const drive = String.fromCharCode(i) + ':\\';
    try {
      await fs.access(drive);
      drives.push(drive);
    } catch {
      // drive not available
    }
  }
  return drives;
}

// List only directories for folder browsing (no safety restriction since user is choosing where to work)
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const connectionId = searchParams.get('connection_id');

  // Remote directory browsing
  if (connectionId) {
    const dir = searchParams.get('dir') || '~';
    const tunnelPort = sshManager.getTunnelPort(connectionId);
    if (!tunnelPort) {
      return NextResponse.json<ErrorResponse>({ error: 'Not connected to remote' }, { status: 400 });
    }
    try {
      const resp = await fetch(`http://127.0.0.1:${tunnelPort}/files/browse?dir=${encodeURIComponent(dir)}`);
      const data = await resp.json();
      return NextResponse.json(data);
    } catch (error) {
      return NextResponse.json<ErrorResponse>(
        { error: error instanceof Error ? error.message : 'Failed to browse remote' },
        { status: 500 }
      );
    }
  }

  const dir = searchParams.get('dir') || os.homedir();

  const resolvedDir = path.resolve(dir);

  try {
    await fs.access(resolvedDir);
  } catch {
    return NextResponse.json<ErrorResponse>(
      { error: 'Directory does not exist' },
      { status: 404 }
    );
  }

  try {
    const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(resolvedDir, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const drives = await getWindowsDrives();

    return NextResponse.json({
      current: resolvedDir,
      parent: path.dirname(resolvedDir) !== resolvedDir ? path.dirname(resolvedDir) : null,
      directories,
      drives,
    });
  } catch {
    return NextResponse.json<ErrorResponse>(
      { error: 'Cannot read directory' },
      { status: 500 }
    );
  }
}
