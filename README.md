# 365 Loan Master (PWA + Google Sheets + Apps Script)

Ledger-based loan management system built for mobile-first usage and installable on iPhone as a Progressive Web App.

## Core Guarantees

- Append-only loan ledger
- Immutable original loan values
- Independent balances per LoanID
- Dynamic outstanding: `sum(all signed transactions)`
- Offline-first queue with later sync

## Project Structure

- `apps-script/Code.gs`: Google Apps Script webhook API
- `apps-script/appsscript.json`: Apps Script manifest
- `web/`: Static PWA frontend (deploy to GitHub Pages)
- `docs/google-sheets-schema.md`: Sheet schema and setup guidance

## Quick Start

1. Create a Google Sheet named `Loan Master`.
2. Open Extensions > Apps Script and replace code with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Deploy Apps Script as web app:
   - Execute as: Me
   - Access: Anyone with link
4. In the PWA, open Settings and set your Apps Script URL.
5. Run `Initialize` once with a 4-8 digit PIN.
6. Deploy this repository root to GitHub Pages (the root `index.html` redirects to `web/index.html`).
7. On iPhone Safari, open app URL and tap Share > Add to Home Screen.

## Security Notes

- PIN is validated server-side in Apps Script.
- Session token expires after 30 minutes.
- Use a private Google account and restrict who has the web app URL.
- Do not store sensitive personal data beyond operational need.

## Financial Rules Implemented

- Base loan:
  - `originalTotal = principal + (principal * interestRate) + disbursementFee`
- Outstanding:
  - `outstanding = SUM(LOAN_TRANSACTIONS.AmountCents)`
- Penalty extension:
  - `penalty = outstanding * 0.20` (default)
- Recalc extension:
  - `extensionInterest = outstanding * 0.35` (default)
- Interest waivers:
  - negative ledger entries, never delete interest

## Free Hosting

- Frontend: GitHub Pages (free, from repository root)
- Backend: Google Apps Script (free tier)
- Database: Google Sheets (free)

## Known Limits

- Google Sheets concurrency/performance is good for small-midsize operations, but not a full RDBMS.
- Very high transaction volumes should migrate to a proper backend DB.
