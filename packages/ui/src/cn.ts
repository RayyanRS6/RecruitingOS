import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names and lets a later Tailwind class win over an earlier one of the same kind (`cn("p-4", "p-6")` is
 * "p-6"), so a caller's `className` can adjust a component's look.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
