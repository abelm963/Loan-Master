const API_URL_KEY = 'loanMasterApiUrl';
const SESSION_KEY = 'loanMasterSessionToken';

export function getApiUrl() {
  return localStorage.getItem(API_URL_KEY) || '';
}

export function setApiUrl(url) {
  localStorage.setItem(API_URL_KEY, url.trim());
}

export function getSessionToken() {
  return localStorage.getItem(SESSION_KEY) || '';
}

export function setSessionToken(token) {
  if (!token) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, token);
}

export async function callApi(action, payload = {}, sessionToken = '') {
  const baseUrl = getApiUrl();
  if (!baseUrl) {
    throw new Error('Set Apps Script URL in Settings first');
  }

  const body = {
    action,
    payload,
    sessionToken: sessionToken || getSessionToken()
  };

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('Invalid JSON response from API');
  }

  return data;
}

export async function pingApi() {
  const baseUrl = getApiUrl();
  if (!baseUrl) {
    return { ok: false, error: 'No API URL configured' };
  }

  const url = new URL(baseUrl);
  url.searchParams.set('action', 'ping');

  const response = await fetch(url.toString(), { method: 'GET' });
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (err) {
    return { ok: false, error: 'Invalid response' };
  }
}
