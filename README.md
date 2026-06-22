# Finance Dashboard

Personal, single-user finance & stocks dashboard. Live market data, watchlist, holdings (with P/L), account balances, salary planner, instant what-if calculator. Vanilla HTML/CSS/JS + Firebase Auth/Firestore + a tiny Vercel serverless proxy for Finnhub quotes.

## Architecture

```
Browser ──► /api/quote (Vercel)  ──► Finnhub  (REST, key kept server-side)
   │                                  
   ├─► Firebase Auth   (email/pwd + Google)
   ├─► Firestore       (users/{uid}/{accounts|holdings|watchlist|meta})
   └─► TradingView widgets (ticker tape, symbol overview, market overview, news)
```

## Local dev

1. Install [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`
2. Get a free Finnhub API key at <https://finnhub.io>.
3. Copy env file: `cp .env.local.example .env.local` and fill in `FINNHUB_API_KEY`.
4. Run: `npm run dev` (runs `vercel dev` on <http://localhost:3000>).
5. Open <http://localhost:3000>, sign up with email or Google, and you're in.

## Deploy

1. Push this folder to a (private) GitHub repo.
2. Import the repo in Vercel.
3. Add env vars in the Vercel project Settings:
   - `FINNHUB_API_KEY` — your Finnhub key
   - `ALLOWED_ORIGINS` — your final domain (e.g. `https://finance-dashboard-yourname.vercel.app`); leave blank to allow same-origin only.
4. Deploy.

## Firebase setup

Reuses the existing **`career-solutions-project-tool`** Firebase project (config is in [`js/firebase-init.js`](js/firebase-init.js)).

Required in the Firebase console:
- **Authentication → Sign-in method**: enable Email/Password and Google.
- **Authentication → Settings → Authorized domains**: add your Vercel domain.
- **Firestore Database**: create one if it doesn't exist. Deploy the rules below.
- **Google Cloud Console → APIs & Services → Credentials**: edit the web API key and add an HTTP referrer restriction for your Vercel domain.

Deploy the Firestore rules in [firestore.rules](firestore.rules):

```bash
npm i -g firebase-tools
firebase login
firebase use career-solutions-project-tool
firebase deploy --only firestore:rules
```

## Data model

| Path                                  | Shape |
|---|---|
| `users/{uid}`                         | `{ email, displayName, lastSeen }` |
| `users/{uid}/accounts/{id}`           | `{ name, type, balance, notes, createdAt, updatedAt }` |
| `users/{uid}/holdings/{id}`           | `{ symbol, shares, costBasis, accountId, notes, ... }` |
| `users/{uid}/watchlist/{symbol}`      | `{ symbol, addedAt }` (doc id = symbol) |
| `users/{uid}/meta/salaryPlan`         | `{ targetAnnual, currentAnnual, filingStatus, state, retirementPct, healthMonthly, updatedAt }` |

## Disclaimers

The salary planner uses a simplified 2025 federal bracket model + FICA + flat state rate. It is a **rough estimate**, not tax advice. Verify with the IRS, a CPA, or your actual W-2 before making decisions.

Market data is delayed/best-effort per Finnhub's free tier (60 req/min). The dashboard polls every 30 seconds while the tab is focused and pauses when hidden.
