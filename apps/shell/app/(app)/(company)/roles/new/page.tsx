import { JobBuilder } from "@ros/web/src/pages/JobBuilder";

/**
 * The job builder: "Who are you hiring?", then (at ?session=<id>) the conversation and the job side by side. The static
 * segment wins over roles/[id].
 */
export default function JobBuilderPage() {
  return <JobBuilder />;
}