# DRAFT FOR ATTORNEY REVIEW. Not legally approved. Implemented: `packages/core/src/staff-access.ts`, `escalation-preview.ts`; tests `staff-access.test.ts`, `queue-preview.test.ts`.

# ITS recruiter access to customer data (summary for the pilot agreement)

- **Trigger.** Access exists only after a customer's user asks for a recruiter (or the product escalates a stalled role under the customer's policy) and an ITS recruiter accepts the request.
- **Before acceptance** a recruiter sees only: the customer's name, the role title, the request category, urgency, the expertise needed, the time remaining, and a generic summary. Never the customer's words or any candidate information.
- **Scope.** Access covers the request's role and, if any, the one candidate it concerns. Other roles and candidates are refused.
- **Duration.** At most 14 days; cut to 24 hours after the recruiter resolves the request; ended at once if the recruiter releases it.
- **Record.** Every page the recruiter opens is recorded for the customer (route, time, grant), visible in the customer's activity log. Grants and their end are events the customer can see.
- **Emergency access** by a platform administrator requires a verified second factor within fifteen minutes, a written reason, lasts at most sixty minutes, and is recorded.
- **What recruiters may do:** what the customer's own recruiter role may do inside that scope, under the customer's policy settings; they cannot change policies or remove members.

[Counsel: confirm this is adequate as the "service provider access" description in the DPA and whether customers need a right to revoke access instantly (they can release any grant today through the API; a button in Setup is planned).]
