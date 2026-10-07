# Proposal: Bold premium finance-terminal UI overhaul

## Why

The shipped UI was functional but generic — system fonts, default Tailwind surfaces, hand-rolled sheets without a shared language, and no visual identity of its own. For a demo-facing product judged on craft, the interface must read as *designed*: bold, premium, technical, tuned for a phone held one-handed while a match is on. This change records the completed visual overhaul in OpenSpec.

## What Changes

- **Design token system**: hand-tuned oklch tokens in `globals.css` — cool neutrals (hue family 250), one electric-blue accent (262), and a YES/NO pair (emerald/red) that is distinguishable by hue, lightness, and label.
- **Typography**: Space Grotesk for display/body and JetBrains Mono for every number, wired via `next/font` and Tailwind v4 `@theme` (`--font-sans` / `--font-mono`), with tabular numerals on price-bearing text.
- **Shared UI primitives** (in `@layer components` so utilities still override): `.pulse-card`, `.btn-*` (primary/ghost/yes/no), `.input`, `.label`, `.chip`, `.section-head`, `.sheet`/`.sheet-scrim`/`.sheet-handle`, `.live-dot`.
- **Motion, CSS-only**: sheet slide-in, live-dot pulse, card rise stagger, tape flash — all gated by `prefers-reduced-motion`.
- **Landing**: display headline with accented "money on it.", mono-indexed principle list, dot-grid backdrop, top accent hairline.
- **Room**: Kalshi-style market cards (YES/NO price board with large mono percentages, probability split bar, live ratio), LIVE badge, staggered entry, tape rows with new-trade flash, bold scoreboard with signed mono net.
- **Sheets** (buy/create): shared bottom-sheet shell, preset segmented control, big mono price readout, side-colored confirm, in-flight/done states.
- **Wallet & compliance**: primary connect button, connected chip, reskinned wallet sheet; restyled staleness stamp, "Powered by Panta" lockup, TxLink.
- **Icons**: `@phosphor-icons/react` added (tree-shaken client icons; no heavy runtime deps).
- **Ops page**: corrected stale "Product UI not built yet" note.

## Capabilities

### New Capabilities

- `design-system` — Durable home for the design language: tokens (color/typography/radius/shadow), shared component primitives, motion rules, and the accessibility constraints (44px touch targets, tabular numerals, reduced-motion) that every surface must keep honoring.

### Modified Capabilities

None. No OpenSpec specs existed prior to this change (the repository had no `openspec/specs/` inventory).

## Impact

- **Code**: `src/app/globals.css` (tokens + primitives + keyframes), `src/app/layout.tsx` (fonts), `src/app/page.tsx` (landing), `src/app/ops/page.tsx`, `src/components/{landing,room,trade,wallet,compliance}/*` (all reskinned).
- **Dependencies**: `@phosphor-icons/react` added. No runtime logic changed; all flows, handlers, and the client/server boundary (`tileUrl` import from `@/lib/image/tileUrl`) preserved — `npm run verify` still passes 164/164 and `npm run build` is green.
- **Verify surface**: the `CreateSheet.tsx` assertion blocks in `scripts/verify-resilience.ts` (feeChanged-before-quoted handler, single debounced `flow.quote()` callsite, tileUrl import boundary) were untouched.