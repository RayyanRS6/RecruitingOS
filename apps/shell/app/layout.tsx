import { cookies } from "next/headers";
import type { ReactNode } from "react";
import "@ros/ui/tokens.css";
// The pool board's own styles (Talent page, plan F6-F10), after the tokens they are built from.
import "@ros/ui/board.css";
// The typefaces come from this deployment's own /fonts/ folder (apps/api/src/pages/fonts.ts lists them, scripts/fetch-fonts.ts
// writes this file), so no font host learns who opened the application and the policy keeps font-src 'self'.
import "./fonts.css";
import { Providers } from "../components/Providers";
import { getMe } from "../lib/session";
import { THEME_COOKIE, themeFrom } from "../lib/theme";

export const metadata = { title: "Recruiting OS", description: "A recruiting department for companies too small to have one." };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  // The theme picked with the rail's switch, drawn with the page so it never flashes; none picked follows the device.
  const theme = themeFrom((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme}>
      <body>
        <Providers me={me}>{children}</Providers>
      </body>
    </html>
  );
}
