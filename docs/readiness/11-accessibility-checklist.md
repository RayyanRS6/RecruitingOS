# Accessibility checklist (release 1)

Target: WCAG 2.1 AA on every candidate page and every signed-in page. Automated: axe-core in `tests/e2e` on 20+ page states, desktop and phone. Manual items below are **Not started** on staging and are done by a person with a screen reader before the first design partner.

## Automated (Built with mocks: passing locally)

- [x] No axe violations (WCAG 2.1 A/AA + best practice) on: login, company setup, Today, Roles, Role, Talent, candidate sheet, Interviews, interview sheet, Setup, Recruiter queue, Admin console (every tab), not found, job page, application form, status page, pick-a-time, confirmed.
- [x] No horizontal scrolling on an iPhone 13 viewport on the routes above.
- [x] Keyboard-only path through the candidate scheduling page (radio group, note, submit).
- [x] Every page has one `h1`, a `main` landmark, and heading levels that do not skip.
- [x] Loading states announced (`role="status"`); action columns have hidden headers; scrolling tables are focusable.
- [x] Text contrast ≥ 4.5:1 for body text (tokens darkened on 18 Sep).

## Manual (Not started; do on the staging URL)

- [ ] Screen reader (VoiceOver on macOS and iOS), by the person the founder names: apply, pick a time, status page, sign in, approve an interview, resolve a queue item, and the intake conversation (each new reply is announced).
- [ ] 200% zoom and 320px width: no clipped content, no two-dimensional scrolling.
- [ ] Focus order and visible focus on every interactive element in the sheets (candidate, interview, privacy request).
- [ ] Error messages are announced and tied to their fields (`aria-describedby` review).
- [ ] Colour is never the only carrier of meaning (status chips carry text).
- [ ] Reduced motion respected (`prefers-reduced-motion` disables transitions).
- [ ] Time-zone and date text is readable aloud (long month names, explicit zone).
- [ ] Email templates: plain text first, links spelled out, no image-only content.

## Known gaps

- The intake conversation on Today uses a scrolling message list; live-region announcements for new assistant replies are not yet implemented (planned before the pilot).
- PDF resumes are stored as uploaded; the product never renders them.
