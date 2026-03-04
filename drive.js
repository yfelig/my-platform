const DriveStorage = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const FILE_NAME = 'data.json';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

  let _token = null;
  let _tokenExpiry = 0;
  let _tokenClient = null;
  let _fileId = null;
  let _pendingResolve = null;
  let _pendingReject = null;

  // ── Token management ────────────────────────────────────────────────────────

  function getClientId() {
    return localStorage.getItem('google_client_id');
  }

  function isConfigured() {
    return !!getClientId();
  }

  function isSignedIn() {
    const t = localStorage.getItem('drive_token');
    const exp = parseInt(localStorage.getItem('drive_token_expiry') || '0');
    if (t && Date.now() < exp) { _token = t; _tokenExpiry = exp; return true; }
    return false;
  }

  function _initTokenClient() {
    if (_tokenClient) return;
    const clientId = getClientId();
    if (!clientId) throw new Error('No Google Client ID configured. Go to Settings.');

    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) {
          const err = new Error(resp.error_description || resp.error);
          if (_pendingReject) { _pendingReject(err); _pendingReject = null; _pendingResolve = null; }
          return;
        }
        _token = resp.access_token;
        _tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
        localStorage.setItem('drive_token', _token);
        localStorage.setItem('drive_token_expiry', String(_tokenExpiry));
        if (_pendingResolve) { _pendingResolve(); _pendingResolve = null; _pendingReject = null; }
      },
      error_callback: (err) => {
        const e = new Error(err.type || 'token_error');
        if (_pendingReject) { _pendingReject(e); _pendingReject = null; _pendingResolve = null; }
      },
    });
  }

  function _requestToken(prompt) {
    return new Promise((resolve, reject) => {
      _initTokenClient();
      _pendingResolve = resolve;
      _pendingReject = reject;
      _tokenClient.requestAccessToken({ prompt });
    });
  }

  async function _ensureToken() {
    if (isSignedIn()) return;
    // Try silent (works if user already consented this session)
    await _requestToken('');
  }

  async function signIn() {
    // Explicit sign-in — always shows account picker
    await _requestToken('select_account');
  }

  function signOut() {
    if (_token) google.accounts.oauth2.revoke(_token, () => {});
    _token = null;
    _tokenExpiry = 0;
    _fileId = null;
    localStorage.removeItem('drive_token');
    localStorage.removeItem('drive_token_expiry');
    localStorage.removeItem('drive_file_id');
  }

  // ── Drive API helpers ────────────────────────────────────────────────────────

  async function _fetch(method, url, { params, body, rawBody, contentType } = {}) {
    await _ensureToken();
    const u = new URL(url);
    if (params) Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    const headers = { Authorization: `Bearer ${_token}` };
    if (contentType) headers['Content-Type'] = contentType;
    else if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(u.toString(), {
      method,
      headers,
      body: rawBody ?? (body ? JSON.stringify(body) : undefined),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Drive ${res.status}: ${txt}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

  async function _findOrCreateFile() {
    // 1. Try cached ID
    const cached = localStorage.getItem('drive_file_id');
    if (cached) { _fileId = cached; return _fileId; }

    // 2. Search appDataFolder
    const result = await _fetch('GET', `${API}/files`, {
      params: { spaces: 'appDataFolder', q: `name='${FILE_NAME}'`, fields: 'files(id)' },
    });
    if (result.files && result.files.length > 0) {
      _fileId = result.files[0].id;
      localStorage.setItem('drive_file_id', _fileId);
      return _fileId;
    }

    // 3. Create new file with multipart upload
    const boundary = 'drive_boundary_xyz';
    const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] });
    const content = JSON.stringify(defaultData(), null, 2);
    const rawBody = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      meta,
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      content,
      `--${boundary}--`,
    ].join('\r\n');

    const res = await _fetch('POST', `${UPLOAD_API}/files`, {
      params: { uploadType: 'multipart', fields: 'id' },
      rawBody,
      contentType: `multipart/related; boundary="${boundary}"`,
    });
    _fileId = res.id;
    localStorage.setItem('drive_file_id', _fileId);
    return _fileId;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async function load() {
    const fileId = await _findOrCreateFile();
    await _ensureToken();
    const res = await fetch(`${API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${_token}` },
    });
    if (!res.ok) {
      // File may have been deleted — clear cache and retry once
      if (res.status === 404) {
        localStorage.removeItem('drive_file_id');
        _fileId = null;
        return load();
      }
      throw new Error(`Drive load failed: ${res.status}`);
    }
    return res.json();
  }

  async function save(data) {
    const fileId = await _findOrCreateFile();
    await _ensureToken();
    const res = await fetch(`${UPLOAD_API}/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data, null, 2),
    });
    if (!res.ok) throw new Error(`Drive save failed: ${res.status}`);
  }

  function defaultData() {
    return { projects: [], tasks: [], categories: ['work', 'personal'] };
  }

  return { signIn, signOut, isSignedIn, isConfigured, load, save, defaultData };
})();
