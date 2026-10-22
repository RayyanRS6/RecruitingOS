"use client";

import { domMax, LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/**
 * Motion for the whole app (docs/07), mounted once near the root by the shell's Providers. `domMax` because layout moves
 * and the shared `layoutId` highlight need it; `strict`, so a stray `motion.div` (the full bundle) fails loudly: use
 * `m.div`, `m.li` and `AnimatePresence` from "motion/react". `reducedMotion="user"`: for someone who asked the device
 * for less motion, nothing slides or grows. CSS does every simple enter, hover and press; motion only what CSS cannot
 * (exits, layout moves, the shared highlight).
 *
 * `nonce`: the request's CSP nonce. Motion writes a <style> element only for `AnimatePresence mode="popLayout"`, which
 * the policy (style-src with a nonce) blocks without it; the kit never uses that mode, and screens should keep to the
 * default mode or "wait". Pass the nonce anyway when the shell has it, so a popLayout added later still works.
 */
export function MotionProvider(props: { children: ReactNode; nonce?: string }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user" nonce={props.nonce}>
        {props.children}
      </MotionConfig>
    </LazyMotion>
  );
}
