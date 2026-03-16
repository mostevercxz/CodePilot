"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, ChatCircle, FileArrowDown } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { RemoteConnectionStatus } from "./RemoteConnectionStatus";
import { RemoteConnectionForm } from "./RemoteConnectionForm";
import { RemoteDirectoryPicker } from "./RemoteDirectoryPicker";
import { ImportSessionDialog } from "@/components/layout/ImportSessionDialog";
import { useTranslation } from "@/hooks/useTranslation";
import type { RemoteConnection, RemoteConnectionRuntime } from "@/types";

export function RemoteConnectionList() {
  const { t } = useTranslation();
  const router = useRouter();
  const [connections, setConnections] = useState<RemoteConnection[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RemoteConnectionRuntime>>({});
  const [showForm, setShowForm] = useState(false);
  const [editingConnection, setEditingConnection] = useState<RemoteConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickingDirForId, setPickingDirForId] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [importingForId, setImportingForId] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/remote");
      const data = await res.json();
      setConnections(data.connections || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStatuses = useCallback(async () => {
    for (const conn of connections) {
      try {
        const res = await fetch(`/api/remote/${conn.id}/status`);
        const data = await res.json();
        setStatuses((prev) => ({ ...prev, [conn.id]: data.runtime }));
      } catch {
        // ignore
      }
    }
  }, [connections]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    if (connections.length > 0) {
      fetchStatuses();
      const interval = setInterval(fetchStatuses, 10000);
      return () => clearInterval(interval);
    }
  }, [connections, fetchStatuses]);

  const handleConnect = async (id: string) => {
    try {
      setStatuses((prev) => ({
        ...prev,
        [id]: { connectionId: id, status: "connecting", tunnelPort: null, error: null, connectedAt: null },
      }));
      const res = await fetch(`/api/remote/${id}/connect`, { method: "POST" });
      const data = await res.json();
      if (data.runtime) {
        setStatuses((prev) => ({ ...prev, [id]: data.runtime }));
      }
      if (data.error) {
        setStatuses((prev) => ({
          ...prev,
          [id]: { connectionId: id, status: "error", tunnelPort: null, error: data.error, connectedAt: null },
        }));
      }
    } catch (err) {
      setStatuses((prev) => ({
        ...prev,
        [id]: { connectionId: id, status: "error", tunnelPort: null, error: String(err), connectedAt: null },
      }));
    }
  };

  const handleDisconnect = async (id: string) => {
    try {
      await fetch(`/api/remote/${id}/connect`, { method: "DELETE" });
      setStatuses((prev) => ({
        ...prev,
        [id]: { connectionId: id, status: "disconnected", tunnelPort: null, error: null, connectedAt: null },
      }));
    } catch {
      // ignore
    }
  };

  const handleTest = async (id: string) => {
    try {
      const res = await fetch(`/api/remote/${id}/test`, { method: "POST" });
      const data = await res.json();
      alert(data.message || data.error || "Test completed");
    } catch (err) {
      alert(`Test failed: ${err}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t("remote.deleteConfirm"))) return;
    try {
      await fetch(`/api/remote/${id}`, { method: "DELETE" });
      setConnections((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // ignore
    }
  };

  const handleSave = async (data: Record<string, unknown>) => {
    try {
      if (editingConnection) {
        const res = await fetch(`/api/remote/${editingConnection.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const result = await res.json();
        if (result.connection) {
          setConnections((prev) =>
            prev.map((c) => (c.id === editingConnection.id ? result.connection : c))
          );
        }
      } else {
        const res = await fetch("/api/remote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const result = await res.json();
        if (result.connection) {
          setConnections((prev) => [result.connection, ...prev]);
        }
      }
      setShowForm(false);
      setEditingConnection(null);
    } catch {
      // ignore
    }
  };

  const handleNewSession = async (connectionId: string, remotePath: string) => {
    setCreatingSession(true);
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          working_directory: remotePath,
          connection_id: connectionId,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setPickingDirForId(null);
        router.push(`/chat/${data.session.id}`);
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create session");
      }
    } catch (err) {
      alert(`Failed to create session: ${err}`);
    } finally {
      setCreatingSession(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">{t("remote.loading")}</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("remote.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("remote.description")}</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditingConnection(null);
            setShowForm(true);
          }}
        >
          <Plus size={14} className="mr-1" />
          {t("remote.addConnection")}
        </Button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border bg-card p-4">
          <RemoteConnectionForm
            connection={editingConnection}
            onSave={handleSave}
            onCancel={() => {
              setShowForm(false);
              setEditingConnection(null);
            }}
          />
        </div>
      )}

      {connections.length === 0 && !showForm ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted-foreground">{t("remote.noConnections")}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => setShowForm(true)}
          >
            <Plus size={14} className="mr-1" />
            {t("remote.addFirst")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {connections.map((conn) => {
            const status = statuses[conn.id];
            const isConnected = status?.status === "connected";
            const isConnecting = status?.status === "connecting";

            return (
              <div key={conn.id} className="rounded-lg border bg-card">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <RemoteConnectionStatus status={status?.status || "disconnected"} />
                    <div>
                      <div className="font-medium">{conn.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {conn.username}@{conn.host}:{conn.port}
                        {conn.default_working_directory && ` · ${conn.default_working_directory}`}
                      </div>
                      {status?.error && (
                        <div className="mt-1 text-xs text-destructive">{status.error}</div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isConnected && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => {
                            if (conn.default_working_directory) {
                              handleNewSession(conn.id, conn.default_working_directory);
                            } else {
                              setPickingDirForId(pickingDirForId === conn.id ? null : conn.id);
                            }
                          }}
                          disabled={creatingSession}
                        >
                          <ChatCircle size={14} className="mr-1" />
                          {t("remote.newSession")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setImportingForId(conn.id)}
                        >
                          <FileArrowDown size={14} className="mr-1" />
                          {t("remote.importSessions")}
                        </Button>
                      </>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTest(conn.id)}
                      disabled={isConnecting}
                    >
                      {t("remote.test")}
                    </Button>
                    {isConnected ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDisconnect(conn.id)}
                      >
                        {t("remote.disconnect")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleConnect(conn.id)}
                        disabled={isConnecting}
                      >
                        {isConnecting ? t("remote.connecting") : t("remote.connect")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingConnection(conn);
                        setShowForm(true);
                      }}
                    >
                      {t("remote.edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDelete(conn.id)}
                    >
                      {t("remote.delete")}
                    </Button>
                  </div>
                </div>

                {/* Remote directory picker for new session */}
                {pickingDirForId === conn.id && isConnected && (
                  <div className="border-t px-4 py-3">
                    <p className="mb-2 text-xs text-muted-foreground">
                      {t("remote.selectWorkDir")}
                    </p>
                    <RemoteDirectoryPicker
                      connectionId={conn.id}
                      initialDir={conn.default_working_directory || "~"}
                      onSelect={(dir) => handleNewSession(conn.id, dir)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {importingForId && (
        <ImportSessionDialog
          open={!!importingForId}
          onOpenChange={(open) => { if (!open) setImportingForId(null); }}
          connectionId={importingForId}
        />
      )}
    </div>
  );
}
