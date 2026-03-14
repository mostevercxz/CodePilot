import { NextRequest } from 'next/server';
import { getRemoteConnection, updateRemoteConnection, deleteRemoteConnection } from '@/lib/db';
import { sshManager, encryptPassword } from '@/lib/remote/ssh-manager';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const connection = getRemoteConnection(id);
    if (!connection) {
      return Response.json({ error: 'Connection not found' }, { status: 404 });
    }
    return Response.json({ connection });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();

    // Handle password update
    const updateData: Record<string, unknown> = { ...body };
    if (body.password) {
      updateData.password_encrypted = encryptPassword(body.password);
      delete updateData.password;
    }

    const connection = updateRemoteConnection(id, updateData);
    if (!connection) {
      return Response.json({ error: 'Connection not found' }, { status: 404 });
    }
    return Response.json({ connection });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // Disconnect first if connected
    await sshManager.disconnect(id);
    const deleted = deleteRemoteConnection(id);
    if (!deleted) {
      return Response.json({ error: 'Connection not found' }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
