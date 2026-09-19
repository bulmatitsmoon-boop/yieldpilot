import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbiItem } from "viem";
import {
  HOOD_WRAPPER_ADDRESS,
  HOOK_ADDRESS,
  POOL_KEY,
  USDE_ADDRESS,
  USDG_ADDRESS,
  HOOD_TREASURY_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URL,
  ROBINHOOD_EXPLORER_URL,
} from "@/lib/hood/constants";
import { hoodVaultAbi, hookAbi, erc20Abi } from "@/lib/hood/abi";

export const dynamic = "force-dynamic";

// Real deployment block of the wrapper (tx 0xc5ff7db7...), confirmed via the actual
// broadcast receipt -- the true lower bound for "since this contract has existed",
// not a guess.
const WRAPPER_DEPLOY_BLOCK = 65876114n;

// Robinhood Chain's public RPC caps eth_getLogs at 2000 blocks per request (confirmed
// live: "requested logs from 5383 blocks ... only allowed to search 2000 blocks per
// request"). Runs server-side, cached for all visitors via the Cache-Control header
// below, rather than every browser re-scanning the whole range on every page load.
const MAX_BLOCK_SPAN = 2000n;
const CONCURRENCY = 8;

const robinhoodChain = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
} as const;

const client = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

const depositedEvent = parseAbiItem("event Deposited(address indexed user, uint256 amount0, uint256 amount1, uint256 sharesMinted)");
const withdrawnEvent = parseAbiItem("event Withdrawn(address indexed user, uint256 amount0, uint256 amount1, uint256 sharesBurned, uint256 feeBps)");

async function getLogsChunked(event: typeof depositedEvent | typeof withdrawnEvent, fromBlock: bigint, toBlock: bigint) {
  const ranges: [bigint, bigint][] = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_BLOCK_SPAN) {
    const end = start + MAX_BLOCK_SPAN - 1n > toBlock ? toBlock : start + MAX_BLOCK_SPAN - 1n;
    ranges.push([start, end]);
  }

  const results: Awaited<ReturnType<typeof client.getLogs>> = [];
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(([from, to]) =>
        client.getLogs({ address: HOOD_WRAPPER_ADDRESS, event, fromBlock: from, toBlock: to }).catch(() => [])
      )
    );
    results.push(...batchResults.flat());
  }
  return results;
}

export async function GET() {
  try {
    const latestBlock = await client.getBlockNumber();

    const [reserves, treasuryUsde, treasuryUsdg, depositLogs, withdrawLogs] = await Promise.all([
      client.readContract({ address: HOOK_ADDRESS, abi: hookAbi, functionName: "getReserves", args: [POOL_KEY] }) as Promise<readonly [bigint, bigint]>,
      client.readContract({ address: USDE_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [HOOD_TREASURY_ADDRESS] }) as Promise<bigint>,
      client.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [HOOD_TREASURY_ADDRESS] }) as Promise<bigint>,
      getLogsChunked(depositedEvent, WRAPPER_DEPLOY_BLOCK, latestBlock),
      getLogsChunked(withdrawnEvent, WRAPPER_DEPLOY_BLOCK, latestBlock),
    ]);

    const depositedUsd = Number(reserves[0]) / 1e18 + Number(reserves[1]) / 1e6;
    const feesUsd = Number(treasuryUsde) / 1e18 + Number(treasuryUsdg) / 1e6;

    const uniqueUsers = Array.from(new Set(depositLogs.map((l) => (l as any).args.user as `0x${string}`)));
    const shareBalances = await Promise.all(
      uniqueUsers.map((u) =>
        client.readContract({ address: HOOD_WRAPPER_ADDRESS, abi: hoodVaultAbi, functionName: "userShares", args: [u] }) as Promise<bigint>
      )
    );
    const activePositions = shareBalances.filter((s) => s > 0n).length;

    const allLogs = [...depositLogs, ...withdrawLogs].sort((a, b) => Number((b as any).blockNumber - (a as any).blockNumber)).slice(0, 8);
    const uniqueBlockNumbers = Array.from(new Set(allLogs.map((l) => (l as any).blockNumber as bigint)));
    const blocks = await Promise.all(uniqueBlockNumbers.map((bn) => client.getBlock({ blockNumber: bn })));
    const blockTimeByNumber = new Map(blocks.map((b) => [b.number, Number(b.timestamp)]));

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
