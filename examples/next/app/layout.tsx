import type { ReactNode } from "react";

export const metadata = { title: "@hussmartinez/ai-core in Next.js" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
