"use client";

import { appPaths, type PlanRoom } from "@ros/contracts";
import { Alert } from "@ros/ui";
import { Link } from "../nav";
import { roomAsk } from "../upgrade";
import { Upgrade } from "./Upgrade";

/**
 * The plan has no room for another job: the server's own line, the jobs holding the places when closing one would give
 * a place back (each a link to it), and the way to ask for more. `ask`: the request a refusal by the API carried; the
 * room read with a page carries none, so it is worked out from what ran out (`roomAsk`).
 */
export function RoomAlert({ room, ask }: { room: PlanRoom; ask?: { label: string; reason: string } | null }) {
  const request = ask ?? roomAsk(room);
  return (
    <Alert tone="caution">
      <div className="grid gap-2">
        <span>{room.message ?? "Your plan has no room for another job right now."}</span>
        {room.holding.length && !room.upgrade && !room.trialEnded ? (
          <ul className="small grid list-disc gap-0.5 pl-[18px]">
            {room.holding.map((r) => <li key={r.roleId}><Link to={appPaths.job(r.roleId)}>{r.title}</Link></li>)}
          </ul>
        ) : null}
        <div className="row"><Upgrade label={request.label} size="sm" reason={request.reason} /></div>
      </div>
    </Alert>
  );
}
