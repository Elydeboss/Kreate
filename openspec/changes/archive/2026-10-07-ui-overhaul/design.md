# Design

## Context

The app is a Next.js 15 (App Router) + Tailwind v4 project with a strict client/server boundary enforced by `scripts/verify-resilience.ts` (164 assertions). The pre-overhaul UI used the system font stack, hand-rolled sheets with inconsistent spacing, and emoji/glyph closers (`✕`). There was no `brand.md`, no icon library, and no shared component vocabulary. The overhaul had to raise visual craft without adding heavyweight dependencies (hotel-wifi constraint), without touching any product logic, and without breaking the verify suite or the `tileUrl` import boundary.

See proposal.md for the why; `specs/design-system/spec.md` for the behavior contract.

## Goals / Non-Goals

**Goals**
- A single auditable design-language layer: tokens, primitives, motion, fonts — all in `globals.css` + `layout.tsx`.
- Reskin every existing surface by consuming primitives, never by per-component ad-hoc styling where a primitive exists.
- Preserve every flow, handler, and the client/server import boundary byte-for-byte where it matters (CreateSheet submit handler, single auto-quote callsite, `tileUrl` import).

**Non-Goals**
- New product features (no claim flow, no market lifecycle changes).
- Breaking the verify suite or the Panta/ToU obligations (attribution, staleness, non-custodial claims all unchanged).
- A dark-only or light-only design — both modes stay first-class.

## Decisions

### D1. Tailwind v4 tokens via `@theme` + CSS variables in `:root`
Tokens are plain CSS custom properties in `:root` (light) with a `@media (prefers-color-scheme: dark)` override block; Tailwind v4's `@theme` maps `--font-sans`/`--font-mono` to the `next/font` variables. Colors are oklch (cool neutrals hue ~250, accent 262, YES 152, NO 24) so hue/lightness pairs read consistently in both modes.
*Alternative considered:* Tailwind v4 inline `@theme`-only tokens with `dark:` variants. Rejected — the app already used `prefers-color-scheme` CSS variables site-wide, and keeping the token source in CSS gives server-components and inline `style={{}}` access to the same values.

### D2. Primitives in `@layer components`, not unlayered CSS
Shared classes (`.pulse-card`, `.btn-*`, `.input`, `.chip`, `.sheet*`, `.live-dot`, `.section-head`) are declared inside `@layer components`. In Tailwind v4, unlayered CSS beats every utility; layered components let utilities like `text-center` or `gap-1` override a primitive on a per-use basis without `!`.
*Alternative considered:* one-off Tailwind classes everywhere. Rejected — the whole point is one vocabulary so a future token change restyles the app.

### D3. `next/font` Space Grotesk + JetBrains Mono
Space Grotesk at 400–700 is the display/body face; JetBrains Mono at 400–700 is the data face. Both `display: 'swap'` so first paint never blocks on fonts (network already probed reachable for fonts.googleapis.com).
*Alternative considered:* a single variable font for everything. Rejected — the mono/data distinction is the product's identity (prices are *readouts*), and two faces from Google Fonts cost nothing extra in bundle terms.

### D4. `@phosphor-icons/react` (v2) for icons
Single family, tree-shaken per icon import, no runtime dep at build cost ~0 in First Load JS beyond the icons actually used. Replaces the `✕` glyph closers.
*Alternative considered:* hand-rolled inline SVGs, and the system emoji already present. Rejected — hand-rolled SVG is unmaintainable at this scale and the emoji glyphs were already inconsistent.
*Note:* Phosphor v2 renamed `Activity` → `Waveform`; the room tape header imports `Waveform`.

### D5. Motion is CSS-only
All motion is keyframes + classes in `globals.css` (`.sheet` slide-up, `.live-dot::after` pulse, `.rise` stagger, `.tape-new` flash), gated by the global `prefers-reduced-motion` block. New tape rows keep the `tape-new` animation permanently in the class and rely on React keys — an old row never remounts, so it never replays; a new row animates exactly once.
*Alternative considered:* framer-motion. Rejected — CSS-only is lighter (hotel-wifi), and the app already had a working reduced-motion guard.

### D6. Kalshi-style price board on open markets
Open market cards render a two-cell YES/NO block: sparse uppercase label over a large mono percentage, with a probability split bar below and a `yes:no` ratio footer. Resolved markets show a sealed "Resolved + outcome" panel instead of a stale price split.
*Rationale:* prices are the product; a big tabular price is the most honest way to make them the loudest thing on the card. The YES/NO text label stays (see spec REQ-DS-2).

### D7. Shared sheet shell
`.sheet-scrim` + `.sheet` + `.sheet-handle` replace the per-component modal markups (buy sheet, create sheet, wallet sheet). Bottom-aligned on mobile, centered ≥640px, `max-height: 92vh`, safe-area bottom padding, 260ms `cubic-bezier(0.22,1,0.36,1)` entrance.

## Risks / Trade-offs

- [Two display weights means more font files served] → `next/font` preloads only the used weights; First Load JS stayed ~199 kB (landing) / ~211 kB (room).
- [`next/font` fetches Google Fonts at build time; the build box earlier showed one transient fetch error] → Retry-safe; a failed fetch fails the build loudly rather than shipping fallback fonts silently. CI must have network.
- [Color token change could regress contrast in dark mode] → Both palettes defined side by side; YES/NO designed with hue + lightness + label (verifiable, not eyeballed).
- [Wholesale JSX restyle risked touching verify-pinned CreateSheet logic] → Handlers/effects/imports left verbatim; `npm run verify` still 164/164 after the change.

## Migration Plan

Already shipped (recorded post hoc): the code is committed on `main` (`20ce7dc`). For any downstream branch, rebase/merge that commit; no data migration, no env change. Rollback is a revert of the commit — all logic paths are unchanged, so revert is safe.

## Open Questions

None that would change specs or approach. Visual tweaks — exact oklch lightness values, chip density — are safe to tune later within the spec's constraints.