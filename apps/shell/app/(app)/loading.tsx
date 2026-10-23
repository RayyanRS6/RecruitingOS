import { Skeleton } from "@ros/ui";

/**
 * While a page's data loads: the place of its heading (no eyebrow bar: the decorative eyebrows above page titles went on
 * 23 October 2026), then a few lines (read out as "Loading"). A server file, so it imports only the kit's hook-free index.
 */
export default function Loading() {
  return (
    <div className="grid gap-8 py-2">
      <span aria-hidden="true" className="skeleton block h-10 w-80 max-w-full rounded-xl" />
      <Skeleton lines={5} />
    </div>
  );
}
