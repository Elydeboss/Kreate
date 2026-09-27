# Pulse — Product Requirements

> Social prediction markets for the moments your group is already arguing about.
> Powered by the Panta API on Solana.

| | |
|---|---|
| **Track** | Colosseum Crypto World's Fair — official submission + Panta Sidetrack (Superteam Earn) |
| **Prize** | $5,000 USDG pool (2k / 1k / 1k / 1k) |
| **Team** | Solo |
| **Deadline** | 16 days from kickoff |
| **Status** | Specification frozen. Build against this. |

---

## 1. Problem

Small groups already make predictions constantly — in WhatsApp threads, at viewing
centres, in group chats during a match. "Goal before half time." "Referee gives a
penalty." "He gets subbed off."

Those arguments have two properties that prediction markets are built for and
prediction *platforms* are bad at:

1. **They are shared.** The whole group has an opinion, and the argument has a
   natural social cost.
2. **They have a short shelf life.** They resolve in 90 minutes, not in nine months.

Today, the only way to act on that moment is a sportsbook — you against a bookmaker,
alone, with no visibility into who else believed what. Or nothing at all.

## 2. Solution

Pulse turns a live group moment into shared, on-chain, binary YES/NO markets.

A small group (**Circle**) opens a **Live Session** during an event. Anyone in the
group creates a fast prediction from a template. Anyone can buy YES or NO with real
USDC while the event is still happening. When it ends, the session shows who was
right, who was wrong, and the net USDC.

**One line:** put your money where your mouth is — with your people.

## 3. Why prediction-market *infrastructure* makes this possible

This is the core thesis and it must be legible in the submission.

A traditional prediction market platform will not let you create a market about
something happening in the next four minutes. Creation windows are long, categories
are fixed, and every market is designed to outlive the moment.

The Panta API exposes two capabilities that change that:

| Capability | What it unlocks |
|---|---|
| `marketType: "breaking"` + `eventInProgress: true` | Skips the `minimumStartDelay` (typically 3600s) on `startTime`. A market can be **tradeable immediately**, inside a live event window. |
| Quote → build → sign → broadcast → register | Pulse never custodies keys. A user creates and trades from their own wallet, in a session that lasts 90 minutes, with no KYC and no custody. |

A watch party on a prediction market platform is not a feature request. On Panta it is
a two-field change. That is the "why is this possible, and only possible this way"
answer the brief asks for.

## 4. Users

| User | Need |
|---|---|
| Friend group watching a match | Argue with consequences, together, in the next 30 seconds |
| Creator with an audience | Let the audience trade on what the creator is talking about |
| Community organiser | One link, whole group in, no setup |

**Design constraints that are genuine, not marketing:** mobile-first, low-bandwidth
tolerant, no email required, no account recovery flow, works over cellular data.

## 5. Core flows

### 5.1 Join and start a session

```
Connect wallet → open /c/AB3XQ (invite link) → Start Live Session → invite friends
```

### 5.2 The core loop

```
Create Prediction  →  Buy YES / Buy NO  →  price moves  →  event happens  →  claim
```

### 5.3 End of session

```
End Session → scoreboard: who called it right, who was wrong, net USDC
```

## 6. Scope

### Must have

- Wallet connection (Phantom, Solflare) — no signup, no email
- Circle: create, invite by code/link, join, member list
- Live Session: start, join, end. Header with live status and countdown
- Create Prediction: template chips, auto-filled resolution rule, pre-attached image
- Buy YES / NO with quick amounts
- Live price display
- Live trade feed (who bought what, from Panta's own trade tape)
- My Positions (wallet-scoped, share-denominated, USD estimate)
- Claim winnings
- Session scoreboard
- "Powered by Panta" attribution
- Mobile-first; real loading, error and empty states

### Should have

- AI "suggest questions" from a typed match context (~3 hours, not a scraping pipeline)
- Panta stats page (attributed volume, markets created, estimated fees)

### Explicitly out of scope

| Cut | Why |
|---|---|
| Creator fee claiming | Requires a *graduated* market (`MARKET_NOT_GRADUATED`, `NO_CREATOR_FEES`). Unreachable in 16 days. |
| Content-to-Market URL scraping | ~2 days, third-party dependency, does not serve the live use case. Replaced by a 3-hour template suggester. |
| Referral rewards | Non-custodial, no off-ramp, no users to refer during a hackathon. Pure liability. |
| Roles & moderation (guest/user/host/admin) | Invisible to judges, pure Postgres cost. |
| Email / phone invites | Wallet is the identity. |
| Notifications | The trade feed is the notification. |
| Embedded wallets | Phantom/Solflare is enough. |
| Native video | Explicitly out. Users watch elsewhere. |

## 7. Judging criteria → how this wins

| Criterion | How Pulse addresses it |
|---|---|
| **Panta API integration** | 15 of 19 documented endpoints used in production paths, including both transaction shapes, breaking markets with `eventInProgress`, trade-tape reads, and attribution reporting on every write. See ARCHITECTURE.md §3. |
| **Technical execution** | Two distinct transaction pipelines, shared rate-limit budget enforced with token buckets, single-flight cache coalescing, circuit breaker with a ToU-mandated staleness stamp, idempotency on every write route. |
| **Product & UX** | One idea, seven screens. Create-a-prediction in two taps. Mobile-first. |
| **Originality** | Not a prediction market *platform* — a prediction market as a social primitive inside a live group moment. |
| **Impact potential** | Watch parties are universal. The watch-party pattern generalises to elections, earnings, crypto, launches. |
| **Traction** | One real watch party with a real community before submission. Screenshots of real users, real trades. |

## 8. Non-goals

- Being a general prediction market. Pulse is a social surface *on top of* Panta markets.
- Custody. Never. No server wallet, no pooled funds, no private keys.
- Being a betting product. Pulse is a group prediction surface. See §10.
- Resolving markets. Panta's oracle does. Pulse displays resolution; it does not decide it.

## 9. Success criteria

**Demo (5 minutes, must be bulletproof)**

1. Pre-wired Circle with 3+ wallets.
2. Live Session open, one market priced.
3. **Create a breaking market live on stage** — two taps, image attached, tradeable immediately.
4. Two wallets buy; price visibly moves; trade feed updates.
5. Claim winnings against an already-resolved market.
6. Session scoreboard.

**Product**

- A user can create a Circle and start a Live Session in under 60 seconds.
- A user can create a market and take a position without leaving the app.
- Full Panta lifecycle works end to end: create, buy, positions, claim, attribute.

**Submission**

- English, working demo, README explaining what was built and how Panta is integrated.

## 10. Compliance posture

- **Attribution.** Panta ToU §6 requires the exact string "Powered by Panta", clear and
  reasonably prominent, associated with the Panta-powered functionality, not removable
  or obscured. Implemented as a component in the market module, the trading interface,
  the positions screen, and the footer. Links to `panta.market`.
- **Staleness.** ToU §5 forbids representing simulated, cached or stale data as live
  Panta data. The circuit breaker surfaces a visible "prices as of HH:MM:SS" stamp
  whenever the cache is serving a background refresh. This is a requirement, not polish.
- **Credentials.** ToU §3 forbids credentials in public source or frontend bundles.
  The key is server-only, env-only, never serialised to the client.
- **Jurisdiction.** ToU §10 places the burden on the developer. Pulse is framed as a
  group prediction surface, not a wagering product. Responsible-use messaging in the
  onboarding copy.
- **Prohibited conduct.** ToU §7 prohibits wash trading and artificial volume. Pulse
  reports only real, on-chain, user-signed trades. No simulated trades anywhere.
