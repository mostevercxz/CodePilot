"use client";

import { useState, useEffect, useCallback } from "react";
import { Folder, ArrowLeft } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface RemoteDirectoryPickerProps {
  connectionId: string;
  initialDir?: string;
  onSelect: (path: string) => void;
}

export function RemoteDirectoryPicker({
  connectionId,
  initialDir,
  onSelect,
}: RemoteDirectoryPickerProps) {
  const { t } = useTranslation();
  const [currentDir, setCurrentDir] = useState(initialDir || "~");
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchDirectories = useCallback(async (dir: string) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/remote/${connectionId}/directories?dir=${encodeURIComponent(dir)}`
      );
      const data = await res.json();
      setCurrentDir(data.current || dir);
      setParentDir(data.parent || null);
      setDirectories(data.directories || []);
    } catch {
      setDirectories([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    fetchDirectories(currentDir);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {parentDir && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1"
            onClick={() => fetchDirectories(parentDir)}
          >
            <ArrowLeft size={12} />
          </Button>
        )}
        <span className="truncate font-mono">{currentDir}</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 text-xs"
          onClick={() => onSelect(currentDir)}
        >
          {t("remote.selectDir")}
        </Button>
      </div>

      <div className="max-h-48 overflow-y-auto rounded border">
        {loading ? (
          <div className="p-3 text-center text-xs text-muted-foreground">
            {t("remote.loading")}
          </div>
        ) : directories.length === 0 ? (
          <div className="p-3 text-center text-xs text-muted-foreground">
            {t("remote.emptyDir")}
          </div>
        ) : (
          directories.map((dir) => (
            <button
              key={dir.path}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => fetchDirectories(dir.path)}
              onDoubleClick={() => onSelect(dir.path)}
            >
              <Folder size={14} className="shrink-0 text-muted-foreground" />
              <span className="truncate">{dir.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
