import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "copperhead intake",
  description: "Datasheet intake and constraint verdicts with cited refusals",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
