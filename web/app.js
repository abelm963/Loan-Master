import { cacheGet, cacheSet, openDb, queueAdd, queueDelete, queueList } from './db.js';
import { callApi, getApiUrl, getSessionToken, pingApi, setApiUrl, setSessionToken } from './api.js';

const currency = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });

const state = {
  deviceId: getOrCreateDeviceId_(),
  clients: [],
  loans: [],
  dashboard: null,
  report: null,
  selectedLoanId: null,
  syncing: false
};

const el = {
  loginView: document.getElementById('loginView'),
  appView: document.getElementById('appView'),
  loginStatus: document.getElementById('loginStatus'),
  syncLabel: document.getElementById('syncLabel'),
  toast: document.getElementById('toast'),
  dashboardCards: document.getElementById('dashboardCards'),
  clientsList: document.getElementById('clientsList'),
  loansList: document.getElementById('loansList'),
  loanDetail: document.getElementById('loanDetail'),
  loanClientId: document.getElementById('loanClientId'),
  loanStatusFilter: document.getElementById('loanStatusFilter'),
  reportResult: document.getElementById('reportResult'),
  reportMonth: document.getElementById('reportMonth'),
  loginApiUrl: document.getElementById('loginApiUrl'),
  apiUrl: document.getElementById('apiUrl'),
  paymentForm: document.getElementById('paymentForm'),
  waiverForm: document.getElementById('waiverForm'),
  adjustForm: document.getElementById('adjustForm'),
  extendForm: document.getElementById('extendForm')
};

boot_();

async function boot_() {
  await openDb();
  registerServiceWorker_();

  const apiUrl = getApiUrl();
  el.apiUrl.value = apiUrl;
  if (el.loginApiUrl) el.loginApiUrl.value = apiUrl;
  el.reportMonth.value = new Date().toISOString().slice(0, 7);

  bindEvents_();
  await updateSyncLabel_();

  const sessionToken = getSessionToken();
  if (sessionToken) {
    showApp_();
    try {
      await refreshAll_();
      await syncQueue_();
    } catch (err) {
      setSessionToken('');
      showLogin_();
      setLoginStatus_('Session expired. Please login again.', true);
    }
  } else {
    showLogin_();
  }
}

function bindEvents_() {
  document.getElementById('loginApiSettingsForm').addEventListener('submit', onSaveApiUrl_);
  document.getElementById('initializeForm').addEventListener('submit', onInitialize_);
  document.getElementById('loginForm').addEventListener('submit', onLogin_);
  document.getElementById('apiSettingsForm').addEventListener('submit', onSaveApiUrl_);
  document.getElementById('changePinForm').addEventListener('submit', onChangePin_);
  document.getElementById('clientForm').addEventListener('submit', onCreateClient_);
  document.getElementById('loanForm').addEventListener('submit', onCreateLoan_);
  document.getElementById('paymentForm').addEventListener('submit', onRecordPayment_);
  document.getElementById('waiverForm').addEventListener('submit', onRecordWaiver_);
  document.getElementById('adjustForm').addEventListener('submit', onRecordAdjustment_);
  document.getElementById('extendForm').addEventListener('submit', onExtendLoan_);
  document.getElementById('reportForm').addEventListener('submit', onLoadReport_);
  document.getElementById('exportCsvBtn').addEventListener('click', onExportCsv_);
  document.getElementById('refreshBtn').addEventListener('click', refreshAll_);
  document.getElementById('syncNowBtn').addEventListener('click', syncQueue_);
  document.getElementById('logoutBtn').addEventListener('click', onLogout_);

  document.querySelectorAll('.bottom-nav button[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setTab_(btn.dataset.tab));
  });

  document.querySelectorAll('[data-open-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setTab_(btn.dataset.openTab));
  });

  el.loanStatusFilter.addEventListener('change', renderLoans_);

  window.addEventListener('online', async () => {
    await updateSyncLabel_();
    await syncQueue_();
  });

  window.addEventListener('offline', updateSyncLabel_);
}

async function onInitialize_(event) {
  event.preventDefault();
  try {
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const initialPin = String(form.get('initialPin') || '').trim();
    const resp = await callApi('initialize', { initialPin }, '');
    if (!resp.ok) throw new Error(resp.error || 'Initialization failed');
    setLoginStatus_('Initialized. You can now login.', false);
  } catch (err) {
    setLoginStatus_(err.message, true);
  }
}

async function onLogin_(event) {
  event.preventDefault();
  try {
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const pin = String(form.get('pin') || '').trim();
    const resp = await callApi('login', { pin, deviceId: state.deviceId }, '');
    if (!resp.ok) throw new Error(resp.error || 'Login failed');

    setSessionToken(resp.data.sessionToken);
    showApp_();
    showToast_('Login successful');
    await refreshAll_();
    await syncQueue_();
  } catch (err) {
    setLoginStatus_(err.message, true);
  }
}

async function onSaveApiUrl_(event) {
  event.preventDefault();
  const formEl = event.currentTarget;
  const form = new FormData(formEl);
  const url = String(form.get('apiUrl') || '').trim();
  setApiUrl(url);
  if (el.apiUrl) el.apiUrl.value = url;
  if (el.loginApiUrl) el.loginApiUrl.value = url;

  const ping = await pingApi();
  if (ping.ok) {
    showToast_('API URL saved and reachable');
  } else {
    showToast_('API URL saved. Ping failed: ' + (ping.error || 'unknown'));
  }

  await updateSyncLabel_();
}

async function onChangePin_(event) {
  event.preventDefault();
  try {
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const currentPin = String(form.get('currentPin') || '').trim();
    const newPin = String(form.get('newPin') || '').trim();

    const resp = await callApi('changePin', { currentPin, newPin });
    if (!resp.ok) throw new Error(resp.error || 'PIN change failed');

    showToast_('PIN changed');
    formEl.reset();
  } catch (err) {
    showToast_(err.message);
  }
}

async function onCreateClient_(event) {
  event.preventDefault();
  try {
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const payload = {
      name: String(form.get('name') || '').trim(),
      phone: String(form.get('phone') || '').trim(),
      defaultInterestPct: form.get('defaultInterestPct') || '',
      notes: String(form.get('notes') || '').trim(),
      riskFlag: String(form.get('riskFlag') || 'LOW')
    };

    const result = await writeAction_('createClient', payload);
    if (!result.queued) {
      showToast_('Client saved');
      formEl.reset();
      await refreshAll_();
    }
  } catch (err) {
    showToast_(err.message);
  }
}

async function onCreateLoan_(event) {
  event.preventDefault();
  try {
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const payload = {
      clientId: String(form.get('clientId') || '').trim(),
      principal: String(form.get('principal') || '').trim(),
      interestRatePct: String(form.get('interestRatePct') || '').trim(),
      disbursementFeeApplied: form.get('disbursementFeeApplied') === 'on',
      dateIssued: String(form.get('dateIssued') || '').trim(),
      dueDate: String(form.get('dueDate') || '').trim()
    };

    const result = await writeAction_('createLoan', payload);
    if (!result.queued) {
      showToast_('Loan created');
      formEl.reset();
      await refreshAll_();
    }
  } catch (err) {
    showToast_(err.message);
  }
}

async function onRecordPayment_(event) {
  event.preventDefault();
  const formEl = event.currentTarget;
  await saveLoanTransaction_(formEl, 'Payment');
}

async function onRecordWaiver_(event) {
  event.preventDefault();
  const formEl = event.currentTarget;
  await saveLoanTransaction_(formEl, 'Interest Waiver');
}

async function onRecordAdjustment_(event) {
  event.preventDefault();
  const formEl = event.currentTarget;
  await saveLoanTransaction_(formEl, 'Adjustment');
}

async function saveLoanTransaction_(formEl, type) {
  try {
    if (!state.selectedLoanId) {
      showToast_('Select a loan first');
      return;
    }

    const form = new FormData(formEl);
    const payload = {
      loanId: state.selectedLoanId,
      type,
      amount: String(form.get('amount') || '').trim(),
      date: String(form.get('date') || '').trim(),
      notes: String(form.get('notes') || '').trim()
    };

    const result = await writeAction_('addTransaction', payload);
    if (!result.queued) {
      formEl.reset();
      await refreshLoanDetail_(state.selectedLoanId);
      await refreshAll_();
      showToast_(type + ' recorded');
    }
  } catch (err) {
    showToast_(err.message);
  }
}

async function onExtendLoan_(event) {
  event.preventDefault();
  try {
    if (!state.selectedLoanId) {
      showToast_('Select a loan first');
      return;
    }

    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const payload = {
      loanId: state.selectedLoanId,
      mode: String(form.get('mode') || '').trim(),
      ratePct: String(form.get('ratePct') || '').trim(),
      daysToAdd: String(form.get('daysToAdd') || '').trim(),
      newDueDate: String(form.get('newDueDate') || '').trim(),
      notes: String(form.get('notes') || '').trim()
    };

    const result = await writeAction_('extendLoan', payload);
    if (!result.queued) {
      formEl.reset();
      await refreshLoanDetail_(state.selectedLoanId);
      await refreshAll_();
      showToast_('Loan extended');
    }
  } catch (err) {
    showToast_(err.message);
  }
}

async function onLoadReport_(event) {
  event.preventDefault();
  try {
    const month = String(el.reportMonth.value || '').trim();
    const resp = await callApi('monthlyReport', { month });
    if (!resp.ok) throw new Error(resp.error || 'Report failed');

    state.report = resp.data;
    renderReport_();
  } catch (err) {
    showToast_(err.message);
  }
}

function onExportCsv_() {
  if (!state.report) {
    showToast_('Load a report first');
    return;
  }

  const rows = [
    ['Metric', 'Value'],
    ['Month', state.report.month],
    ['Total Charges (ZAR)', centsToAmount_(state.report.totalChargesCents)],
    ['Total Payments (ZAR)', centsToAmount_(state.report.totalPaymentsCents)],
    ['Total Extension Interest (ZAR)', centsToAmount_(state.report.totalInterestEarnedCents)],
    ['Total Penalties (ZAR)', centsToAmount_(state.report.totalPenaltiesCents)],
    ['Total Waivers (ZAR)', centsToAmount_(state.report.totalWaiversCents)],
    ['Collection Rate (%)', state.report.collectionRatePct]
  ];

  const csv = rows.map((r) => r.map(csvEscape_).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `loan-master-report-${state.report.month}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function onLogout_() {
  setSessionToken('');
  state.selectedLoanId = null;
  showLogin_();
}

async function refreshAll_() {
  await Promise.all([loadClients_(), loadLoans_(), loadDashboard_()]);
  renderClients_();
  renderLoans_();
  renderDashboard_();
  await updateSyncLabel_();
}

async function loadClients_() {
  try {
    const resp = await callApi('listClients');
    if (!resp.ok) throw new Error(resp.error || 'Failed loading clients');
    state.clients = resp.data || [];
    await cacheSet('clients', state.clients);
  } catch (err) {
    const cached = await cacheGet('clients');
    state.clients = cached || [];
    if (!cached) throw err;
  }
}

async function loadLoans_() {
  try {
    const resp = await callApi('listLoans');
    if (!resp.ok) throw new Error(resp.error || 'Failed loading loans');
    state.loans = resp.data || [];
    await cacheSet('loans', state.loans);
  } catch (err) {
    const cached = await cacheGet('loans');
    state.loans = cached || [];
    if (!cached) throw err;
  }
}

async function loadDashboard_() {
  try {
    const resp = await callApi('dashboard');
    if (!resp.ok) throw new Error(resp.error || 'Failed loading dashboard');
    state.dashboard = resp.data;
    await cacheSet('dashboard', state.dashboard);
  } catch (err) {
    const cached = await cacheGet('dashboard');
    state.dashboard = cached || null;
    if (!cached) throw err;
  }
}

async function refreshLoanDetail_(loanId) {
  if (!loanId) return;

  try {
    const resp = await callApi('getLoanLedger', { loanId });
    if (!resp.ok) throw new Error(resp.error || 'Failed loading ledger');
    renderLoanDetail_(resp.data);
    await cacheSet(`loan_${loanId}`, resp.data);
  } catch (err) {
    const cached = await cacheGet(`loan_${loanId}`);
    if (cached) {
      renderLoanDetail_(cached);
      return;
    }
    showToast_(err.message);
  }
}

function renderDashboard_() {
  const d = state.dashboard || {
    totalLoans: state.loans.length,
    activeLoans: countByStatus_('ACTIVE'),
    dueTodayLoans: countByStatus_('DUE TODAY'),
    overdueLoans: countByStatus_('OVERDUE'),
    settledLoans: countByStatus_('SETTLED'),
    totalOutstandingCents: state.loans.reduce((sum, l) => sum + (Number(l.OutstandingCents) || 0), 0)
  };

  const items = [
    ['Total Loans', d.totalLoans],
    ['Outstanding', formatCents_(d.totalOutstandingCents)],
    ['Active', d.activeLoans],
    ['Due Today', d.dueTodayLoans],
    ['Overdue', d.overdueLoans],
    ['Settled', d.settledLoans]
  ];

  el.dashboardCards.innerHTML = items
    .map(
      ([label, value]) => `
      <article class="metric">
        <p class="muted">${escapeHtml_(label)}</p>
        <p class="value">${escapeHtml_(String(value))}</p>
      </article>
    `
    )
    .join('');
}

function renderClients_() {
  if (!state.clients.length) {
    el.clientsList.innerHTML = '<div class="list-item">No clients yet.</div>';
  } else {
    el.clientsList.innerHTML = state.clients
      .map(
        (c) => `
      <div class="list-item">
        <strong>${escapeHtml_(c.Name || '')}</strong><br />
        <span class="muted">${escapeHtml_(c.Phone || '-')} • Default ${escapeHtml_(String(c.DefaultInterestPct || 35))}% • ${escapeHtml_(c.RiskFlag || 'LOW')}</span>
      </div>
    `
      )
      .join('');
  }

  const options = ['<option value="">Select Client</option>']
    .concat(
      state.clients.map(
        (c) => `<option value="${escapeHtml_(c.ClientID)}">${escapeHtml_(c.Name || 'Unnamed')} (${escapeHtml_(c.Phone || '-')})</option>`
      )
    )
    .join('');
  el.loanClientId.innerHTML = options;
}

function renderLoans_() {
  const filter = el.loanStatusFilter.value || 'ALL';
  const filtered = state.loans.filter((loan) => filter === 'ALL' || loan.Status === filter);

  if (!filtered.length) {
    el.loansList.innerHTML = '<div class="list-item">No loans found.</div>';
    return;
  }

  el.loansList.innerHTML = filtered
    .map((loan) => {
      const client = state.clients.find((c) => c.ClientID === loan.ClientID);
      const clientName = client ? client.Name : loan.ClientID;
      return `
        <article class="list-item clickable" data-loan-id="${escapeHtml_(loan.LoanID)}">
          <strong>${escapeHtml_(clientName)}</strong><br />
          <span class="muted">${formatCents_(loan.OutstandingCents)} • Due ${escapeHtml_(formatDate_(loan.DueDate))}</span><br />
          <span class="status-pill ${statusClass_(loan.Status)}">${escapeHtml_(loan.Status || 'UNKNOWN')}</span>
        </article>
      `;
    })
    .join('');

  el.loansList.querySelectorAll('[data-loan-id]').forEach((row) => {
    row.addEventListener('click', async () => {
      const loanId = row.getAttribute('data-loan-id');
      state.selectedLoanId = loanId;
      await refreshLoanDetail_(loanId);
    });
  });
}

function renderLoanDetail_(payload) {
  const loan = payload.loan;
  const txs = payload.transactions || [];

  const client = state.clients.find((c) => c.ClientID === loan.ClientID);
  const header = `
    <div class="list-item">
      <strong>${escapeHtml_(client ? client.Name : loan.ClientID)}</strong><br />
      <span class="muted">LoanID: ${escapeHtml_(loan.LoanID)}</span><br />
      <span class="muted">Outstanding: ${formatCents_(payload.outstandingCents)} • Due ${escapeHtml_(formatDate_(loan.DueDate))}</span><br />
      <span class="status-pill ${statusClass_(payload.status)}">${escapeHtml_(payload.status)}</span>
    </div>
  `;

  const rows = txs
    .map(
      (tx) => `
      <div class="list-item">
        <strong>${escapeHtml_(tx.Type)}</strong> ${tx.AmountCents >= 0 ? '+' : ''}${formatCents_(tx.AmountCents)}<br />
        <span class="muted">${escapeHtml_(formatDate_(tx.Date || tx.CreatedAt || ''))} • ${escapeHtml_(tx.Notes || '')}</span>
      </div>
    `
    )
    .join('');

  el.loanDetail.innerHTML = header + rows;
  el.paymentForm.classList.remove('hidden');
  el.waiverForm.classList.remove('hidden');
  el.adjustForm.classList.remove('hidden');
  el.extendForm.classList.remove('hidden');
}

function renderReport_() {
  if (!state.report) {
    el.reportResult.innerHTML = '<div class="list-item">No report loaded.</div>';
    return;
  }

  const r = state.report;
  const items = [
    ['Month', r.month],
    ['Total Charges', formatCents_(r.totalChargesCents)],
    ['Total Payments', formatCents_(r.totalPaymentsCents)],
    ['Total Extension Interest', formatCents_(r.totalInterestEarnedCents)],
    ['Total Penalties', formatCents_(r.totalPenaltiesCents)],
    ['Total Waivers', formatCents_(r.totalWaiversCents)],
    ['Collection Rate', `${r.collectionRatePct}%`]
  ];

  el.reportResult.innerHTML = items
    .map(
      ([k, v]) => `
      <div class="list-item">
        <strong>${escapeHtml_(k)}</strong><br />
        <span class="muted">${escapeHtml_(String(v))}</span>
      </div>
    `
    )
    .join('');
}

async function writeAction_(action, payload) {
  try {
    const resp = await callApi(action, payload);
    if (!resp.ok) {
      throw new Error(resp.error || 'Write failed');
    }
    await updateSyncLabel_();
    return { queued: false, resp };
  } catch (err) {
    const message = String(err.message || err);
    const networkLike = !navigator.onLine || /fetch|network|cors|invalid json response/i.test(message.toLowerCase());

    if (!networkLike) {
      throw err;
    }

    const item = {
      mutationId: crypto.randomUUID(),
      action,
      payload,
      createdAt: new Date().toISOString()
    };

    await queueAdd(item);
    showToast_('Saved offline. Sync pending.');
    await updateSyncLabel_();
    return { queued: true };
  }
}

async function syncQueue_() {
  if (state.syncing) return;
  if (!navigator.onLine) {
    await updateSyncLabel_();
    return;
  }

  const pending = await queueList();
  if (!pending.length) {
    await updateSyncLabel_();
    return;
  }

  state.syncing = true;
  await updateSyncLabel_();

  try {
    const operations = pending.map((q) => ({
      mutationId: q.mutationId,
      action: q.action,
      payload: q.payload
    }));

    const resp = await callApi('syncBatch', { operations });
    if (!resp.ok) {
      throw new Error(resp.error || 'Batch sync failed');
    }

    const results = (resp.data && resp.data.results) || [];
    const successIds = new Set(
      results.filter((r) => r.result && r.result.ok).map((r) => r.mutationId)
    );

    for (const item of pending) {
      if (successIds.has(item.mutationId)) {
        await queueDelete(item.id);
      }
    }

    if (successIds.size > 0) {
      showToast_(`Synced ${successIds.size} queued item(s)`);
      await refreshAll_();
      if (state.selectedLoanId) {
        await refreshLoanDetail_(state.selectedLoanId);
      }
    }
  } catch (err) {
    showToast_('Sync failed: ' + err.message);
  } finally {
    state.syncing = false;
    await updateSyncLabel_();
  }
}

async function updateSyncLabel_() {
  const queued = (await queueList()).length;
  const online = navigator.onLine ? 'Online' : 'Offline';
  const apiConfigured = getApiUrl() ? 'API set' : 'API missing';
  const syncState = state.syncing ? 'syncing...' : 'idle';

  el.syncLabel.textContent = `${online} • ${apiConfigured} • ${queued} queued • ${syncState}`;
}

function setTab_(tabName) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  document.querySelectorAll('.bottom-nav button[data-tab]').forEach((btn) => btn.classList.remove('active'));

  const tab = document.getElementById(`tab-${tabName}`);
  const navBtn = document.querySelector(`.bottom-nav button[data-tab="${tabName}"]`);

  if (tab) tab.classList.add('active');
  if (navBtn) navBtn.classList.add('active');
}

function showLogin_() {
  el.loginView.classList.remove('hidden');
  el.appView.classList.add('hidden');
}

function showApp_() {
  el.loginView.classList.add('hidden');
  el.appView.classList.remove('hidden');
}

function setLoginStatus_(message, isError) {
  el.loginStatus.textContent = message;
  el.loginStatus.style.color = isError ? '#ffd3ca' : 'var(--muted)';
}

function showToast_(message) {
  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  clearTimeout(showToast_.timer);
  showToast_.timer = setTimeout(() => {
    el.toast.classList.add('hidden');
  }, 2500);
}

function countByStatus_(status) {
  return state.loans.filter((l) => l.Status === status).length;
}

function statusClass_(status) {
  if (status === 'ACTIVE') return 'status-active';
  if (status === 'DUE TODAY') return 'status-due-today';
  if (status === 'OVERDUE') return 'status-overdue';
  if (status === 'SETTLED') return 'status-settled';
  return 'status-active';
}

function formatCents_(value) {
  const cents = Number(value) || 0;
  return currency.format(cents / 100);
}

function formatDate_(value) {
  if (!value) return '-';
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toISOString().slice(0, 10);
}

function centsToAmount_(value) {
  return ((Number(value) || 0) / 100).toFixed(2);
}

function csvEscape_(value) {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return s;
}

function escapeHtml_(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function registerServiceWorker_() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // SW failure should not block app usage.
  });
}

function getOrCreateDeviceId_() {
  const key = 'loanMasterDeviceId';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}
