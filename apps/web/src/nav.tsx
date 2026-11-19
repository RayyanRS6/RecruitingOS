"use client";

import type { CSSProperties, ReactNode } from "react";
import NextLink from "next/link";
import { useParams as nextUseParams, usePathname, useRouter, useSearchParams as nextUseSearchParams } from "next/navigation";

/**
 * Navigation for the pages: Next.js owns routing. Pages import these instead of a router library so the same
 * components render inside the App Router and, if ever needed, elsewhere.
 */
export function Link(props: { to: string; children: ReactNode; className?: string; style?: CSSProperties; replace?: boolean; title?: string; "aria-label"?: string }) {
  return <NextLink href={props.to} className={props.className} style={props.style} replace={props.replace} title={props.title} aria-label={props["aria-label"]}>{props.children}</NextLink>;
}

/**
 * A link that marks itself as the current page: aria-current="page" and the class "active" (after any `className`).
 * `end`: only on that exact address, not on the pages under it. `children` may be a function of whether it is current,
 * so the rail can draw its highlight inside the current link only.
 */
export function NavLink(props: { to: string; end?: boolean; className?: string; title?: string; "aria-label"?: string; children: ReactNode | ((active: boolean) => ReactNode) }) {
  const pathname = usePathname() ?? "";
  const active = props.end ? pathname === props.to : pathname === props.to || pathname.startsWith(`${props.to}/`);
  const className = [props.className, active ? "active" : null].filter(Boolean).join(" ") || undefined;
  return (
    <NextLink href={props.to} className={className} title={props.title} aria-label={props["aria-label"]} aria-current={active ? "page" : undefined}>
      {typeof props.children === "function" ? props.children(active) : props.children}
    </NextLink>
  );
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T {
  return (nextUseParams() ?? {}) as T;
}

export function useNavigate(): (to: string, opts?: { replace?: boolean }) => void {
  const router = useRouter();
  return (to, opts) => (opts?.replace ? router.replace(to) : router.push(to));
}

/** Asks the server for the signed-in frame again (the session it was drawn from changed: another company, a new grant). */
export function useRefresh(): () => void {
  const router = useRouter();
  return () => router.refresh();
}

export function useSearchParams(): [URLSearchParams] {
  const sp = nextUseSearchParams();
  return [new URLSearchParams(sp?.toString() ?? "")];
}
