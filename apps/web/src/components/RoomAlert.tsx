"use client";

import { appPaths, type PlanRoom } from "@ros/contracts";
import { Alert } from "@ros/ui";
import { Link } from "../nav";
import { Upgrade } from "./Upgrade";

/**
 * The plan has no room for another job: the server's own line, the jobs holding the places when closing one would give
 * a place back (each a link to it), and the request the room itself offers (`room.ask`): its button's words, and its
 * reason sent with the request.
 */
export function RoomAlert({ room }: { room: PlanRoom }) {
  return (
    <Alert tone="caution">
      <div className="grid gap-2">
        <span>{room.message ?? "Your plan has no room for another job right now."}</span>
        {room.holding.length && !room.upgrade && !room.trialEnded ? (
          <ul className="small grid list-disc gap-0.5 pl-[18px]">
            {room.holding.map((r) => <li key={r.roleId}><Link to={appPaths.job(r.roleId)}>{r.title}</Link></li>)}
          </ul>
        ) : null}
        {room.ask ? <div className="row"><Upgrade label={room.ask.label} size="sm" reason={room.ask.reason} /></div> : null}
      </div>
    </Alert>
  );
}
