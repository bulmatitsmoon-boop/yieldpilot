"use client";
import { useState } from "react";
import { Card, CardHeader, StatCard, Button, fmtAddr } from "@/components/ui";
import { useHoodWallet } from "@/hooks/useHoodWallet";
import {
  useLpVaultState,
  useLpUser,
  fmtUsdg,
  parseUsdg,
  approveUsdgIfNeeded,
  depositToLpVault,
  withdrawFromLpVault,
} from "@/hooks/useLpVault";
import { LP_VAULT_ADDRESS, LP_POOL_ADDRESS } from "@/lib/hood/lpConstants";
import { ROBINHOOD_EXPLORER_URL } from "@/lib/hood/constants";

type TxStatus = "idle" | "approving" | "signing" | "confirming" | "success" | "error";

export default function HoodLpPage() {
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
  const { state: vault, loading: vaultLoading, refresh: refreshVault } = useLpVaultState();
  const { user, refresh: refreshUser } = useLpUser(address);

  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [depositInput, setDepositInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState(""); // fraction of the user's own shares, 0-100
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const canInteract = connected && !wrongNetwork && vault && !vault.depositsPaused;
  const remainingCap = vault ? (vault.totalAssets < vault.depositCap ? vault.depositCap - vault.totalAssets : 0n) : 0n;

  async function handleDeposit() {
    if (!walletClient || !address) return;
    setTxError(null);
    setTxHash(null);
    try {
      const usdgIn = parseUsdg(depositInput);
      if (usdgIn === 0n) throw new Error("Enter an amount first.");
      if (user && usdgIn > user.usdgBalance) throw new Error("Amount exceeds your USDG balance.");
      if (usdgIn > remainingCap) throw new Error(`Only ${fmtUsdg(remainingCap, 2)} USDG of cap room left.`);

      setTxStatus("approving");
      if (user) await approveUsdgIfNeeded(walletClient, address, user.usdgAllowance, usdgIn);

      setTxStatus("signing");
      const receipt = await depositToLpVault(walletClient, address, usdgIn);
      setTxStatus("confirming");
      setTxHash(receipt.transactionHash);
      setTxStatus("success");
      setDepositInput("");
      refreshVault();
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
      const pct = Number(withdrawInput || "0");
      if (pct <= 0 || pct > 100) throw new Error("Enter a percentage between 0 and 100.");
      const sharesIn = pct === 100 ? user.shares : (user.shares * BigInt(Math.floor(pct * 100))) / 10000n;
      if (sharesIn === 0n) throw new Error("You have no shares to withdraw.");

      setTxStatus("signing");
      const receipt = await withdrawFromLpVault(walletClient, address, sharesIn);
      setTxStatus("confirming");
      setTxHash(receipt.transactionHash);
      setTxStatus("success");
      setWithdrawInput("");
      refreshVault();
      refreshUser();
    } catch (e) {
      setTxStatus("error");
      setTxError(e instanceof Error ? e.message : "Withdraw failed.");
    }
  }

  const profit = user && user.value > user.costBasis ? user.value - user.costBasis : 0n;

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "32px 20px" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>ETH/USDG LP Vault</h1>
          <span style={{
            fontSize: 11, fontWeight: 700, color: "var(--warn, #fbbf24)",
            border: "1px solid var(--warn, #b45309)", borderRadius: 6, padding: "2px 8px",
          }}>
            EXPERIMENTAL
          </span>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Deposit USDG only -- the vault automatically swaps into ETH and holds a single Uniswap v3
          position on Robinhood Chain. Rebalancing and fee compounding run on a schedule with no
          human involved; the fee is 9% of profit only, never on your principal.
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
            <StatCard label="Vault Value" value={vault ? `$${fmtUsdg(vault.totalAssets, 2)}` : "..."} />
            <StatCard label="Deposit Cap" value={vault ? `$${fmtUsdg(vault.depositCap, 0)}` : "..."} sub={vault ? `$${fmtUsdg(remainingCap, 2)} room left` : undefined} />
            <StatCard label="Your Value" value={user ? `$${fmtUsdg(user.value, 2)}` : "..."} sub={fmtAddr(address!)} />
            {user && profit > 0n && <StatCard label="Your Profit" value={`$${fmtUsdg(profit, 2)}`} sub="9% fee applies on exit" />}
          </div>

          {vault?.depositsPaused && (
            <Card style={{ padding: 20, marginBottom: 20, border: "1px solid var(--warn, #b45309)" }}>
              <p style={{ color: "var(--warn, #fbbf24)", fontSize: 13 }}>Deposits are currently paused.</p>
            </Card>
          )}
          {vault && remainingCap === 0n && !vault.depositsPaused && (
            <Card style={{ padding: 20, marginBottom: 20, border: "1px solid var(--warn, #b45309)" }}>
              <p style={{ color: "var(--warn, #fbbf24)", fontSize: 13 }}>Deposit cap reached -- withdrawals still work as normal.</p>
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
                  <label style={labelStyle}>USDG amount</label>
                  <input
                    value={depositInput}
                    onChange={(e) => setDepositInput(e.target.value)}
                    placeholder="0.0"
                    style={inputStyle}
                  />
                  {user && <div style={balanceHintStyle}>Balance: {fmtUsdg(user.usdgBalance)} USDG</div>}

                  <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 12 }}>
                    About half of your deposit is swapped into ETH automatically. A small amount is
                    lost to swap fees and slippage on the way in, typically well under 0.5%.
                  </p>

                  <Button onClick={handleDeposit} disabled={!canInteract || txStatus === "approving" || txStatus === "signing" || txStatus === "confirming"} fullWidth size="lg">
                    {txStatus === "approving" ? "Approving..." : txStatus === "signing" ? "Confirm in wallet..." : txStatus === "confirming" ? "Confirming..." : "Deposit"}
                  </Button>
                </>
              ) : (
                <>
                  <label style={labelStyle}>Percent of your position to withdraw</label>
                  <input
                    value={withdrawInput}
                    onChange={(e) => setWithdrawInput(e.target.value)}
                    placeholder="100"
                    style={inputStyle}
                  />
                  {user && (
                    <div style={balanceHintStyle}>
                      Your value: ${fmtUsdg(user.value, 2)} -- you paid in ${fmtUsdg(user.costBasis, 2)}
                      {profit > 0n && <span style={{ color: "var(--warn, #fbbf24)", marginLeft: 8 }}>9% of the ${fmtUsdg(profit, 2)} profit is fee</span>}
                      {profit === 0n && <span style={{ color: "var(--signal, #4ade80)", marginLeft: 8 }}>No profit yet -- no fee</span>}
                    </div>
                  )}

                  <Button onClick={handleWithdraw} disabled={!canInteract || !user?.shares || txStatus === "signing" || txStatus === "confirming"} fullWidth size="lg" variant="secondary">
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
            Vault: {fmtAddr(LP_VAULT_ADDRESS)} &middot; Pool: {fmtAddr(LP_POOL_ADDRESS)} &middot; Robinhood Chain mainnet
          </p>
        </>
      )}
      {vaultLoading && !vault && (
        <p style={{ textAlign: "center", color: "var(--text-dim)", fontSize: 12, marginTop: 12 }}>Loading vault state...</p>
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
