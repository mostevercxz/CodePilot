"use client";

import { Suspense } from "react";
import { SpinnerGap } from "@/components/ui/icon";
import { RemoteConnectionList } from "@/components/remote/RemoteConnectionList";

export default function RemotePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <SpinnerGap size={20} className="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <RemoteConnectionList />
    </Suspense>
  );
}
