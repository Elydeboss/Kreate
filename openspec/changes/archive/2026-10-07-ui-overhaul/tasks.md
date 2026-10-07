# Tasks

> All tasks below were completed and committed as `20ce7dc` ("Bold premium finance-terminal UI overhaul") on `main`. They are recorded here so the change's completion state is auditable; checkboxes are marked done to reflect the shipped state.

## 1. Design-token & foundation layer

- [x] Add `@phosphor-icons/react` dependency.
- [x] Rewrite `src/app/globals.css` with oklch light + dark tokens (surfaces, borders, text, YES/NO, accent, warn/danger, radius, shadow).
- [x] Wire `--font-sans` / `--font-mono` in Tailwind v4 `@theme` to the `next/font` variables.
- [x] Add shared primitives in `@layer components`: `.pulse-card`, `.btn`/`.btn-primary`/`.btn-ghost`/`.btn-yes`/`.btn-no`, `.input`, `.label`, `.chip`, `.section-head`, `.live-dot`, `.sheet-scrim`/`.sheet`/`.sheet-handle`.
- [x] Add CSS-only keyframes (sheet-in, live-pulse, rise-in, tape-in) + reduced-motion gate.
- [x] Add focus-visible outline, selection color, thin scrollbars, and global 44px touch-target enforcement.
- [x] Load Space Grotesk (400–700) and JetBrains Mono (400–700) via `next/font` in `src/app/layout.tsx`; update `themeColor` for both schemes.

## 2. Landing

- [x] Restyle hero: display headline with accented "money on it.", subcopy, dot-grid backdrop, top accent hairline.
- [x] Add mono-indexed (01/02/03) principle list; keep PoweredByPanta in the footer.
- [x] Restyle ConnectButton consumption in the landing header.

## 3. Circle setup (landing flow)

- [x] Connected-state status pane; big door cards ("Start a circle" accented) with ArrowRight icons.
- [x] Mono invite-code entry (uppercase, letterspaced); restyled create/join forms and circles list; error surfaces use the new tokens.

## 4. Room

- [x] Room header: display headline name, LIVE pulsing badge (only while live), invite-code chip, member count with Users icon, staleness stamp.
- [x] Session bar: label + primary start CTA; live card with live-dot, big mono countdown (warn <60s), "Call a market" primary + compact End ghost.
- [x] Kalshi-style market cards: YES/NO price board with large mono percentages, probability split bar, ratio footer, staggered `rise` entry; resolved markets show an outcome panel.
- [x] Tape: mono names, side chip + USDC amount + TxLink, `tape-new` flash keyed by signature.
- [x] Scoreboard: rank numerals (accent for #1), name + record, bold signed mono net (+green/−red).

## 5. Buy & create sheets

- [x] Shared sheet shell + grabber handle for both sheets.
- [x] BuySheet: side-colored "Buy YES/NO" header, $ prefix large mono amount input, preset segmented control, big mono quote price, side-colored confirm, in-flight + done states.
- [x] CreateSheet: restyled header/textarea/category tiles/fee panel/details/localhost wall/buttons — with the verify-pinned submit handler, debounced auto-quote, and `tileUrl` import left verbatim.

## 6. Wallet & compliance

- [x] Wallet: primary connect button, connected chip (icon or green dot) + compact disconnect, reskinned wallet sheet.
- [x] PantaCompliance: restyled staleness stamp (stale → warn), PoweredByPanta lockup, TxLink hover states; attribution string unchanged.

## 7. Verification

- [x] `npm run typecheck` clean.
- [x] `npm run verify` — 164/164 assertions pass (CreateSheet blocks intact).
- [x] `npm run build` green (landing 199 kB / room 211 kB First Load JS).
- [x] Rendered HTML spot-checked via curl (headline accent, connect button initial state, Panta lockup, font preload).
- [x] Screenshots captured to `/tmp/opencode/pulse-shots/` (landing mobile, mobile full-page, desktop, room shell) for human review.