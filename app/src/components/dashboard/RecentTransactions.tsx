"use client";
import { useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Card, CardHeader } from "@/components/ui";

interface TxEntry {
  signature: string;
  blockTime: number | null;
  err: any;
}

export function RecentTransactions() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [txs, setTxs] = useState<TxEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const isMainnet = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "mainnet-beta";
  const solscanCluster = isMainnet ? "" : "?cluster=devnet";

  useEffect(() => {
    if (!publicKey) return;
    setLoading(true);
    connection
      .getSignaturesForAddress(publicKey, { limit: 5 })
      .then((sigs) =>
        setTxs(sigs.map((s) => ({ signature: s.signature, blockTime: s.blockTime ?? null, err: s.err })))
      )
      .catch(() => setTxs([]))
      .finally(() => setLoading(false));
  }, [publicKey, connection]);

  if (!publicKey) return null;

  return (
    <Card>
      <CardHeader title="Recent Transactions" />
      {loading ? (
        <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>
      ) : txs.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No transactions yet</div>
      ) : (
        txs.map((tx, i) => (
          <a
            key={tx.signature}
            href={`https://solscan.io/tx/${tx.signature}${solscanCluster}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "12px 20px", borderTop: i > 0 ? "1px solid var(--border)" : "none",
              textDecoration: "none", color: "inherit",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14 }}>{tx.err ? "❌" : "✅"}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13 }}>
                {tx.signature.slice(0, 8)}...{tx.signature.slice(-6)}
              </span>
            </div>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : "—"}
            </span>
          </a>
        ))
      )}
    </Card>
  );
}
