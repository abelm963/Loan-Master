# Deployment Steps

## 1) Backend (Google Sheets + Apps Script)

1. Create a Google Sheet file and name it `Loan Master`.
2. Open Extensions > Apps Script.
3. Replace script with [`apps-script/Code.gs`](../apps-script/Code.gs).
4. Replace manifest with [`apps-script/appsscript.json`](../apps-script/appsscript.json).
5. Save and deploy as Web App:
   - Execute as: Me
   - Who has access: Anyone with link
6. Copy the deployed `/exec` URL.

## 2) Frontend (GitHub Pages)

1. Push the repository to GitHub.
2. Enable GitHub Pages from the repository root branch.
3. Open the deployed app URL (root redirects to `web/index.html`).
4. In Settings tab, paste Apps Script URL and save.

## 3) First Run

1. On login screen, enter initial PIN and press `Initialize System` (first run only).
2. Login with that PIN.
3. Create client -> create loan -> open loan detail -> add payments/extensions/waivers.

## 4) Install on iPhone 13

1. Open app in Safari.
2. Tap Share icon.
3. Tap `Add to Home Screen`.
4. Launch from home screen as app.

## 5) Data Integrity Rules

- Never edit rows in `LOAN_TRANSACTIONS` manually.
- Fix mistakes by posting `Adjustment` or `Reversal` transactions.
- Do not overwrite `OriginalTotalCents` in `LOANS`.

## 6) Troubleshooting

- If API calls fail: verify Apps Script URL and deployment access.
- If login fails after inactivity: session likely expired; login again.
- If offline writes are queued: reconnect and tap `Sync`.
