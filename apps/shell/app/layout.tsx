import type { ReactNode } from "react";
import "@ros/ui/tokens.css";
import { Providers } from "../components/Providers";
import { getMe } from "../lib/session";

export const metadata = { title: "Recruiting OS", description: "A recruiting department for companies too small to have one." };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap" />
      </head>
      <body>
        <Providers me={me}>{children}</Providers>
      </body>
    </html>
  );
}
