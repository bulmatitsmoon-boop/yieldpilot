import type { Metadata } from "next";
import { WalletContextProvider } from "@/components/WalletProvider";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "YieldPilot — Solana Yield Optimizer",
  description: "YieldPilot automatically moves your USDC and SOL across Solana lending protocols to earn the highest APY. Non-custodial, automated, on-chain.",
  keywords: ["Solana", "DeFi", "yield", "APY", "Kamino", "Marinade", "USDC", "auto-rebalance"],
  openGraph: {
    title: "YieldPilot — Earn the best yield on Solana, automatically",
    description: "Deposit once. YieldPilot keeps your funds in the highest-yielding Solana protocol, monitored around the clock. Non-custodial.",
    url: "https://yieldpilot.fund",
    siteName: "YieldPilot",
    type: "website",
    images: [
      {
        url: "https://yieldpilot.fund/api/og?v=4",
        width: 1200,
        height: 630,
        alt: "YieldPilot — Solana Yield Optimizer",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "YieldPilot — Earn the best yield on Solana, automatically",
    description: "Deposit once. YieldPilot keeps your funds in the highest-yielding Solana protocol, monitored around the clock.",
    images: ["https://yieldpilot.fund/api/og?v=4"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletContextProvider>
          <Header />
          <main>{children}</main>
          <Footer />
        </WalletContextProvider>
      </body>
    </html>
  );
}

