import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "QX ক্যান্ডেল রিয়েকশন সিগন্যাল ইঞ্জিন",
  description:
    "Quotex টিক ডেটা দিয়ে ১ মিনিটের ক্যান্ডেল অ্যানালাইসিস — লেভেল/জোন + মার্কেট স্ট্রাকচার + ফুল ক্লোজ + রিয়েকশন কনফার্মেশন, লাইভ সিগন্যাল, উইন রেট ও ব্যাকটেস্ট।",
  keywords: ["quotex", "binary", "candlestick", "signal", "backtest", "win rate"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="bn" className="dark" suppressHydrationWarning>
      <body className="antialiased bg-[#090c11] text-zinc-100">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
