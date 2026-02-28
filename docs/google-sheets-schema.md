# Google Sheets Schema

All money values are stored in cents as integers.

## 1) CLIENTS

| Column | Type | Notes |
|---|---|---|
| ClientID | UUID string | Primary key |
| Name | string | Required |
| Phone | string | Optional |
| DefaultInterestPct | number | e.g. 35 |
| Notes | string | Optional |
| RiskFlag | string | LOW/MEDIUM/HIGH |
| CreatedAt | ISO datetime | UTC |
| CreatedBy | string | Session user |

## 2) LOANS

| Column | Type | Notes |
|---|---|---|
| LoanID | UUID string | Primary key |
| ClientID | UUID string | Foreign key to CLIENTS |
| PrincipalCents | int | Required |
| InterestRateUsedPct | number | Default 35 |
| DisbursementFeeApplied | boolean | true/false |
| DisbursementFeeCents | int | Default 2000 if applied |
| BaseInterestCents | int | Principal * rate |
| OriginalTotalCents | int | Immutable |
| DateIssued | YYYY-MM-DD | Required |
| DueDate | YYYY-MM-DD | Required |
| ExtensionCount | int | Increment only |
| CreatedAt | ISO datetime | UTC |
| CreatedBy | string | Session user |

## 3) LOAN_TRANSACTIONS

Append-only. Never edit or delete rows.

| Column | Type | Notes |
|---|---|---|
| TransactionID | UUID string | Primary key |
| LoanID | UUID string | Foreign key to LOANS |
| Type | enum | Base Loan, Payment, Penalty, Extension Interest, Interest Waiver, Adjustment, Reversal |
| AmountCents | int | Signed amount |
| Date | YYYY-MM-DD | Business date |
| Notes | string | Optional |
| CreatedAt | ISO datetime | UTC |
| CreatedBy | string | Session user |
| DeviceID | string | Client device identifier |
| SyncStatus | string | SYNCED or QUEUED metadata |
| ReferenceTransactionID | string | Optional for reversal links |

Signed convention:
- Charges: positive (`+`) -> Base Loan, Penalty, Extension Interest
- Reductions: negative (`-`) -> Payment, Interest Waiver
- Flexible: Adjustment/Reversal can be positive or negative

## 4) SYSTEM_LOG

| Column | Type | Notes |
|---|---|---|
| LogID | UUID string | Primary key |
| Action | string | e.g. CREATE_LOAN |
| Entity | string | CLIENT/LOAN/LOAN_TRANSACTION |
| EntityID | string | Related ID |
| PayloadJson | JSON string | Raw payload snapshot |
| Timestamp | ISO datetime | UTC |
| CreatedBy | string | Session user |
| DeviceID | string | Session device |

## Financial Computation Rules

- Base loan booking:
  - `baseInterest = principal * (interestRate / 100)`
  - `originalTotal = principal + baseInterest + disbursementFee`
- Outstanding:
  - `outstanding = SUM(LOAN_TRANSACTIONS.AmountCents WHERE LoanID = X)`
- Extension modes:
  - Penalty mode: `amount = outstanding * 0.20` default
  - Recalc mode: `amount = outstanding * 0.35` default

## API Actions (Apps Script)

Public:
- `initialize`
- `login`
- `changePin`

Authed:
- `createClient`
- `createLoan`
- `addTransaction`
- `extendLoan`
- `listClients`
- `listLoans`
- `getLoanLedger`
- `dashboard`
- `monthlyReport`
- `syncBatch`

## Example Request

```json
{
  "action": "createLoan",
  "sessionToken": "<token>",
  "payload": {
    "clientId": "...",
    "principal": "5000.00",
    "interestRatePct": 35,
    "disbursementFeeApplied": true,
    "dateIssued": "2026-02-28",
    "dueDate": "2026-03-30"
  }
}
```
