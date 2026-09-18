"use client";
import { useMemo, useState } from "react";
import { Card, CardHeader, StatCard, Button, fmtAddr } from "@/components/ui";
import { useHoodWallet } from "@/hooks/useHoodWallet";
import {
  useHoodPool,
  useHoodUser,
  fmtToken,
  parseToken,
  previewDepositShares,
  approveIfNeeded,
  depositToHood,
  withdrawFromHood,
} from "@/hooks/useHoodVault";
import { USDE_ADDRESS, USDG_ADDRESS, HOOD_WRAPPER_ADDRESS, ROBINHOOD_EXPLORER_URL } from "@/lib/hood/constants";

type TxStatus = "idle" | "approving" | "signing" | "confirming" | "success" | "error";

export default function HoodPage() {
  const {
    address,
    connected,
    connecting,
    wrongNetwork,
    error: walletError,
    connect,
    connectWalletConnect,
    walletConnectAvailable,
    switchToRobinhoodChain,
    walletClient,
  } = useHoodWallet();
  const { pool, loading: poolLoading, refresh: refreshPool } = useHoodPool();
  const { user, refresh: refreshUser } = useHoodUser(address);

  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount0Input, setAmount0Input] = useState("");
  const [amount1Input, setAmount1Input] = useState("");
  const [withdrawSharesInput, setWithdrawSharesInput] = useState("");
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const canInteract = connected && !wrongNetwork && pool?.bootstrapped;

  const depositPreviewShares = useMemo(() => {
    if (!pool) return 0n;
    const a0 = parseToken(amount0Input, USDE_ADDRESS);
    const a1 = parseToken(amount1Input, USDG_ADDRESS);
    if (a0 === 0n && a1 === 0n) return 0n;
    return previewDepositShares(pool, a0, a1);
  }, [pool, amount0Input, amount1Input]);

  async function handleDeposit() {
    if (!walletClient || !address || !pool) return;
    setTxError(null);
    setTxHash(null);
    try {
      const maxAmount0 = parseToken(amount0Input, USDE_ADDRESS);
      const maxAmount1 = parseToken(amount1Input, USDG_ADDRESS);
      if (depositPreviewShares === 0n) throw new Error("Enter an amount first.");

      setTxStatus("approving");
      if (user) {
        await approveIfNeeded(walletClient, address, USDE_ADDRESS, user.allowance0, maxAmount0);
        await approveIfNeeded(walletClient, address, USDG_ADDRESS, user.allowance1, maxAmount1);
      }

      setTxStatus("signing");
      const receipt = await depositToHood(walletClient, address, depositPreviewShares, maxAmount0, maxAmount1);
      setTxStatus("confirming");
      setTxHash(receipt.transactionHash);
      setTxStatus("success");
      setAmount0Input("");
      setAmount1Input("");
      refreshPool();
      refreshUser();
    } catch (e) {
      setTxStatus("error");
      setTxError(e instanceof Error ? e.message : "Deposit failed.");
    }
  }

  async function handleWithdraw() {
    if (!walletClient || !address || !user) return;
    setTxError(null);
    setTxHash(null);
    try {
      const shares = BigInt(Math.floor(Number(withdrawSharesInput || "0") * 1e18));
      if (shares === 0n || shares > user.userShares) throw new Error("Enter a valid share amount to withdraw.");

      setTxStatus("signing");
      const receipt = await withdrawFromHood(walletClient, address, shares);
      setTxStatus("confirming");
      setTxHash(receipt.transactionHash);
      setTxStatus("success");
      setWithdrawSharesInput("");
      refreshPool();
      refreshUser();
    } catch (e) {
      setTxStatus("error");
      setTxError(e instanceof Error ? e.message : "Withdraw failed.");
    }
  }

  const userSharePct = pool && pool.totalShares > 0n && user ? (Number(user.userShares) / Number(pool.totalShares)) * 100 : 0;

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "32px 20px" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 6 }}>YieldPilot on Robinhood Chain</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          USDe / USDG safe-tier pool -- real JIT liquidity, idle capital resting in Morpho, live on Robinhood Chain mainnet.
        </p>
      </div>

      {!connected ? (
        <Card style={{ padding: 32, textAlign: "center" }}>
          <p style={{ marginBottom: 16, color: "var(--text-muted)" }}>Connect an EVM wallet to deposit or withdraw.</p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <Button onClick={connect} disabled={connecting} size="lg">
              {connecting ? "Connecting..." : "Connect Extension"}
            </Button>
            <Button onClick={connectWalletConnect} disabled={connecting || !walletConnectAvailable} variant="secondary" size="lg">
              {connecting ? "Connecting..." : "Connect via Mobile"}
            </Button>
          </div>
          <p style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 12 }}>
            &quot;Connect Extension&quot; works with MetaMask or any injected EVM wallet (including Phantom&apos;s Ethereum support).
            &quot;Connect via Mobile&quot; scans a QR code with your phone&apos;s wallet app -- no extension needed.
          </p>
          {walletError && <p style={{ color: "#f87171", fontSize: 13, marginTop: 12 }}>{walletError}</p>}
        </Card>
      ) : wrongNetwork ? (
        <Card style={{ padding: 32, textAlign: "center" }}>
          <p style={{ marginBottom: 16, color: "var(--text-muted)" }}>Wrong network -- switch to Robinhood Chain to continue.</p>
          <Button onClick={switchToRobinhoodChain} size="lg">Switch to Robinhood Chain</Button>
          {walletError && <p style={{ color: "#f87171", fontSize: 13, marginTop: 12 }}>{walletError}</p>}
        </Card>
      ) : (
        <>
          <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
            <StatCard label="Pool USDe" value={pool ? fmtToken(pool.reserve0, USDE_ADDRESS, 2) : "..."} />
            <StatCard label="Pool USDG" value={pool ? fmtToken(pool.reserve1, USDG_ADDRESS, 2) : "..."} />
            <StatCard label="Your Share" value={`${userSharePct.toFixed(3)}%`} sub={fmtAddr(address!)} />
          </div>

          {!pool?.bootstrapped && !poolLoading && (
            <Card style={{ padding: 20, marginBottom: 20, border: "1px solid var(--warn, #b45309)" }}>
              <p style={{ color: "var(--warn, #fbbf24)", fontSize: 13 }}>Pool not yet bootstrapped -- deposits are not open yet.</p>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Deposit / Withdraw"
              right={
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => setMode("deposit")} style={tabStyle(mode === "deposit")}>Deposit</button>
                  <button onClick={() => setMode("withdraw")} style={tabStyle(mode === "withdraw")}>Withdraw</button>
                </div>
              }
            />
            <div style={{ padding: 20 }}>
              {mode === "deposit" ? (
                <>
                  <label style={labelStyle}>USDe amount</label>
                  <input
                    value={amount0Input}
                    onChange={(e) => setAmount0Input(e.target.value)}
                    placeholder="0.0"
                    style={inputStyle}
                  />
                  {user && <div style={balanceHintStyle}>Balance: {fmtToken(user.balance0, USDE_ADDRESS)}</div>}

                  <label style={{ ...labelStyle, marginTop: 16 }}>USDG amount</label>
                  <input
                    value={amount1Input}
                    onChange={(e) => setAmount1Input(e.target.value)}
                    placeholder="0.0"
                    style={inputStyle}
                  />
                  {user && <div style={balanceHintStyle}>Balance: {fmtToken(user.balance1, USDG_ADDRESS)}</div>}

                  <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 12 }}>
                    Deposit amounts are pulled proportional to the pool&apos;s current ratio; unused approved tokens are refunded automatically.
                  </p>

                  <Button onClick={handleDeposit} disabled={!canInteract || txStatus === "approving" || txStatus === "signing" || txStatus === "confirming"} fullWidth size="lg">
                    {txStatus === "approving" ? "Approving..." : txStatus === "signing" ? "Confirm in wallet..." : txStatus === "confirming" ? "Confirming..." : "Deposit"}
                  </Button>
                </>
              ) : (
                <>
                  <label style={labelStyle}>Shares to withdraw</label>
                  <input
                    value={withdrawSharesInput}
                    onChange={(e) => setWithdrawSharesInput(e.target.value)}
                    placeholder="0.0"
                    style={inputStyle}
                  />
                  {user && (
                    <div style={balanceHintStyle}>
                      Your shares: {(Number(user.userShares) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 6 })}
                      {user.isWhitelisted && <span style={{ color: "var(--signal, #4ade80)", marginLeft: 8 }}>Whitelisted (0% fee)</span>}
                      {!user.isWhitelisted && <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>Standard 9% fee applies</span>}
                    </div>
                  )}

                  <Button onClick={handleWithdraw} disabled={!canInteract || txStatus === "signing" || txStatus === "confirming"} fullWidth size="lg" variant="secondary">
                    {txStatus === "signing" ? "Confirm in wallet..." : txStatus === "confirming" ? "Confirming..." : "Withdraw"}
                  </Button>
                </>
              )}

              {txStatus === "success" && txHash && (
                <div style={{ marginTop: 16, padding: 12, background: "#052e16", border: "1px solid #166534", borderRadius: 8 }}>
                  <p style={{ color: "#86efac", fontSize: 13, marginBottom: 4 }}>Transaction confirmed</p>
                  <a href={`${ROBINHOOD_EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: "#4ade80", fontSize: 12 }}>
                    View on explorer &#8599;
                  </a>
                </div>
              )}
              {txStatus === "error" && txError && (
                <div style={{ marginTop: 16, padding: 12, background: "#450a0a", border: "1px solid #7f1d1d", borderRadius: 8 }}>
                  <p style={{ color: "#fca5a5", fontSize: 13 }}>{txError}</p>
                </div>
              )}
            </div>
          </Card>

          <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 16, textAlign: "center" }}>
            Contract: {fmtAddr(HOOD_WRAPPER_ADDRESS)} on Robinhood Chain mainnet
          </p>
        </>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6, fontWeight: 600 };
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 15,
  fontFamily: "var(--mono)",
};
const balanceHintStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-dim)", marginTop: 4 };

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
    background: active ? "var(--purple, #7c3aed)" : "transparent",
    color: active ? "#fff" : "var(--text-muted)",
  };
}
