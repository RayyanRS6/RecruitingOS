"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionProvider, Toaster } from "@ros/ui";
import type { Me } from "../lib/session";

/**
 * React Query for every page; the server-resolved session seeds the "me" query so nothing flashes. The design system's
 * Toaster shows what toast() (apps/web/src/toast.ts) sends: a title, and a second line when there is more to say.
 * Queries do not refetch on focus by default, so a half-filled form is never reloaded under someone; a page that must
 * stay current asks for it itself (Today: on focus and every minute, TODAY_REFRESH in apps/web/src/today.ts).
 * MotionProvider (packages/ui) loads the motion features once for the pages' few JavaScript animations (moves, exits)
 * and turns them off for anyone who asked their device for less motion.
 */
export function Providers({ children, me }: { children: ReactNode; me: Me | null }) {
  const [client] = useState(() => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } } });
    if (me) qc.setQueryData(["me"], me);
    return qc;
  });
  useEffect(() => { if (me) client.setQueryData(["me"], me); }, [client, me]);
  return (
    <QueryClientProvider client={client}>
      <MotionProvider>
        {children}
        <Toaster />
      </MotionProvider>
    </QueryClientProvider>
  );
}
