"use client";

import type { CSSProperties, ReactNode } from "react";
import NextLink from "next/link";
import { useParams as nextUseParams, usePathname, useRouter, useSearchParams as nextUseSearchParams } from "next/navigation";

/**
 * Navigation for the pages (decision D20, slice 5 port): Next.js owns routing. Pages import these instead of a router
 * library so the same components render inside the App Router and, if ever needed, elsewhere.
 */
export function Link(props: { to: string; children: ReactNode; className?: string; style?: CSSProperties; replace?: boolean; title?: string; "aria-label"?: string }) {
  return <NextLink href={props.to} className={props.className} style={props.style} replace={props.replace} title={props.title} aria-label={props["aria-label"]}>{props.children}</NextLink>;
}

export function NavLink(props: { to: string; end?: boolean; children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const active = props.end ? pathname === props.to : pathname === props.to || pathname.startsWith(`${props.to}/`);
  return <NextLink href={props.to} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>{props.children}</NextLink>;
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T {
  return (nextUseParams() ?? {}) as T;
}

export function useNavigate(): (to: string, opts?: { replace?: boolean }) => void {
  const router = useRouter();
  return (to, opts) => (opts?.replace ? router.replace(to) : router.push(to));
}

export function useSearchParams(): [URLSearchParams] {
  const sp = nextUseSearchParams();
  return [new URLSearchParams(sp?.toString() ?? "")];
}
