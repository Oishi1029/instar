import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "INSTAR — agentic memory on CockroachDB + AWS",
  description:
    "Agent skills that learn from their own failures, in a database where two agents cannot teach them opposite things.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
