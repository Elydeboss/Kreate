# Design System

## Purpose

One deliberate design language across every Pulse surface: cool neutral surfaces, a single electric-blue accent, and a YES/NO pair that is the two loud axes of the product — so a reader can always tell what is a price, what is an action, what is live, and what is stale, without relying on color alone.

## ADDED Requirements

### Requirement: One brand accent
The entire UI MUST use exactly one decorative accent color (electric blue). Any other strong color on screen MUST carry product meaning — YES, NO, warn, or danger — never decoration.

#### Scenario: A single loud color on the landing
- **WHEN** the landing page renders
- **THEN** the only saturated brand color is the accent used on the headline "money on it." and the top hairline, with every other surface neutral.

### Requirement: YES and NO are distinguishable without color
YES and NO MUST differ in hue, in lightness, and MUST always carry a text label ("YES" / "NO") wherever they are shown, in both light and dark mode.

#### Scenario: A colour-blind reader on the market board
- **WHEN** an open market card renders its two side blocks
- **THEN** each block shows an uppercase "YES" or "NO" label next to its percentage, so the sides are identifiable even if the hue difference is invisible.

### Requirement: Cool neutral surfaces in light and dark
Surfaces SHALL render in one cool neutral family in both light and dark mode via `prefers-color-scheme`; raised cards SHALL sit on a distinct raised surface with a hairline border in both modes.

#### Scenario: Dark-mode room
- **WHEN** a room renders on a device in dark mode
- **THEN** the card surfaces are dark-cool neutrals with visible borders, text contrast stays readable, and no light-mode-only surface leaks in.

### Requirement: Tabular numerals for comparable numbers
Every numeric value that is compared vertically — prices, USDC amounts, counts, rankings, countdowns — SHALL render with tabular numerals so a column of numbers aligns.

#### Scenario: A tape column
- **WHEN** the tape lists trade amounts in a column
- **THEN** the amounts align on the decimal point because the digits are tabular.

### Requirement: Display and data faces
Space Grotesk SHALL be the default sans face for all display/body text and JetBrains Mono the default mono face for every number (prices, amounts, invite codes, signatures, countdowns), both loaded via `next/font` with `display: swap` so fonts never block first paint.

#### Scenario: First paint on slow wifi
- **WHEN** the landing page loads on a slow connection
- **THEN** the page renders immediately in the fallback font stack and swaps to Space Grotesk/JetBrains Mono when the fonts arrive.

### Requirement: Shared primitives
Cards, buttons, inputs, chips, and section labels SHALL be drawn from shared primitive classes, so a change to a primitive restyles every consumer consistently.

#### Scenario: A primitive change propagates
- **WHEN** the shared card primitive's border is updated in one place
- **THEN** every card across landing, room, and sheets takes the new border without per-component edits.

### Requirement: Complete button vocabulary
Button variants SHALL cover: one loud primary (accent-filled), a quiet secondary (bordered ghost), and the YES/NO pair (washed field with a colored edge and the price readout inside). The primary button SHALL have a pressed state that reads as physical — a light-catching top edge and a slight scale-down — so a tap that spends money is unmistakable.

#### Scenario: Confirming a buy
- **WHEN** a user presses the confirm button on the buy sheet
- **THEN** the button visually depresses (scale + edge change) at the moment of the tap.

### Requirement: One sheet shell for all modals
All modal surfaces SHALL be bottom sheets on mobile and centered sheets at ≥640px, using one shared shell: scrim, slide-up entrance, grabber handle, and safe-area bottom padding.

#### Scenario: Opening the create sheet on a phone
- **WHEN** a host taps "Call a market" on a narrow viewport
- **THEN** the sheet slides up from the bottom, shows the grabber at the top, and its content clears the home-indicator safe area.

### Requirement: Live is signaled by a pulsing dot
The "live" state SHALL always be indicated by a pulsing green dot, rendered only while a session is actively running.

#### Scenario: A session that has ended
- **WHEN** a session's time runs out
- **THEN** the pulsing dot disappears from the room header and the countdown reads "Ended".

### Requirement: Motion is CSS-only and reduced-motion aware
All animation SHALL be CSS-only (no animation library) and SHALL collapse to near-zero duration under `prefers-reduced-motion: reduce`.

#### Scenario: Reduced-motion reader
- **WHEN** a reader has `prefers-reduced-motion: reduce` and a sheet opens
- **THEN** the entrance and any flash animations complete in near-zero time with no meaningful movement.

### Requirement: 44px touch targets and visible focus
Every interactive control (button, input, select, role="button" anchors) SHALL meet a 44px minimum touch target, and keyboard focus SHALL always be visible via an accent outline on `:focus-visible`.

#### Scenario: Keyboard navigation through a form
- **WHEN** a user tabs through the create-sheet form
- **THEN** each focused field shows a clear accent outline and every control is at least 44px tall.

### Requirement: Compliance surfaces keep their obligations
The "Powered by Panta" attribution SHALL render as a styled lockup but MUST preserve the exact attribution string with no hiding prop; the staleness stamp SHALL render "as of HH:MM:SS" in mono and SHALL switch to an amber warn treatment whenever the value is stale, so a cached price is never presented as live.

#### Scenario: A circuit-breaker read
- **WHEN** a market's price was served with the breaker open (`stale: true`)
- **THEN** its "as of" stamp uses the warn treatment and the reader is told the price is not a live quote.