import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Document Reader",
  description: "Internal engineering experiment",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
