/**
 * Loan Master Apps Script Backend
 * Ledger-based append-only microfinance API.
 */

var SHEETS = {
  CLIENTS: 'CLIENTS',
  LOANS: 'LOANS',
  LOAN_TRANSACTIONS: 'LOAN_TRANSACTIONS',
  SYSTEM_LOG: 'SYSTEM_LOG'
};

var TX_TYPES = {
  BASE_LOAN: 'Base Loan',
  PAYMENT: 'Payment',
  PENALTY: 'Penalty',
  EXTENSION_INTEREST: 'Extension Interest',
  INTEREST_WAIVER: 'Interest Waiver',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Reversal'
};

var CONFIG = {
  DEFAULT_INTEREST_PCT: 35,
  DEFAULT_DISBURSEMENT_FEE_CENTS: 2000,
  DEFAULT_EXTENSION_PENALTY_PCT: 20,
  DEFAULT_EXTENSION_INTEREST_PCT: 35,
  DEFAULT_EXTENSION_DAYS: 30,
  SESSION_TTL_SECONDS: 60 * 30
};

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';

  if (action === 'ping') {
    return jsonResponse_({ ok: true, message: 'Loan Master API online', time: nowIso_() });
  }

  if (action === 'initStatus') {
    return jsonResponse_({
      ok: true,
      data: {
        initialized: !!getPinHash_(),
        version: '1.0.0'
      }
    });
  }

  return jsonResponse_({ ok: false, error: 'Unsupported GET action: ' + action });
}

function doPost(e) {
  try {
    var body = parseJsonBody_(e);
    var action = body.action;
    var payload = body.payload || {};

    if (!action) {
      return jsonResponse_({ ok: false, error: 'Missing action' });
    }

    if (action === 'initialize') {
      return jsonResponse_(handleInitialize_(payload));
    }

    if (action === 'login') {
      return jsonResponse_(handleLogin_(payload));
    }

    if (action === 'changePin') {
      return jsonResponse_(handleChangePin_(payload));
    }

    var session = requireSession_(body.sessionToken);
    var result = routeAuthedAction_(action, payload, session);

    return jsonResponse_(result);
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message || String(err) });
  }
}

function routeAuthedAction_(action, payload, session) {
  if (action === 'createClient') return withWriteLock_(function () { return handleCreateClient_(payload, session); });
  if (action === 'createLoan') return withWriteLock_(function () { return handleCreateLoan_(payload, session); });
  if (action === 'addTransaction') return withWriteLock_(function () { return handleAddTransaction_(payload, session); });
  if (action === 'extendLoan') return withWriteLock_(function () { return handleExtendLoan_(payload, session); });
  if (action === 'syncBatch') return withWriteLock_(function () { return handleSyncBatch_(payload, session); });

  if (action === 'listClients') return handleListClients_();
  if (action === 'listLoans') return handleListLoans_();
  if (action === 'getLoanLedger') return handleGetLoanLedger_(payload);
  if (action === 'dashboard') return handleDashboard_();
  if (action === 'monthlyReport') return handleMonthlyReport_(payload);

  return { ok: false, error: 'Unsupported action: ' + action };
}

function handleInitialize_(payload) {
  var created = ensureCoreSheets_();
  var pinHash = getPinHash_();

  if (!pinHash) {
    var initialPin = String(payload.initialPin || '').trim();
    if (!/^\d{4,8}$/.test(initialPin)) {
      return { ok: false, error: 'Initialization requires initialPin with 4-8 digits' };
    }
    setPinHash_(hashPin_(initialPin));
  }

  return {
    ok: true,
    data: {
      message: 'System initialized',
      sheetsCreated: created,
      initialized: true
    }
  };
}

function handleLogin_(payload) {
  var pin = String(payload.pin || '').trim();
  if (!/^\d{4,8}$/.test(pin)) {
    return { ok: false, error: 'PIN must be 4-8 digits' };
  }

  var pinHash = getPinHash_();
  if (!pinHash) {
    return { ok: false, error: 'System not initialized. Run initialize first.' };
  }

  if (hashPin_(pin) !== pinHash) {
    return { ok: false, error: 'Invalid PIN' };
  }

  var token = Utilities.getUuid();
  var deviceId = String(payload.deviceId || 'unknown');
  var session = {
    userId: 'pin-user',
    deviceId: deviceId,
    issuedAt: nowIso_()
  };

  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(session), CONFIG.SESSION_TTL_SECONDS);

  return {
    ok: true,
    data: {
      sessionToken: token,
      expiresInSeconds: CONFIG.SESSION_TTL_SECONDS
    }
  };
}

function handleChangePin_(payload) {
  var currentPin = String(payload.currentPin || '').trim();
  var newPin = String(payload.newPin || '').trim();
  if (!/^\d{4,8}$/.test(newPin)) {
    return { ok: false, error: 'newPin must be 4-8 digits' };
  }

  var pinHash = getPinHash_();
  if (!pinHash) {
    return { ok: false, error: 'System not initialized' };
  }

  if (hashPin_(currentPin) !== pinHash) {
    return { ok: false, error: 'Current PIN is invalid' };
  }

  setPinHash_(hashPin_(newPin));
  return { ok: true, data: { message: 'PIN changed' } };
}

function handleCreateClient_(payload, session) {
  ensureCoreSheets_();

  var name = String(payload.name || '').trim();
  var phone = String(payload.phone || '').trim();
  var notes = String(payload.notes || '').trim();
  var riskFlag = String(payload.riskFlag || 'LOW').toUpperCase();
  var defaultInterestPct = toNumberOrDefault_(payload.defaultInterestPct, CONFIG.DEFAULT_INTEREST_PCT);

  if (!name) {
    return { ok: false, error: 'Client name is required' };
  }

  var clientId = Utilities.getUuid();
  var createdAt = nowIso_();

  appendRow_(SHEETS.CLIENTS, [
    clientId,
    name,
    phone,
    round2_(defaultInterestPct),
    notes,
    riskFlag,
    createdAt,
    session.userId
  ]);

  logAction_('CREATE_CLIENT', 'CLIENT', clientId, payload, session);

  return {
    ok: true,
    data: {
      clientId: clientId,
      name: name,
      defaultInterestPct: round2_(defaultInterestPct),
      createdAt: createdAt
    }
  };
}

function handleCreateLoan_(payload, session) {
  ensureCoreSheets_();

  var clientId = String(payload.clientId || '').trim();
  if (!clientId) {
    return { ok: false, error: 'clientId is required' };
  }

  if (!recordExistsById_(SHEETS.CLIENTS, 'ClientID', clientId)) {
    return { ok: false, error: 'Client not found' };
  }

  var principalCents = payload.principalCents !== undefined && payload.principalCents !== null && payload.principalCents !== ''
    ? toIntegerOrDefault_(payload.principalCents, 0)
    : toCents_(payload.principal);
  if (principalCents <= 0) {
    return { ok: false, error: 'Principal must be greater than zero' };
  }

  var interestRateUsedPct = toNumberOrDefault_(payload.interestRatePct, CONFIG.DEFAULT_INTEREST_PCT);
  var disbursementFeeApplied = payload.disbursementFeeApplied !== false;
  var disbursementFeeCents = 0;
  if (disbursementFeeApplied) {
    disbursementFeeCents = payload.disbursementFeeCents !== undefined && payload.disbursementFeeCents !== null && payload.disbursementFeeCents !== ''
      ? toIntegerOrDefault_(payload.disbursementFeeCents, CONFIG.DEFAULT_DISBURSEMENT_FEE_CENTS)
      : toCentsOrDefault_(payload.disbursementFee, CONFIG.DEFAULT_DISBURSEMENT_FEE_CENTS);
  }

  var baseInterestCents = Math.round(principalCents * (interestRateUsedPct / 100));
  var originalTotalCents = principalCents + baseInterestCents + disbursementFeeCents;

  var dateIssued = normalizeDateInput_(payload.dateIssued) || todayStr_();
  var dueDate = normalizeDateInput_(payload.dueDate) || addDaysStr_(dateIssued, CONFIG.DEFAULT_EXTENSION_DAYS);

  var loanId = Utilities.getUuid();
  var createdAt = nowIso_();

  appendRow_(SHEETS.LOANS, [
    loanId,
    clientId,
    principalCents,
    round2_(interestRateUsedPct),
    disbursementFeeApplied,
    disbursementFeeCents,
    baseInterestCents,
    originalTotalCents,
    dateIssued,
    dueDate,
    0,
    createdAt,
    session.userId
  ]);

  appendTransaction_({
    loanId: loanId,
    type: TX_TYPES.BASE_LOAN,
    amountCents: originalTotalCents,
    date: dateIssued,
    notes: 'Original loan booked',
    createdBy: session.userId,
    deviceId: session.deviceId || 'unknown',
    syncStatus: 'SYNCED'
  });

  logAction_('CREATE_LOAN', 'LOAN', loanId, payload, session);

  return {
    ok: true,
    data: {
      loanId: loanId,
      clientId: clientId,
      principalCents: principalCents,
      interestRateUsedPct: round2_(interestRateUsedPct),
      disbursementFeeApplied: disbursementFeeApplied,
      disbursementFeeCents: disbursementFeeCents,
      baseInterestCents: baseInterestCents,
      originalTotalCents: originalTotalCents,
      dateIssued: dateIssued,
      dueDate: dueDate,
      outstandingCents: originalTotalCents
    }
  };
}

function handleAddTransaction_(payload, session) {
  ensureCoreSheets_();

  var loanId = String(payload.loanId || '').trim();
  var type = String(payload.type || '').trim();
  var notes = String(payload.notes || '').trim();
  var date = normalizeDateInput_(payload.date) || todayStr_();
  var rawAmountCents = payload.amountCents !== undefined && payload.amountCents !== null && payload.amountCents !== ''
    ? toIntegerOrDefault_(payload.amountCents, 0)
    : toCents_(payload.amount);

  if (!loanId) return { ok: false, error: 'loanId is required' };
  if (!recordExistsById_(SHEETS.LOANS, 'LoanID', loanId)) return { ok: false, error: 'Loan not found' };
  if (!type || type === TX_TYPES.BASE_LOAN) return { ok: false, error: 'Invalid transaction type' };

  var amountCents = normalizeSignedAmount_(type, rawAmountCents);
  if (amountCents === 0) {
    return { ok: false, error: 'Amount must not be zero' };
  }

  appendTransaction_({
    loanId: loanId,
    type: type,
    amountCents: amountCents,
    date: date,
    notes: notes,
    createdBy: session.userId,
    deviceId: session.deviceId || 'unknown',
    syncStatus: 'SYNCED'
  });

  if (payload.newDueDate) {
    updateLoanDueDate_(loanId, normalizeDateInput_(payload.newDueDate));
  }

  logAction_('ADD_TRANSACTION', 'LOAN_TRANSACTION', loanId, payload, session);

  var outstandingCents = calculateOutstandingCents_(loanId);

  return {
    ok: true,
    data: {
      loanId: loanId,
      type: type,
      amountCents: amountCents,
      outstandingCents: outstandingCents,
      status: getLoanStatus_(loanId, outstandingCents)
    }
  };
}

function handleExtendLoan_(payload, session) {
  ensureCoreSheets_();

  var loanId = String(payload.loanId || '').trim();
  var mode = String(payload.mode || '').trim().toLowerCase();
  var notes = String(payload.notes || '').trim();
  var date = normalizeDateInput_(payload.date) || todayStr_();

  if (!loanId) return { ok: false, error: 'loanId is required' };
  if (!recordExistsById_(SHEETS.LOANS, 'LoanID', loanId)) return { ok: false, error: 'Loan not found' };
  if (mode !== 'penalty' && mode !== 'recalc') {
    return { ok: false, error: 'mode must be penalty or recalc' };
  }

  var outstandingCents = calculateOutstandingCents_(loanId);
  if (outstandingCents <= 0) {
    return { ok: false, error: 'Cannot extend a settled loan' };
  }

  var type;
  var ratePct;

  if (mode === 'penalty') {
    type = TX_TYPES.PENALTY;
    ratePct = toNumberOrDefault_(payload.ratePct, CONFIG.DEFAULT_EXTENSION_PENALTY_PCT);
  } else {
    type = TX_TYPES.EXTENSION_INTEREST;
    ratePct = toNumberOrDefault_(payload.ratePct, CONFIG.DEFAULT_EXTENSION_INTEREST_PCT);
  }

  var amountCents = Math.round(outstandingCents * (ratePct / 100));
  if (amountCents <= 0) {
    return { ok: false, error: 'Calculated extension amount must be > 0' };
  }

  appendTransaction_({
    loanId: loanId,
    type: type,
    amountCents: amountCents,
    date: date,
    notes: notes || ('Extension (' + mode + ') at ' + round2_(ratePct) + '%'),
    createdBy: session.userId,
    deviceId: session.deviceId || 'unknown',
    syncStatus: 'SYNCED'
  });

  var loan = getLoanById_(loanId);
  var daysToAdd = toIntegerOrDefault_(payload.daysToAdd, CONFIG.DEFAULT_EXTENSION_DAYS);
  var newDueDate = normalizeDateInput_(payload.newDueDate) || addDaysStr_(loan.DueDate, daysToAdd);
  updateLoanDueDate_(loanId, newDueDate);
  incrementLoanExtensionCount_(loanId);

  logAction_('EXTEND_LOAN', 'LOAN', loanId, payload, session);

  var newOutstandingCents = calculateOutstandingCents_(loanId);

  return {
    ok: true,
    data: {
      loanId: loanId,
      extensionType: type,
      extensionRatePct: round2_(ratePct),
      extensionAmountCents: amountCents,
      newDueDate: newDueDate,
      outstandingCents: newOutstandingCents,
      status: getLoanStatus_(loanId, newOutstandingCents)
    }
  };
}

function handleSyncBatch_(payload, session) {
  var operations = payload.operations || [];
  if (!Array.isArray(operations)) {
    return { ok: false, error: 'operations must be an array' };
  }

  var results = [];
  for (var i = 0; i < operations.length; i++) {
    var op = operations[i] || {};
    var action = op.action;
    var opPayload = op.payload || {};
    var mutationId = op.mutationId || ('op_' + i);

    var result;
    try {
      if (action === 'createClient') {
        result = handleCreateClient_(opPayload, session);
      } else if (action === 'createLoan') {
        result = handleCreateLoan_(opPayload, session);
      } else if (action === 'addTransaction') {
        result = handleAddTransaction_(opPayload, session);
      } else if (action === 'extendLoan') {
        result = handleExtendLoan_(opPayload, session);
      } else {
        result = { ok: false, error: 'Unsupported batch action: ' + action };
      }
    } catch (err) {
      result = { ok: false, error: err.message || String(err) };
    }

    results.push({
      mutationId: mutationId,
      action: action,
      result: result
    });
  }

  return {
    ok: true,
    data: {
      processed: results.length,
      results: results
    }
  };
}

function handleListClients_() {
  ensureCoreSheets_();
  var rows = getDataRowsAsObjects_(SHEETS.CLIENTS);
  return { ok: true, data: rows };
}

function handleListLoans_() {
  ensureCoreSheets_();

  var loans = getDataRowsAsObjects_(SHEETS.LOANS);
  var txRows = getDataRowsAsObjects_(SHEETS.LOAN_TRANSACTIONS);

  var outstandingByLoan = {};
  txRows.forEach(function (tx) {
    var loanId = tx.LoanID;
    var amount = toIntegerOrDefault_(tx.AmountCents, 0);
    outstandingByLoan[loanId] = (outstandingByLoan[loanId] || 0) + amount;
  });

  var enriched = loans.map(function (loan) {
    var outstandingCents = outstandingByLoan[loan.LoanID] || 0;
    return {
      LoanID: loan.LoanID,
      ClientID: loan.ClientID,
      PrincipalCents: toIntegerOrDefault_(loan.PrincipalCents, 0),
      InterestRateUsedPct: toNumberOrDefault_(loan.InterestRateUsedPct, CONFIG.DEFAULT_INTEREST_PCT),
      DisbursementFeeApplied: String(loan.DisbursementFeeApplied).toLowerCase() === 'true',
      DisbursementFeeCents: toIntegerOrDefault_(loan.DisbursementFeeCents, 0),
      BaseInterestCents: toIntegerOrDefault_(loan.BaseInterestCents, 0),
      OriginalTotalCents: toIntegerOrDefault_(loan.OriginalTotalCents, 0),
      DateIssued: loan.DateIssued,
      DueDate: loan.DueDate,
      ExtensionCount: toIntegerOrDefault_(loan.ExtensionCount, 0),
      CreatedAt: loan.CreatedAt,
      CreatedBy: loan.CreatedBy,
      OutstandingCents: outstandingCents,
      Status: getLoanStatusFromDueDate_(loan.DueDate, outstandingCents)
    };
  });

  return { ok: true, data: enriched };
}

function handleGetLoanLedger_(payload) {
  ensureCoreSheets_();

  var loanId = String(payload.loanId || '').trim();
  if (!loanId) {
    return { ok: false, error: 'loanId is required' };
  }

  var loan = getLoanById_(loanId);
  if (!loan) {
    return { ok: false, error: 'Loan not found' };
  }

  var txRows = getDataRowsAsObjects_(SHEETS.LOAN_TRANSACTIONS)
    .filter(function (row) { return row.LoanID === loanId; })
    .map(function (row) {
      return {
        TransactionID: row.TransactionID,
        LoanID: row.LoanID,
        Type: row.Type,
        AmountCents: toIntegerOrDefault_(row.AmountCents, 0),
        Date: row.Date,
        Notes: row.Notes,
        CreatedAt: row.CreatedAt,
        CreatedBy: row.CreatedBy,
        DeviceID: row.DeviceID,
        SyncStatus: row.SyncStatus,
        ReferenceTransactionID: row.ReferenceTransactionID
      };
    })
    .sort(function (a, b) {
      var aTime = a.CreatedAt || a.Date;
      var bTime = b.CreatedAt || b.Date;
      if (aTime < bTime) return -1;
      if (aTime > bTime) return 1;
      return 0;
    });

  var outstandingCents = txRows.reduce(function (sum, tx) {
    return sum + tx.AmountCents;
  }, 0);

  return {
    ok: true,
    data: {
      loan: loan,
      transactions: txRows,
      outstandingCents: outstandingCents,
      status: getLoanStatusFromDueDate_(loan.DueDate, outstandingCents)
    }
  };
}

function handleDashboard_() {
  ensureCoreSheets_();

  var loansResp = handleListLoans_();
  if (!loansResp.ok) return loansResp;

  var loans = loansResp.data;
  var summary = {
    totalLoans: loans.length,
    activeLoans: 0,
    dueTodayLoans: 0,
    overdueLoans: 0,
    settledLoans: 0,
    totalOutstandingCents: 0
  };

  loans.forEach(function (loan) {
    summary.totalOutstandingCents += loan.OutstandingCents;
    if (loan.Status === 'ACTIVE') summary.activeLoans += 1;
    if (loan.Status === 'DUE TODAY') summary.dueTodayLoans += 1;
    if (loan.Status === 'OVERDUE') summary.overdueLoans += 1;
    if (loan.Status === 'SETTLED') summary.settledLoans += 1;
  });

  return { ok: true, data: summary };
}

function handleMonthlyReport_(payload) {
  ensureCoreSheets_();

  var month = String(payload.month || '').trim(); // YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(month)) {
    month = todayStr_().slice(0, 7);
  }

  var txRows = getDataRowsAsObjects_(SHEETS.LOAN_TRANSACTIONS).filter(function (tx) {
    var d = String(tx.Date || tx.CreatedAt || '');
    return d.indexOf(month) === 0;
  });
  var loansInMonth = getDataRowsAsObjects_(SHEETS.LOANS).filter(function (loan) {
    return String(loan.DateIssued || '').indexOf(month) === 0;
  });

  var totals = {
    month: month,
    totalChargesCents: 0,
    totalPaymentsCents: 0,
    totalInterestEarnedCents: 0,
    totalPenaltiesCents: 0,
    totalWaiversCents: 0,
    collectionRatePct: 0
  };
  totals.totalInterestEarnedCents = loansInMonth.reduce(function (sum, loan) {
    return sum + toIntegerOrDefault_(loan.BaseInterestCents, 0);
  }, 0);

  txRows.forEach(function (tx) {
    var amount = toIntegerOrDefault_(tx.AmountCents, 0);
    var type = String(tx.Type || '');

    if (amount > 0) totals.totalChargesCents += amount;
    if (type === TX_TYPES.PAYMENT) totals.totalPaymentsCents += Math.abs(amount);
    if (type === TX_TYPES.PENALTY) totals.totalPenaltiesCents += Math.max(0, amount);
    if (type === TX_TYPES.EXTENSION_INTEREST) totals.totalInterestEarnedCents += Math.max(0, amount);
    if (type === TX_TYPES.INTEREST_WAIVER) totals.totalWaiversCents += Math.abs(Math.min(0, amount));
  });

  if (totals.totalChargesCents > 0) {
    totals.collectionRatePct = round2_((totals.totalPaymentsCents / totals.totalChargesCents) * 100);
  }

  return { ok: true, data: totals };
}

function appendTransaction_(input) {
  var txId = Utilities.getUuid();
  appendRow_(SHEETS.LOAN_TRANSACTIONS, [
    txId,
    input.loanId,
    input.type,
    toIntegerOrDefault_(input.amountCents, 0),
    input.date || todayStr_(),
    input.notes || '',
    nowIso_(),
    input.createdBy || 'system',
    input.deviceId || 'unknown',
    input.syncStatus || 'SYNCED',
    input.referenceTransactionId || ''
  ]);
  return txId;
}

function normalizeSignedAmount_(type, rawAmountCents) {
  var absValue = Math.abs(rawAmountCents);

  if (type === TX_TYPES.PAYMENT || type === TX_TYPES.INTEREST_WAIVER) {
    return -absValue;
  }

  if (type === TX_TYPES.PENALTY || type === TX_TYPES.EXTENSION_INTEREST) {
    return absValue;
  }

  if (type === TX_TYPES.ADJUSTMENT || type === TX_TYPES.REVERSAL) {
    return rawAmountCents;
  }

  throw new Error('Unsupported transaction type: ' + type);
}

function calculateOutstandingCents_(loanId) {
  var txRows = getDataRowsAsObjects_(SHEETS.LOAN_TRANSACTIONS);
  var total = 0;
  txRows.forEach(function (tx) {
    if (tx.LoanID === loanId) {
      total += toIntegerOrDefault_(tx.AmountCents, 0);
    }
  });
  return total;
}

function getLoanById_(loanId) {
  var rows = getDataRowsAsObjects_(SHEETS.LOANS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].LoanID === loanId) {
      return rows[i];
    }
  }
  return null;
}

function getLoanStatus_(loanId, outstandingCents) {
  var loan = getLoanById_(loanId);
  if (!loan) return 'UNKNOWN';
  return getLoanStatusFromDueDate_(loan.DueDate, outstandingCents);
}

function getLoanStatusFromDueDate_(dueDate, outstandingCents) {
  if (outstandingCents <= 0) return 'SETTLED';

  var due = normalizeDateInput_(dueDate);
  var today = todayStr_();

  if (due === today) return 'DUE TODAY';
  if (due < today) return 'OVERDUE';
  return 'ACTIVE';
}

function updateLoanDueDate_(loanId, dueDate) {
  if (!dueDate) return;

  var sheet = getSheet_(SHEETS.LOANS);
  var dataRange = sheet.getDataRange();
  var values = dataRange.getValues();
  var header = values[0];
  var loanIdIdx = header.indexOf('LoanID');
  var dueDateIdx = header.indexOf('DueDate');

  for (var r = 1; r < values.length; r++) {
    if (String(values[r][loanIdIdx]) === loanId) {
      sheet.getRange(r + 1, dueDateIdx + 1).setValue(dueDate);
      return;
    }
  }
}

function incrementLoanExtensionCount_(loanId) {
  var sheet = getSheet_(SHEETS.LOANS);
  var values = sheet.getDataRange().getValues();
  var header = values[0];
  var loanIdIdx = header.indexOf('LoanID');
  var countIdx = header.indexOf('ExtensionCount');

  for (var r = 1; r < values.length; r++) {
    if (String(values[r][loanIdIdx]) === loanId) {
      var current = toIntegerOrDefault_(values[r][countIdx], 0);
      sheet.getRange(r + 1, countIdx + 1).setValue(current + 1);
      return;
    }
  }
}

function ensureCoreSheets_() {
  var created = [];

  created = created.concat(ensureSheet_(SHEETS.CLIENTS, [
    'ClientID',
    'Name',
    'Phone',
    'DefaultInterestPct',
    'Notes',
    'RiskFlag',
    'CreatedAt',
    'CreatedBy'
  ]));

  created = created.concat(ensureSheet_(SHEETS.LOANS, [
    'LoanID',
    'ClientID',
    'PrincipalCents',
    'InterestRateUsedPct',
    'DisbursementFeeApplied',
    'DisbursementFeeCents',
    'BaseInterestCents',
    'OriginalTotalCents',
    'DateIssued',
    'DueDate',
    'ExtensionCount',
    'CreatedAt',
    'CreatedBy'
  ]));

  created = created.concat(ensureSheet_(SHEETS.LOAN_TRANSACTIONS, [
    'TransactionID',
    'LoanID',
    'Type',
    'AmountCents',
    'Date',
    'Notes',
    'CreatedAt',
    'CreatedBy',
    'DeviceID',
    'SyncStatus',
    'ReferenceTransactionID'
  ]));

  created = created.concat(ensureSheet_(SHEETS.SYSTEM_LOG, [
    'LogID',
    'Action',
    'Entity',
    'EntityID',
    'PayloadJson',
    'Timestamp',
    'CreatedBy',
    'DeviceID'
  ]));

  return created;
}

function ensureSheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
    return [name];
  }

  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
    return [];
  }

  var existingHeader = sheet.getRange(1, 1, 1, Math.max(lastCol, header.length)).getValues()[0];
  var mismatch = false;
  for (var i = 0; i < header.length; i++) {
    if (String(existingHeader[i] || '') !== header[i]) {
      mismatch = true;
      break;
    }
  }

  if (mismatch) {
    throw new Error('Header mismatch in sheet \"' + name + '\". Fix columns to match expected schema before continuing.');
  }

  return [];
}

function appendRow_(sheetName, values) {
  var sheet = getSheet_(sheetName);
  sheet.appendRow(values);
}

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error('Missing sheet: ' + name);
  }
  return sheet;
}

function getDataRowsAsObjects_(sheetName) {
  var sheet = getSheet_(sheetName);
  var values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) {
    return [];
  }

  var header = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];

  for (var r = 1; r < values.length; r++) {
    var row = {};
    for (var c = 0; c < header.length; c++) {
      row[header[c]] = values[r][c];
    }
    rows.push(row);
  }

  return rows;
}

function recordExistsById_(sheetName, idColumnName, idValue) {
  var rows = getDataRowsAsObjects_(sheetName);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idColumnName]) === String(idValue)) {
      return true;
    }
  }
  return false;
}

function logAction_(action, entity, entityId, payload, session) {
  appendRow_(SHEETS.SYSTEM_LOG, [
    Utilities.getUuid(),
    action,
    entity,
    entityId,
    JSON.stringify(payload || {}),
    nowIso_(),
    (session && session.userId) || 'system',
    (session && session.deviceId) || 'unknown'
  ]);
}

function withWriteLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function requireSession_(token) {
  if (!token) {
    throw new Error('Missing sessionToken');
  }

  var raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) {
    throw new Error('Session expired or invalid');
  }

  var session = JSON.parse(raw);
  CacheService.getScriptCache().put('sess_' + token, raw, CONFIG.SESSION_TTL_SECONDS);
  return session;
}

function getPinHash_() {
  return PropertiesService.getScriptProperties().getProperty('APP_PIN_HASH');
}

function setPinHash_(pinHash) {
  PropertiesService.getScriptProperties().setProperty('APP_PIN_HASH', pinHash);
}

function hashPin_(pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pin, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }

  var raw = e.postData.contents;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Invalid JSON body');
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function nowIso_() {
  return new Date().toISOString();
}

function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function normalizeDateInput_(dateValue) {
  if (!dateValue) return null;

  if (Object.prototype.toString.call(dateValue) === '[object Date]') {
    return Utilities.formatDate(dateValue, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  var s = String(dateValue).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  var d = new Date(s);
  if (isNaN(d.getTime())) {
    return null;
  }

  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDaysStr_(baseDateStr, days) {
  var base = new Date(baseDateStr + 'T00:00:00');
  if (isNaN(base.getTime())) {
    base = new Date();
  }
  base.setDate(base.getDate() + toIntegerOrDefault_(days, 0));
  return Utilities.formatDate(base, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function toCents_(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Math.round(value * 100);

  var sanitized = String(value).replace(/[^0-9.-]/g, '');
  var n = parseFloat(sanitized);
  if (isNaN(n)) return 0;
  return Math.round(n * 100);
}

function toCentsOrDefault_(value, fallback) {
  var cents = toCents_(value);
  return cents === 0 && (value === null || value === undefined || value === '') ? fallback : cents;
}

function toNumberOrDefault_(value, fallback) {
  var n = parseFloat(value);
  return isNaN(n) ? fallback : n;
}

function toIntegerOrDefault_(value, fallback) {
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}
