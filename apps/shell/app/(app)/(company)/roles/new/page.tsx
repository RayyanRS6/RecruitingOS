import { NewRole } from "@ros/web/src/pages/NewRole";

/**
 * The job builder (plan C4): "Who are you hiring?" with two ways to start (the quick questions at ?way=quick, or a
 * sentence or a job ad), then the conversation and the draft side by side. The static segment wins over roles/[id].
 */
export default function NewRolePage() {
  return <NewRole />;
}
