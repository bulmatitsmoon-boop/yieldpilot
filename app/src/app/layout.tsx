import type { Metadata } from "next";
import { WalletContextProvider } from "@/components/WalletProvider";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "YieldPilot — Solana Yield Optimizer",
  description: "YieldPilot automatically moves your USDC and SOL across Solana lending protocols to earn the highest APY. Non-custodial, automated, on-chain.",
  keywords: ["Solana", "DeFi", "yield", "APY", "Kamino", "Marinade", "USDC", "auto-compound"],
  openGraph: {
    title: "YieldPilot — Earn the best yield on Solana, automatically",
    description: "Deposit once. YieldPilot routes your funds to the highest-yielding protocol every 15 minutes. Non-custodial.",
    url: "https://yieldpilotapp.netlify.app",
    siteName: "YieldPilot",
    type: "website",
    images: [
      {
        url: "https://yieldpilotapp.netlify.app/api/og",
        width: 1200,
        height: 630,
        alt: "YieldPilot — Solana Yield Optimizer",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "YieldPilot — Earn the best yield on Solana, automatically",
    description: "Deposit once. YieldPilot routes your funds to the highest-yielding protocol every 15 minutes.",
    images: ["https://yieldpilotapp.netlify.app/api/og"],
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
