import type { ReactNode } from "react";
import "@ros/ui/tokens.css";
// The typefaces come from this deployment's own /fonts/ folder (apps/api/src/pages/fonts.ts lists them, scripts/fetch-fonts.ts
// writes this file), so no font host learns who opened the application and the policy keeps font-src 'self'.
import "./fonts.css";
import { Providers } from "../components/Providers";
import { getMe } from "../lib/session";

export const metadata = { title: "Recruiting OS", description: "A recruiting department for companies too small to have one." };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  return (
    <html lang="en">
      <body>
        <Providers me={me}>{children}</Providers>
      </body>
    </html>
  );
}
