import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TwinProvider } from "@/lib/state/TwinProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TwinBank",
  description: "Your bank knows what happened. TwinBank shows what happens next.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        {/* The twin and the latest simulation outlive any one route (SPEC section 9). */}
        <TwinProvider>{children}</TwinProvider>
      </body>
    </html>
  );
}
