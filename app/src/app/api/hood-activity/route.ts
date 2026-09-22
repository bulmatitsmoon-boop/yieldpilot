import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbiItem } from "viem";
import { HOOD_TREASURY_ADDRESS, USDG_ADDRESS, ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_URL, ROBINHOOD_EXPLORER_URL } from "@/lib/hood/constants";
import { erc20Abi } from "@/lib/hood/abi";
import { lpVaultAbi } from "@/lib/hood/lpAbi";
import { LP_VAULT_ADDRESS } from "@/lib/hood/lpConstants";

export const dynamic = "force-dynamic";

// Points at the ETH/USDG LP vault (Uniswap v3 on Robinhood Chain), not the old USDe/USDG
// wrapper -- that pair was dropped as unprofitable (no live USDe lending market) and its
// vault sits empty. Fee revenue is still read from the same shared treasury address, so
// this total still includes a tiny (~$0.14) legacy fee the old wrapper's broken deposit-fee
// logic charged before it was fixed/abandoned -- not worth a separate line item at this size.
//
// Robinhood Chain's public RPC caps eth_getLogs at 2000 blocks per request AND has a tight
// rate limit that a multi-chunk scan trips within seconds even with concurrency. A full
// since-deployment history scan is NOT safely doable against this RPC right now -- so this
// deliberately only looks at the most recent 2000 blocks (a single request) rather than the
// vault's full history. "Active positions" here means "positions with activity in roughly
// the last few minutes", not necessarily every depositor ever -- an honest limitation, not a
// silent gap. A real indexer (e.g. Alchemy, which already supports this chain) is the correct
// long-term fix if/when this matters at real volume.
const RECENT_BLOCK_WINDOW = 2000n;

const robinhoodChain = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
} as const;

const client = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

const depositedEvent = parseAbiItem("event Deposited(address indexed user, uint256 usdgIn, uint256 valueAdded, uint256 sharesOut)");
const withdrawnEvent = parseAbiItem("event Withdrawn(address indexed user, uint256 sharesBurned, uint256 gross, uint256 fee, uint256 net)");

export async function GET() {
  try {
    const latestBlock = await client.getBlockNumber();
    const fromBlock = latestBlock > RECENT_BLOCK_WINDOW ? latestBlock - RECENT_BLOCK_WINDOW : 0n;

    const [totalAssets, treasuryUsdg, depositLogs, withdrawLogs] = await Promise.all([
      client.readContract({ address: LP_VAULT_ADDRESS, abi: lpVaultAbi, functionName: "totalAssets" }) as Promise<bigint>,
      client.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [HOOD_TREASURY_ADDRESS] }) as Promise<bigint>,
      client.getLogs({ address: LP_VAULT_ADDRESS, event: depositedEvent, fromBlock, toBlock: latestBlock }).catch(() => []),
      client.getLogs({ address: LP_VAULT_ADDRESS, event: withdrawnEvent, fromBlock, toBlock: latestBlock }).catch(() => []),
    ]);

    const depositedUsd = Number(totalAssets) / 1e6;
    const feesUsd = Number(treasuryUsdg) / 1e6;

    // "Active positions" among wallets that transacted in this recent window --
    // real, but bounded by the window above, not the vault's full lifetime.
    // Always counts at least 1 if the vault holds any real value at all (the
    // original depositor), since that's true regardless of the window.
    const uniqueUsers = Array.from(new Set(depositLogs.map((l) => (l as any).args.user as `0x${string}`)));
    const shareBalances = await Promise.all(
      uniqueUsers.map((u) =>
        client.readContract({ address: LP_VAULT_ADDRESS, abi: lpVaultAbi, functionName: "shares", args: [u] }).catch(() => 0n) as Promise<bigint>
      )
    );
    const recentActivePositions = shareBalances.filter((s) => s > 0n).length;
    const activePositions = depositedUsd > 0 ? Math.max(recentActivePositions, 1) : recentActivePositions;

    const allLogs = [...depositLogs, ...withdrawLogs].sort((a, b) => Number((b as any).blockNumber - (a as any).blockNumber)).slice(0, 8);
    const uniqueBlockNumbers = Array.from(new Set(allLogs.map((l) => (l as any).blockNumber as bigint)));
    const blocks = await Promise.all(uniqueBlockNumbers.map((bn) => client.getBlock({ blockNumber: bn }).catch(() => null)));
    const blockTimeByNumber = new Map(blocks.filter((b): b is NonNullable<typeof b> => b !== null).map((b) => [b.number, Number(b.timestamp)]));

    const activity = allLogs.map((l: any) => ({
      id: l.transactionHash as string,
      blockTime: blockTimeByNumber.get(l.blockNumber) ?? null,
      explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${l.transactionHash}`,
    }));

    return NextResponse.json(
      { depositedUsd, feesUsd, activePositions, activity, live: true },
      { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" } }
    );
  } catch (err) {
    console.error("hood-activity route error", err);
    return NextResponse.json({ depositedUsd: 0, feesUsd: 0, activePositions: 0, activity: [], live: false });
  }
}
