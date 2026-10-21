import { redirect } from "next/navigation";

/**
 * /dashboard merged into /portfolio, 2026-10-20 — see portfolio/page.tsx's own
 * "Merged in from /dashboard" comment for why. This used to be a separate page
 * duplicating the Safe-vault deposit flow /portfolio already covered, with no LP
 * support at all — real users were confused about where to deposit for LP as a
 * result, and worse, its allocation/APY display always showed vaults[0] (USDC)
 * regardless of which vault the connected wallet actually had funds in. Rather
 * than maintain two overlapping pages, every real stat, the protocol table, the
 * profit calculator, and the admin toggles this page used to own now live on
 * /portfolio instead. Kept as a redirect (not deleted) so old links/bookmarks
 * still land somewhere real.
 */
export default function Dashboard() {
  redirect("/portfolio");
}
