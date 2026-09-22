import { redirect } from "next/navigation";

// The USDe/USDG pool this page served was retired 2026-09-21 -- no live USDe lending market
// meant that leg earned nothing, so it never beat plain USDG lending. Funds were withdrawn
// fee-free and the vault is empty. Anyone with the old link lands on the real replacement.
export default function HoodPage() {
  redirect("/hood-lp");
}
