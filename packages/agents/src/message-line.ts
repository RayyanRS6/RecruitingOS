import { messageLinePrompt, runPromptDetached, type AiRuntime, type MessageLineInput } from "@ros/ai";
import type { Db } from "@ros/db";
import { checkPersonalLine } from "./personal-line";

/**
 * The assistant's suggested line for an interview invitation or an update (founder decision Q28, plan G6). Called with
 * no transaction open (the model may take seconds). What comes back passes the same check as a person's own line before
 * anyone sees it; a line that fails it, or a model that fails, gives no suggestion rather than a bad one. The person
 * decides whether to use it, and the email then says the assistant helped.
 */
export async function suggestMessageLine(db: Db, ai: AiRuntime, input: MessageLineInput & { companyId: string; applicationId: string }): Promise<{ line: string | null; runId: string | null }> {
  const { companyId, applicationId, ...prompt } = input;
  const out = await runPromptDetached(db, ai, messageLinePrompt, prompt, { companyId, inputRef: { applicationId, purpose: prompt.purpose } });
  if (!out.ok) return { line: null, runId: out.runId };
  const checked = checkPersonalLine(out.output.line);
  return { line: checked.ok ? checked.text : null, runId: out.runId };
}
