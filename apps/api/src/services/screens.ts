import type { ScreenDeps } from "@ros/agents";
import type { Container } from "../container";

/** What the screening agent needs from the app: the model, the channels, the public base URL, and a way to wake the workflow. */
export function screenDeps(container: Container): ScreenDeps {
  return {
    ai: container.ai,
    integrations: container.integrations,
    appBaseUrl: container.env.APP_BASE_URL,
    signal: (q, input) => container.engine.signal(q, input),
  };
}
