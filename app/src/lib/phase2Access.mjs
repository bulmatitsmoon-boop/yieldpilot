/**
 * phase2Access.mjs — the pure rule for who can see Phase 2 (LP + split-deposit) surfaces.
 *
 * ⚠️ This is a PREVIEW gate, not a security boundary. It runs client-side, so a determined
 * user can bypass it. That is acceptable ONLY while the Phase 2 vaults do not exist on
 * mainnet — there is nothing to interact with even if the UI is forced open. Once real LP
 * vaults are deployed, the public reveal must come from the flag, and any admin-only access
 * to a live vault has to be enforced on-chain (the program's admin/keeper constraints),
 * never here.
 *
 * Rule: visible if the global reveal flag is on OR the connected wallet is the admin. The
 * admin-only case is flagged as an "admin preview" so the UI can label it clearly.
 */

/**
 * @param {string|null|undefined} walletBase58  connected wallet address, or null
 * @param {boolean} flagOn                        NEXT_PUBLIC_LP_ENABLED === "true"
 * @param {string|null|undefined} adminWallet     NEXT_PUBLIC_ADMIN_WALLET
 * @returns {{ visible: boolean, adminPreview: boolean }}
 */
export function phase2Visible(walletBase58, flagOn, adminWallet) {
  const isAdmin = !!walletBase58 && !!adminWallet && walletBase58 === adminWallet;
  const visible = flagOn === true || isAdmin;
  // adminPreview = the ONLY reason it is visible is that an admin is connected.
  const adminPreview = visible && flagOn !== true && isAdmin;
  return { visible, adminPreview };
}
