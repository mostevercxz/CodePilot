"use client";

import { cn } from "@/lib/utils";

interface RemoteConnectionStatusProps {
  status: string;
  className?: string;
}

const statusColors: Record<string, string> = {
  connected: "bg-status-success",
  connecting: "bg-status-warning animate-pulse",
  disconnected: "bg-muted-foreground/40",
  error: "bg-status-error",
};

export function RemoteConnectionStatus({
  status,
  className,
}: RemoteConnectionStatusProps) {
  return (
    <span
      className={cn(
        "inline-block h-2.5 w-2.5 rounded-full",
        statusColors[status] || statusColors.disconnected,
        className
      )}
      title={status}
    />
  );
}
