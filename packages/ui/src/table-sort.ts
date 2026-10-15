"use client";

import { useState } from "react";
import { nextSort, type SortDir, type SortKind, type SortValue, sortAnnouncement, sortRows, type TableHead } from "./helpers";

/**
 * A table's chosen order, for a page that lets people sort it (docs/07). `col` makes a heading that sorts (pass it in
 * Table's `head`): `num` for a column of figures, and `first` for the order its first press gives when the usual one
 * (A to Z, highest first, latest first) is the less useful, as for a deadline. `apply` puts the rows in the chosen
 * order, and `announce` is the sentence Table says once, politely, after a person sorts. `initial` is the order the
 * page opens in, or null for the order the rows came in.
 */
export function useTableSort<K extends string>(initial: { key: K; dir: SortDir } | null = null) {
  const [sort, setSort] = useState(initial);
  const [announce, setAnnounce] = useState("");
  return {
    sort,
    announce,
    col(key: K, label: string, kind: SortKind, opts: { num?: boolean; first?: SortDir } = {}): TableHead {
      return {
        label,
        num: opts.num,
        sort: sort?.key === key ? sort.dir : null,
        onSort: () => {
          const next = nextSort(sort, key, kind, opts.first);
          setSort(next);
          setAnnounce(sortAnnouncement(label, kind, next.dir));
        },
      };
    },
    /**
     * For a "Sort" menu beside the table: puts it in a column's useful order, as that heading's first press would.
     * Choosing the order already in force keeps it (a heading press flips it instead).
     */
    choose(key: K, label: string, kind: SortKind, first?: SortDir): void {
      const next = nextSort(null, key, kind, first);
      setSort(next);
      setAnnounce(sortAnnouncement(label, kind, next.dir));
    },
    apply<T>(rows: readonly T[], by: Record<K, (row: T) => SortValue>): T[] {
      return sort ? sortRows(rows, by[sort.key], sort.dir) : [...rows];
    },
  };
}
