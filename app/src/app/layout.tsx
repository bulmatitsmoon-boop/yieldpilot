import type { Metadata } from "next";
import { WalletContextProvider } from "@/components/WalletProvider";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "YieldPilot — Automated Yield on Solana & Robinhood Chain",
  description: "YieldPilot automatically moves your USDC and SOL across Solana lending protocols to earn the highest APY, plus a native ETH/USDG LP vault on Robinhood Chain. Non-custodial, automated, on-chain.",
  keywords: ["Solana", "Robinhood Chain", "DeFi", "yield", "APY", "Kamino", "Marinade", "USDC", "ETH", "USDG", "auto-rebalance"],
  openGraph: {
    title: "YieldPilot — Automated yield on Solana & Robinhood Chain",
    description: "Deposit once. YieldPilot keeps your funds in the highest-yielding Solana protocol, monitored around the clock — plus a native ETH/USDG vault on Robinhood Chain. Non-custodial.",
    url: "https://yieldpilot.fund",
    siteName: "YieldPilot",
    type: "website",
    images: [
      {
        url: "https://yieldpilot.fund/api/og?v=4",
        width: 1200,
        height: 630,
        alt: "YieldPilot — Automated Yield on Solana & Robinhood Chain",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "YieldPilot — Automated yield on Solana & Robinhood Chain",
    description: "Deposit once. YieldPilot keeps your funds in the highest-yielding Solana protocol, monitored around the clock — plus a native ETH/USDG vault on Robinhood Chain.",
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

