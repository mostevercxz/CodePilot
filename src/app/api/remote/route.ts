import { NextRequest } from 'next/server';
import { listRemoteConnections, createRemoteConnection } from '@/lib/db';
import { encryptPassword } from '@/lib/remote/ssh-manager';

export async function GET() {
  try {
    const connections = listRemoteConnections();
    return Response.json({ connections });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, host, port, username, auth_method, private_key_path, password, claude_binary_path, default_working_directory, env_vars } = body;

    if (!name || !host || !username) {
      return Response.json({ error: 'name, host, and username are required' }, { status: 400 });
    }

    const connection = createRemoteConnection({
      name,
      host,
      port: port || 22,
      username,
      auth_method: auth_method || 'key',
      private_key_path: private_key_path || '',
      password_encrypted: password ? encryptPassword(password) : '',
      claude_binary_path: claude_binary_path || '',
      default_working_directory: default_working_directory || '',
      env_vars: env_vars || JSON.stringify({
        HTTPS_PROXY: 'http://127.0.0.1:28080',
        HTTP_PROXY: 'http://127.0.0.1:28080',
        NO_PROXY: '127.0.0.1,172.17.0.0/16,192.168.0.0/16',
      }),
    });

    return Response.json({ connection }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
