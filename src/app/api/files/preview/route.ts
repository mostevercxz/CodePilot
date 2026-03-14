import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import os from 'os';
import { readFilePreview, isPathSafe, isRootPath } from '@/lib/files';
import type { FilePreviewResponse, ErrorResponse } from '@/types';
import { sshManager } from '@/lib/remote/ssh-manager';
import { getCachedFile, setCachedFile } from '@/lib/remote/remote-cache';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get('path');
  const maxLines = parseInt(searchParams.get('maxLines') || '200', 10);
  const connectionId = searchParams.get('connection_id');

  if (!filePath) {
    return NextResponse.json<ErrorResponse>(
      { error: 'Missing path parameter' },
      { status: 400 }
    );
  }

  // Remote file preview: serve from cache or fetch from relay
  if (connectionId) {
    const cached = getCachedFile(connectionId, filePath);
    if (cached !== null) {
      const lines = cached.split('\n');
      const content = lines.slice(0, Math.min(maxLines, 1000)).join('\n');
      return NextResponse.json<FilePreviewResponse>({
        preview: {
          path: filePath,
          content,
          language: path.extname(filePath).slice(1) || '',
          line_count: lines.length,
        },
      });
    }

    const tunnelPort = sshManager.getTunnelPort(connectionId);
    if (!tunnelPort) {
      return NextResponse.json<ErrorResponse>({ error: 'Not connected to remote' }, { status: 400 });
    }

    try {
      const resp = await fetch(`http://127.0.0.1:${tunnelPort}/files/read?path=${encodeURIComponent(filePath)}`);
      const data = await resp.json();
      if (data.error) {
        return NextResponse.json<ErrorResponse>({ error: data.error }, { status: 500 });
      }
      setCachedFile(connectionId, filePath, data.content, data.hash || '');
      const lines = (data.content as string).split('\n');
      const content = lines.slice(0, Math.min(maxLines, 1000)).join('\n');
      return NextResponse.json<FilePreviewResponse>({
        preview: {
          path: filePath,
          content,
          language: data.language || path.extname(filePath).slice(1) || '',
          line_count: lines.length,
        },
      });
    } catch (error) {
      return NextResponse.json<ErrorResponse>(
        { error: error instanceof Error ? error.message : 'Failed to read remote file' },
        { status: 500 }
      );
    }
  }

  const resolvedPath = path.resolve(filePath);
  const homeDir = os.homedir();

  // Validate that the file is within the session's working directory.
  // baseDir may be on a different drive than homeDir on Windows.
  // Only reject root paths as baseDir to prevent full-disk access.
  const baseDir = searchParams.get('baseDir');
  if (baseDir) {
    const resolvedBase = path.resolve(baseDir);
    if (isRootPath(resolvedBase)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'Cannot use filesystem root as base directory' },
        { status: 403 }
      );
    }
    if (!isPathSafe(resolvedBase, resolvedPath)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'File is outside the project scope' },
        { status: 403 }
      );
    }
  } else {
    // Fallback: without a baseDir, restrict to the user's home directory
    // to prevent reading arbitrary system files like /etc/passwd
    if (!isPathSafe(homeDir, resolvedPath)) {
      return NextResponse.json<ErrorResponse>(
        { error: 'File is outside the allowed scope' },
        { status: 403 }
      );
    }
  }

  try {
    const preview = await readFilePreview(resolvedPath, Math.min(maxLines, 1000));
    return NextResponse.json<FilePreviewResponse>({ preview });
  } catch (error) {
    return NextResponse.json<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Failed to read file' },
      { status: 500 }
    );
  }
}
