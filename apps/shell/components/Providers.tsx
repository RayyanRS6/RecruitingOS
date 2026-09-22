"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me } from "../lib/session";

/** React Query for every page; the server-resolved session seeds the "me" query so nothing flashes. */
export function Providers({ children, me }: { children: ReactNode; me: Me | null }) {
  const [client] = useState(() => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } } });
    if (me) qc.setQueryData(["me"], me);
    return qc;
  });
  useEffect(() => { if (me) client.setQueryData(["me"], me); }, [client, me]);
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}

function Toaster() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const onToast = (e: Event) => { setMessage((e as CustomEvent<string>).detail); setTimeout(() => setMessage(null), 2600); };
    window.addEventListener("ros:toast", onToast);
    return () => window.removeEventListener("ros:toast", onToast);
  }, []);
  return message ? <div className="toast" role="status">{message}</div> : null;
}
