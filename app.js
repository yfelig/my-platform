// ── STATE ────────────────────────────────────────────────────────────────────
let state = { projects: [], tasks: [], categories: ['work', 'personal'], trash: [] };
let filters = { status: 'all', category: 'all' };
let activeView = 'dashboard';
let activeProjectId = null;
let saving = false;
let _subtasks = [];

// ── UTILS ─────────────────────────────────────────────────────────────────────
function uuid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function fmt(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isDuePast(dueDate) {
  if (!dueDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dueDate) < today;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

let _toastTimer = null;
function showToast(msg, type = 'info', duration = 3500) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast toast-${type} show`;
  el.innerHTML = msg; // caller is responsible for safe content
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── PERSISTENCE ───────────────────────────────────────────────────────────────
async function loadData() {
  try {
    state = await DriveStorage.load();
    if (!state.categories) state.categories = ['work', 'personal'];
    if (!state.trash) state.trash = [];
  } catch (e) {
    console.error('Load failed', e);
    showToast('⚠️ Could not load data. Try signing in again from Settings.', 'error', 6000);
  }
}

async function persist() {
  if (saving) return;
  saving = true;
  try { await DriveStorage.save(state); }
  catch (e) {
    console.error('Save failed', e);
    showToast('⚠️ Save failed — check your connection.', 'error', 6000);
  }
  finally { saving = false; }
}

// ── ROUTER ────────────────────────────────────────────────────────────────────
function navigate(view, projectId) {
  activeView = view;
  activeProjectId = projectId || null;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.view === view || (view === 'project-detail' && a.dataset.view === 'projects'));
  });

  const el = document.getElementById(`view-${view}`);
  if (el) el.classList.add('active');

  const fab = document.getElementById('fab');
  if (fab) fab.style.display = ['tasks', 'projects', 'project-detail'].includes(view) ? 'flex' : 'none';

  if (view === 'log') renderLog();

  render();
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function render() {
  if (activeView === 'dashboard') renderDashboard();
  if (activeView === 'projects') renderProjects();
  if (activeView === 'project-detail') renderProjectDetail();
  if (activeView === 'tasks') renderTasks();
  if (activeView === 'pomodoro') renderPomodoro();
  if (activeView === 'log') renderLog();
}

// ── LABEL MAPS ────────────────────────────────────────────────────────────────
const STATUS_LABELS = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  stagnated: 'Stagnated',
  done: 'Done',
  other: 'Other',
};

const STATUS_CYCLE = ['not_started', 'in_progress', 'stagnated', 'done', 'other'];
const URGENCY_LABELS = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };

// ── PROJECT COLORS ────────────────────────────────────────────────────────────
const PROJECT_COLORS = [
  '#7c3aed', '#3b82f6', '#06b6d4', '#10b981',
  '#f59e0b', '#f43f5e', '#f97316', '#ec4899',
];

function projectColor(p) {
  return p?.color || PROJECT_COLORS[0];
}

function projectIconHTML(p, size = 40) {
  const color = projectColor(p);
  const label = escapeHtml(p.emoji || (p.name?.[0] || '?').toUpperCase());
  const fs = Math.round(size * (p.emoji ? 0.55 : 0.42));
  return `<div class="project-icon" style="width:${size}px;height:${size}px;font-size:${fs}px;background:${color}22;color:${color};border:1.5px solid ${color}44;">${label}</div>`;
}

// ── PILL HELPERS ──────────────────────────────────────────────────────────────
function statusPill(s, taskId) {
  const clickable = taskId
    ? `onclick="showStatusPicker(event,'${taskId}')" title="Change status" style="cursor:pointer"`
    : '';
  return `<span class="pill pill-status-${s}" ${clickable}>${STATUS_LABELS[s] || s}</span>`;
}

function catPill(c) {
  return `<span class="pill pill-cat">${c}</span>`;
}

function urgencyBadge(u) {
  if (!u || u === 'low') return '';
  return `<span class="urgency-badge urgency-${u}">${URGENCY_LABELS[u]}</span>`;
}

// ── WEATHER ───────────────────────────────────────────────────────────────────
const WMO = {
  0: ['☀️', 'Clear'], 1: ['🌤', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫', 'Foggy'], 48: ['🌫', 'Icy fog'],
  51: ['🌦', 'Light drizzle'], 53: ['🌦', 'Drizzle'], 55: ['🌧', 'Heavy drizzle'],
  61: ['🌧', 'Light rain'], 63: ['🌧', 'Rain'], 65: ['🌧', 'Heavy rain'],
  71: ['🌨', 'Light snow'], 73: ['❄️', 'Snow'], 75: ['❄️', 'Heavy snow'],
  80: ['🌦', 'Showers'], 81: ['🌧', 'Rain showers'], 82: ['⛈', 'Heavy showers'],
  95: ['⛈', 'Thunderstorm'], 96: ['⛈', 'Thunderstorm'], 99: ['⛈', 'Thunderstorm'],
};

async function getCoords() {
  // Try browser geolocation first (more accurate, 5s timeout)
  if (navigator.geolocation) {
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000, maximumAge: 600000 })
      );
      return { lat: pos.coords.latitude, lon: pos.coords.longitude };
    } catch {}
  }
  // Fall back to IP geolocation (no permission needed)
  const res = await fetch('https://ipapi.co/json/');
  const data = await res.json();
  if (!data.latitude) throw new Error('IP geolocation failed');
  return { lat: data.latitude, lon: data.longitude };
}

async function loadWeather() {
  const valEl = document.getElementById('weather-value');
  const iconEl = document.getElementById('weather-icon');
  if (!valEl) return;

  // Serve from cache if fresh (30 min) — no network hit
  const cached = JSON.parse(localStorage.getItem('wx_cache') || 'null');
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
    if (valEl.textContent !== cached.text) {
      valEl.textContent = cached.text;
      valEl.classList.remove('muted');
      if (iconEl) iconEl.textContent = cached.icon;
    }
    return;
  }

  try {
    const { lat, lon } = await getCoords();
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weathercode&temperature_unit=fahrenheit`
    );
    const data = await res.json();
    const c = data.current;
    const [icon, desc] = WMO[c.weathercode] || ['🌡', 'Unknown'];
    const text = `${Math.round(c.temperature_2m)}°F — ${desc}`;
    localStorage.setItem('wx_cache', JSON.stringify({ ts: Date.now(), text, icon }));
    valEl.textContent = text;
    valEl.classList.remove('muted');
    if (iconEl) iconEl.textContent = icon;
  } catch {
    valEl.textContent = 'Could not load weather';
  }
}

// ── GOOGLE CALENDAR ───────────────────────────────────────────────────────────
let _tokenClient = null;
let _calLastLoaded = 0;

function getValidGoogleToken() {
  const token = localStorage.getItem('google_access_token');
  const expiry = parseInt(localStorage.getItem('google_token_expiry') || '0');
  if (token && Date.now() < expiry - 60000) return token;
  return null;
}

async function loadCalendar() {
  const el = document.getElementById('calendar-widget-body');
  if (!el) return;

  // Throttle: skip re-fetch if we loaded calendar within the last 60s
  const token2 = getValidGoogleToken();
  if (token2 && Date.now() - _calLastLoaded < 60 * 1000) return;
  if (token2) _calLastLoaded = Date.now();

  const clientId = localStorage.getItem('google_client_id') || '';
  if (!clientId) {
    el.innerHTML = `<div class="widget-value muted">Add Client ID in <a href="setup.html" style="color:var(--accent1);text-decoration:none">settings</a></div>`;
    return;
  }

  const token = getValidGoogleToken();
  if (!token) {
    el.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="connectGoogleCalendar()">Connect Google Calendar</button>`;
    return;
  }

  await fetchAndDisplayCalendar(token, el);
}

function connectGoogleCalendar() {
  const clientId = localStorage.getItem('google_client_id') || '';
  if (!clientId) { alert('Add your Google Client ID in settings first.'); return; }
  if (!window.google?.accounts?.oauth2) { alert('Google services not loaded. Check your connection.'); return; }

  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    callback: async (resp) => {
      if (resp.error) return;
      localStorage.setItem('google_access_token', resp.access_token);
      localStorage.setItem('google_token_expiry', Date.now() + resp.expires_in * 1000);
      const el = document.getElementById('calendar-widget-body');
      if (el) await fetchAndDisplayCalendar(resp.access_token, el);
    },
  });
  _tokenClient.requestAccessToken();
}

async function fetchAndDisplayCalendar(token, el) {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&orderBy=startTime&singleEvents=true&maxResults=6`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (res.status === 401) {
      localStorage.removeItem('google_access_token');
      el.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="connectGoogleCalendar()">Reconnect Calendar</button>`;
      return;
    }

    const data = await res.json();
    const events = (data.items || []).filter(ev => ev.status !== 'cancelled');

    if (!events.length) {
      el.innerHTML = `<div class="widget-value">No events today 🎉</div>`;
      return;
    }

    el.innerHTML = events.map(ev => {
      const startDt = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
      const timeStr = startDt
        ? startDt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : 'All day';
      return `
        <div class="cal-event">
          <span class="cal-time">${timeStr}</span>
          <span class="cal-title">${ev.summary || 'Untitled'}</span>
        </div>
      `;
    }).join('');
  } catch {
    el.innerHTML = `<div class="widget-value muted">Could not load events</div>`;
  }
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const userName = escapeHtml(localStorage.getItem('user_name') || 'there');

  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.status === 'done').length;
  const inProgress = state.tasks.filter(t => t.status === 'in_progress').length;
  const projects = state.projects.length;

  const recent = [...state.tasks]
    .filter(t => t.status !== 'done')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);

  document.getElementById('view-dashboard').innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Good to see you, <span>${userName}</span> 👋</h1>
        <div class="dashboard-date">${dateStr}</div>
      </div>
    </div>

    <div class="dashboard-widgets">
      <div class="widget">
        <div class="widget-icon" id="weather-icon">🌤</div>
        <div class="widget-body">
          <div class="widget-label">Weather</div>
          <div class="widget-value muted" id="weather-value">Loading...</div>
        </div>
      </div>
      <div class="widget widget-calendar">
        <div class="widget-icon">📅</div>
        <div class="widget-body">
          <div class="widget-label">Today's Schedule</div>
          <div id="calendar-widget-body"><div class="widget-value muted">Loading...</div></div>
        </div>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">${projects}</div>
        <div class="stat-label">Projects</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${total}</div>
        <div class="stat-label">Total Tasks</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${inProgress}</div>
        <div class="stat-label">In Progress</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${done}</div>
        <div class="stat-label">Done</div>
      </div>
    </div>

    ${recent.length ? `
      <div class="section-title">Recent Tasks</div>
      <div class="task-list">
        ${recent.map(t => taskItemHTML(t)).join('')}
      </div>
    ` : `
      <div class="empty-state">
        <div class="icon">✦</div>
        <p>No tasks yet. Add some from the Tasks view.</p>
      </div>
    `}
  `;

  bindTaskEvents();
  loadWeather();
  loadCalendar();
}

// ── PROJECTS ──────────────────────────────────────────────────────────────────
function renderProjects() {
  const cards = state.projects.map(p => {
    const color = projectColor(p);
    return `
      <div class="project-card" style="--pc:${color}" onclick="navigate('project-detail','${p.id}')">
        <div class="project-card-top">
          ${projectIconHTML(p)}
          <div class="project-card-name">${p.name}</div>
        </div>
        <div class="project-card-desc">${p.description || 'No description'}</div>
        <div class="project-card-footer">
          ${statusPill(p.status)}
          ${catPill(p.category)}
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('view-projects').innerHTML = `
    <div class="page-header">
      <h1 class="page-title"><span>Projects</span></h1>
    </div>
    <div class="project-grid">
      ${cards}
      <div class="project-add-card" onclick="openProjectModal()">
        <div class="plus">+</div>
        <div>New Project</div>
      </div>
    </div>
  `;
}

// ── PROJECT DETAIL ────────────────────────────────────────────────────────────
function renderProjectDetail() {
  const p = state.projects.find(x => x.id === activeProjectId);
  if (!p) { navigate('projects'); return; }

  const projectTasks = state.tasks.filter(t => t.projectId === p.id);
  const active = projectTasks.filter(t => t.status !== 'done');
  const done = projectTasks.filter(t => t.status === 'done');
  const sorted = [...active, ...done];

  const pColor = projectColor(p);
  document.getElementById('view-project-detail').innerHTML = `
    <button class="back-btn" onclick="navigate('projects')">← Projects</button>
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:14px">
        ${projectIconHTML(p, 48)}
        <div>
          <h1 class="page-title" style="color:${pColor}">${p.name}</h1>
          ${p.description ? `<p style="color:var(--text-muted);font-size:14px;margin-top:4px">${p.description}</p>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        ${statusPill(p.status)}
        ${catPill(p.category)}
        <button class="btn btn-ghost btn-sm" onclick="openProjectModal('${p.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" style="color:#f87171" onclick="deleteProject('${p.id}')">Delete</button>
      </div>
    </div>

    ${sorted.length ? `
      <div class="task-list">
        ${sorted.map(t => taskItemHTML(t)).join('')}
      </div>
    ` : `
      <div class="empty-state">
        <div class="icon">📋</div>
        <p>No tasks for this project yet.</p>
      </div>
    `}
  `;
  bindTaskEvents();
}

// ── TASKS ─────────────────────────────────────────────────────────────────────
function renderTasks() {
  const filtered = state.tasks.filter(t => {
    if (filters.status !== 'all' && t.status !== filters.status) return false;
    if (filters.category !== 'all' && t.category !== filters.category) return false;
    return true;
  });

  const active = filtered.filter(t => t.status !== 'done');
  const done = filtered.filter(t => t.status === 'done');
  const sorted = [...active, ...done];

  const statuses = ['all', ...Object.keys(STATUS_LABELS)];
  const categories = ['all', ...state.categories, '__add__'];

  document.getElementById('view-tasks').innerHTML = `
    <div class="page-header">
      <h1 class="page-title"><span>Tasks</span></h1>
    </div>

    <div class="filter-bar">
      <span class="filter-label">Status:</span>
      ${statuses.map(s => `
        <button class="filter-chip ${filters.status === s ? 'active' : ''}"
          onclick="setFilter('status','${s}')">
          ${s === 'all' ? 'All' : STATUS_LABELS[s]}
        </button>
      `).join('')}
    </div>

    <div class="filter-bar">
      <span class="filter-label">Category:</span>
      ${categories.map(c => c === '__add__' ? `
        <button class="filter-chip" onclick="addCategory()" style="border-style:dashed">+ Add</button>
      ` : `
        <button class="filter-chip ${filters.category === c ? 'active' : ''}"
          onclick="setFilter('category','${c}')">
          ${c === 'all' ? 'All' : c}
        </button>
      `).join('')}
    </div>

    ${sorted.length ? `
      <div class="task-list">
        ${sorted.map(t => taskItemHTML(t)).join('')}
      </div>
    ` : `
      <div class="empty-state">
        <div class="icon">✓</div>
        <p>No tasks match this filter.</p>
      </div>
    `}
  `;
  bindTaskEvents();
}

// ── TASK ITEM HTML ─────────────────────────────────────────────────────────────
function taskItemHTML(t) {
  const isDone = t.status === 'done';
  const overdue = !isDone && isDuePast(t.dueDate);
  const subtasks = t.subtasks || [];
  const subtasksDone = subtasks.filter(s => s.done).length;

  const dueMeta = t.dueDate
    ? `<span class="due-badge ${overdue ? 'overdue' : ''}">📅 ${fmt(t.dueDate)}${overdue ? ' · overdue' : ''}</span>`
    : '';

  const subtaskMeta = subtasks.length
    ? `<span class="subtask-count">${subtasksDone}/${subtasks.length} subtasks</span>`
    : '';

  const proj = t.projectId ? state.projects.find(p => p.id === t.projectId) : null;
  const accentStyle = proj ? `border-left: 3px solid ${projectColor(proj)};` : '';

  return `
    <div class="task-item ${isDone ? 'done' : ''}" style="${accentStyle}" onclick="openTaskModal(event,'${t.id}')">
      <div class="task-checkbox ${isDone ? 'checked' : ''}" onclick="toggleDone(event,'${t.id}')"></div>
      <div class="task-body">
        <div class="task-title ${isDone ? 'done-text' : ''}">${t.title}</div>
        ${dueMeta || subtaskMeta ? `<div class="task-submeta">${dueMeta}${subtaskMeta}</div>` : ''}
      </div>
      <div class="task-meta">
        ${statusPill(t.status, t.id)}
        ${urgencyBadge(t.urgency)}
        ${catPill(t.category)}
      </div>
      <div class="task-actions">
        <button class="task-action-btn" onclick="event.stopPropagation();sendToPomodoro('${t.id}')" title="Send to Pomodoro">▶</button>
        <button class="task-action-btn" onclick="event.stopPropagation();openDecomposeModal('${t.id}')" title="Break into subtasks">🍅</button>
      </div>
    </div>
  `;
}

function bindTaskEvents() {}

// ── FILTERS ───────────────────────────────────────────────────────────────────
function setFilter(key, val) {
  filters[key] = val;
  localStorage.setItem('filters', JSON.stringify(filters));
  renderTasks();
}

function setQuickDate(daysFromNow) {
  const input = document.getElementById('m-due');
  if (!input) return;
  if (daysFromNow < 0) { input.value = ''; return; }
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  input.value = d.toISOString().split('T')[0];
}

async function addCategory() {
  const name = prompt('New category name:');
  if (!name || !name.trim()) return;
  const cat = name.trim().toLowerCase();
  if (!state.categories.includes(cat)) {
    state.categories.push(cat);
    await persist();
  }
  renderTasks();
}

// ── TASK ACTIONS ──────────────────────────────────────────────────────────────
async function toggleDone(e, id) {
  e.stopPropagation();
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  const wasDone = task.status === 'done';
  task.status = wasDone ? 'not_started' : 'done';
  if (!wasDone) logTaskCompleted(task);
  await persist();
  render();
}

function showStatusPicker(e, taskId) {
  e.stopPropagation();
  document.getElementById('status-picker')?.remove();

  const picker = document.createElement('div');
  picker.id = 'status-picker';
  picker.className = 'status-picker';
  picker.innerHTML = STATUS_CYCLE.map(v => `
    <div class="status-picker-opt pill pill-status-${v}" onclick="setTaskStatus(event,'${taskId}','${v}')">
      ${STATUS_LABELS[v]}
    </div>
  `).join('');
  document.body.appendChild(picker);

  // Position below the clicked pill, clamp to viewport edges
  const rect = e.currentTarget.getBoundingClientRect();
  const pickerW = 160;
  const pickerH = STATUS_CYCLE.length * 38 + 8; // approximate picker height
  let left = rect.left + window.scrollX;
  if (left + pickerW > window.innerWidth - 8) left = window.innerWidth - pickerW - 8;
  if (left < 8) left = 8;
  let top = rect.bottom + window.scrollY + 6;
  if (rect.bottom + pickerH > window.innerHeight - 8) {
    top = rect.top + window.scrollY - pickerH - 6; // flip above if no room below
  }
  picker.style.top = `${top}px`;
  picker.style.left = `${left}px`;

  setTimeout(() => document.addEventListener('click', () => document.getElementById('status-picker')?.remove(), { once: true }), 0);
}

async function setTaskStatus(e, taskId, status) {
  e.stopPropagation();
  document.getElementById('status-picker')?.remove();
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  task.status = status;
  await persist();
  render();
}

// ── TRASH BIN ─────────────────────────────────────────────────────────────────
function purgeOldTrash() {
  if (!state.trash) { state.trash = []; return; }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  state.trash = state.trash.filter(i => new Date(i._deletedAt).getTime() > cutoff);
}

async function deleteTask(e, id) {
  e.stopPropagation();
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  state.trash.push({ _type: 'task', _deletedAt: new Date().toISOString(), ...task });
  render();
  await persist();
  showToast('Task moved to trash', 'info');
}

async function deleteTaskFromModal(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  state.trash.push({ _type: 'task', _deletedAt: new Date().toISOString(), ...task });
  closeModal();
  render();
  await persist();
  showToast('Task moved to trash', 'info');
}

async function deleteProject(id) {
  if (!confirm('Delete this project and all its tasks?')) return;
  const proj = state.projects.find(p => p.id === id);
  const projTasks = state.tasks.filter(t => t.projectId === id);
  state.projects = state.projects.filter(p => p.id !== id);
  state.tasks = state.tasks.filter(t => t.projectId !== id);
  const now = new Date().toISOString();
  if (proj) state.trash.push({ _type: 'project', _deletedAt: now, ...proj });
  projTasks.forEach(t => state.trash.push({ _type: 'task', _deletedAt: now, ...t }));
  await persist();
  navigate('projects');
  showToast('Project moved to trash', 'info');
}

async function restoreFromTrash(itemId) {
  const idx = state.trash.findIndex(i => i.id === itemId);
  if (idx === -1) return;
  const item = { ...state.trash[idx] };
  state.trash.splice(idx, 1);
  const type = item._type;
  delete item._type;
  delete item._deletedAt;
  if (type === 'task') state.tasks.push(item);
  else if (type === 'project') state.projects.push(item);
  await persist();
  render();
  showTrashModal();
}

function showTrashModal() {
  purgeOldTrash();
  const items = state.trash || [];
  const rows = items.length ? [...items].reverse().map(item => {
    const agMs = Date.now() - new Date(item._deletedAt).getTime();
    const ageDays = Math.floor(agMs / (1000 * 60 * 60 * 24));
    const ageLabel = ageDays === 0 ? 'today' : `${ageDays}d ago`;
    const icon = item._type === 'project' ? '📁' : '☑';
    const name = escapeHtml(item.name || item.title || '?');
    return `
      <div class="trash-row">
        <span class="trash-label">${icon} ${name}</span>
        <span class="trash-age">${ageLabel}</span>
        <button class="btn btn-ghost btn-sm" onclick="restoreFromTrash('${item.id}')">Restore</button>
      </div>
    `;
  }).join('') : '<div class="trash-empty">Trash is empty</div>';

  showModal(`
    <div class="modal-title">🗑 Trash Bin</div>
    <div class="trash-note">Items are automatically deleted after 7 days.</div>
    <div class="trash-list">${rows}</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Close</button>
    </div>
  `);
}

// ── SEND TO POMODORO / DECOMPOSE ──────────────────────────────────────────────
function sendToPomodoro(taskId) {
  pomo.taskId = taskId;
  const task = state.tasks.find(t => t.id === taskId);
  if (task?.projectId) pomo.projectId = task.projectId;
  pomoSave();
  navigate('pomodoro');
}

function openDecomposeModal(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  showModal(`
    <div class="modal-title">🍅 Break into Pomodoros</div>
    <div class="field">
      <label>Task: <strong>${escapeHtml(task.title)}</strong></label>
      <label style="margin-top:12px;display:block;color:var(--text-muted);font-size:13px">Enter one subtask per line — each becomes a subtask:</label>
      <textarea id="decompose-input" rows="7" placeholder="Review notes&#10;Write outline&#10;First draft"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveDecompose('${taskId}')">Add Subtasks</button>
    </div>
  `);
  setTimeout(() => document.getElementById('decompose-input')?.focus(), 50);
}

async function saveDecompose(taskId) {
  const input = document.getElementById('decompose-input');
  if (!input) return;
  const lines = input.value.split('\n').map(l => l.trim()).filter(Boolean);
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !lines.length) { closeModal(); return; }
  if (!task.subtasks) task.subtasks = [];
  lines.forEach(title => task.subtasks.push({ id: uuid(), title, done: false }));
  closeModal();
  await persist();
  render();
  showToast(`Added ${lines.length} subtask${lines.length !== 1 ? 's' : ''}`, 'success');
}

// ── SUBTASK EDITING ────────────────────────────────────────────────────────────
function renderSubtaskList() {
  const el = document.getElementById('m-subtasks-list');
  if (!el) return;
  el.innerHTML = _subtasks.length ? _subtasks.map((s, i) => `
    <div class="subtask-row">
      <div class="subtask-check ${s.done ? 'checked' : ''}" onclick="toggleEditSubtask(${i})"></div>
      <span class="subtask-label ${s.done ? 'done-text' : ''}">${s.title}</span>
      <button class="subtask-del" onclick="removeEditSubtask(${i})">✕</button>
    </div>
  `).join('') : '<div class="subtask-empty">No subtasks yet</div>';
}

function addEditSubtask() {
  const input = document.getElementById('m-subtask-input');
  if (!input || !input.value.trim()) return;
  _subtasks.push({ id: uuid(), title: input.value.trim(), done: false });
  input.value = '';
  renderSubtaskList();
}

function toggleEditSubtask(i) {
  _subtasks[i].done = !_subtasks[i].done;
  renderSubtaskList();
}

function removeEditSubtask(i) {
  _subtasks.splice(i, 1);
  renderSubtaskList();
}

// ── DAILY LOG ─────────────────────────────────────────────────────────────────
function _logTodayKey() {
  return 'daily_log_' + new Date().toISOString().split('T')[0];
}

function getDailyLog() {
  try {
    const raw = localStorage.getItem(_logTodayKey());
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function _getOrCreateLog() {
  return getDailyLog() || {
    date: new Date().toISOString().split('T')[0],
    tasksAdded: [],
    tasksCompleted: [],
    pomosCompleted: 0,
    totalFocusMinutes: 0,
  };
}

function saveDailyLog(log) {
  localStorage.setItem(_logTodayKey(), JSON.stringify(log));
}

function logTaskAdded(task) {
  const log = _getOrCreateLog();
  log.tasksAdded.push({
    id: task.id, title: task.title,
    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
  });
  saveDailyLog(log);
}

function logTaskCompleted(task) {
  const log = _getOrCreateLog();
  if (!log.tasksCompleted.find(t => t.id === task.id)) {
    log.tasksCompleted.push({
      id: task.id, title: task.title,
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    });
    saveDailyLog(log);
  }
}

function logPomoCompleted(durationMin) {
  const log = _getOrCreateLog();
  log.pomosCompleted = (log.pomosCompleted || 0) + 1;
  log.totalFocusMinutes = (log.totalFocusMinutes || 0) + durationMin;
  saveDailyLog(log);
}

function renderLog() {
  const el = document.getElementById('view-log');
  if (!el) return;
  const log = getDailyLog();
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const statsHtml = log ? `
    <div class="log-stats">
      <div class="log-stat-card">
        <div class="log-stat-val">${log.pomosCompleted || 0}</div>
        <div class="log-stat-label">Pomodoros</div>
      </div>
      <div class="log-stat-card">
        <div class="log-stat-val">${log.totalFocusMinutes || 0}m</div>
        <div class="log-stat-label">Focus time</div>
      </div>
      <div class="log-stat-card">
        <div class="log-stat-val">${log.tasksAdded?.length || 0}</div>
        <div class="log-stat-label">Tasks added</div>
      </div>
      <div class="log-stat-card">
        <div class="log-stat-val">${log.tasksCompleted?.length || 0}</div>
        <div class="log-stat-label">Tasks done</div>
      </div>
    </div>
  ` : `<div class="log-empty">Nothing logged yet today — get to work!</div>`;

  const addedHtml = log?.tasksAdded?.length ? `
    <div class="log-section">
      <div class="log-section-title">Tasks Added</div>
      ${log.tasksAdded.map(t => `
        <div class="log-item">
          <span class="log-item-time">${t.time}</span>
          <span class="log-item-text">${escapeHtml(t.title)}</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  const completedHtml = log?.tasksCompleted?.length ? `
    <div class="log-section">
      <div class="log-section-title">Tasks Completed</div>
      ${log.tasksCompleted.map(t => `
        <div class="log-item done">
          <span class="log-item-time">${t.time}</span>
          <span class="log-item-text">${escapeHtml(t.title)}</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  el.innerHTML = `
    <div class="log-container">
      <div class="log-header">
        <h2 class="log-title">Daily Log</h2>
        <div class="log-date">${today}</div>
      </div>
      ${statsHtml}
      ${addedHtml}
      ${completedHtml}
    </div>
  `;
}

// ── TASK MODAL ────────────────────────────────────────────────────────────────
function openTaskModal(e, id) {
  if (e) e.stopPropagation();
  _subtasks = []; // reset early so a failed lookup doesn't leak previous state
  const task = id ? state.tasks.find(t => t.id === id) : null;

  const contextProject = activeView === 'project-detail'
    ? state.projects.find(p => p.id === activeProjectId)
    : null;

  const defaultProjectId = task?.projectId || contextProject?.id || '';
  const defaultCategory = task?.category || contextProject?.category || state.categories[0] || '';
  const defaultStatus = task?.status || 'not_started';
  const defaultUrgency = task?.urgency || 'low';

  _subtasks = task?.subtasks ? task.subtasks.map(s => ({ ...s })) : [];

  const projectOptions = state.projects.map(p =>
    `<option value="${p.id}" ${defaultProjectId === p.id ? 'selected' : ''}>${p.name}</option>`
  ).join('');

  showModal(`
    <div class="modal-title">${task ? 'Edit Task' : 'New Task'}</div>

    <div class="field">
      <label>Title</label>
      <input id="m-title" type="text" value="${task ? task.title : ''}" placeholder="What needs to be done?" />
    </div>

    <div class="field-row">
      <div class="field">
        <label>Status</label>
        <select id="m-status">
          ${Object.entries(STATUS_LABELS).map(([v, l]) =>
            `<option value="${v}" ${defaultStatus === v ? 'selected' : ''}>${l}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field">
        <label>Urgency</label>
        <select id="m-urgency">
          ${Object.entries(URGENCY_LABELS).map(([v, l]) =>
            `<option value="${v}" ${defaultUrgency === v ? 'selected' : ''}>${l}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <div class="field-row">
      <div class="field">
        <label>Category</label>
        <select id="m-category">
          ${state.categories.map(c =>
            `<option value="${c}" ${defaultCategory === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field">
        <label>Due Date</label>
        <input id="m-due" type="date" value="${task?.dueDate || ''}" />
        <div class="quick-dates">
          <button type="button" class="quick-date-btn" onclick="setQuickDate(0)">Today</button>
          <button type="button" class="quick-date-btn" onclick="setQuickDate(1)">Tomorrow</button>
          <button type="button" class="quick-date-btn" onclick="setQuickDate(7)">+1 week</button>
          <button type="button" class="quick-date-btn" onclick="setQuickDate(-1)">Clear</button>
        </div>
      </div>
    </div>

    ${state.projects.length ? `
      <div class="field">
        <label>Project</label>
        <select id="m-project">
          <option value="">None</option>
          ${projectOptions}
        </select>
      </div>
    ` : ''}

    <div class="field">
      <label>Description</label>
      <textarea id="m-desc" rows="3" placeholder="Add details...">${task?.description || ''}</textarea>
    </div>

    <div class="field">
      <label>Subtasks</label>
      <div id="m-subtasks-list"></div>
      <div class="subtask-add-row">
        <input id="m-subtask-input" type="text" placeholder="Add a subtask..."
          onkeydown="if(event.key==='Enter'){event.preventDefault();addEditSubtask()}" />
        <button class="btn btn-ghost btn-sm" type="button" onclick="addEditSubtask()">Add</button>
      </div>
    </div>

    <div class="modal-actions">
      ${id ? `<button class="btn btn-ghost" style="color:#f87171;margin-right:auto" onclick="deleteTaskFromModal('${id}')">Delete</button>` : ''}
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveTask('${id || ''}')">Save</button>
    </div>
  `);

  setTimeout(() => {
    document.getElementById('m-title')?.focus();
    renderSubtaskList();
  }, 50);
}

async function saveTask(id) {
  const title = document.getElementById('m-title').value.trim();
  if (!title) return;
  const status = document.getElementById('m-status').value;
  const category = document.getElementById('m-category').value;
  const urgency = document.getElementById('m-urgency').value;
  const dueDate = document.getElementById('m-due').value || null;
  const description = document.getElementById('m-desc').value.trim();
  const projectId = document.getElementById('m-project')?.value || null;
  const subtasks = [..._subtasks];

  if (id) {
    const task = state.tasks.find(t => t.id === id);
    if (task) Object.assign(task, { title, status, category, urgency, dueDate, description, projectId: projectId || null, subtasks });
  } else {
    const projectCtx = activeView === 'project-detail' ? activeProjectId : (projectId || null);
    const newTask = {
      id: uuid(), title, status, category, urgency, dueDate, description,
      projectId: projectCtx, subtasks, createdAt: new Date().toISOString(),
    };
    state.tasks.push(newTask);
    logTaskAdded(newTask);
  }

  closeModal();
  await persist();
  render();
}

// ── PROJECT MODAL ─────────────────────────────────────────────────────────────
function openProjectModal(id) {
  const p = id ? state.projects.find(x => x.id === id) : null;

  const currentColor = p?.color || PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length];

  showModal(`
    <div class="modal-title">${p ? 'Edit Project' : 'New Project'}</div>
    <div class="field-row">
      <div class="field" style="flex:0 0 auto">
        <label>Icon</label>
        <input id="p-emoji" type="text" value="${p?.emoji || ''}" placeholder="🚀" maxlength="2"
          style="width:64px;text-align:center;font-size:22px;padding:8px;" />
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;max-width:160px;">
          ${['🚀','💼','🎯','📌','🌟','💡','🏆','🎨','📚','🔧','🌱','💪','🎵','🏠','✈️','🍀'].map(e =>
            `<span class="emoji-pick" onclick="document.getElementById('p-emoji').value='${e}'" title="${e}">${e}</span>`
          ).join('')}
        </div>
      </div>
      <div class="field" style="flex:1">
        <label>Name</label>
        <input id="p-name" type="text" value="${p ? p.name : ''}" placeholder="Project name" />
        <label style="margin-top:14px;display:block">Color</label>
        <input type="hidden" id="p-color" value="${currentColor}" />
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
          ${PROJECT_COLORS.map(c => `
            <div class="color-swatch ${c === currentColor ? 'selected' : ''}"
              style="background:${c}"
              onclick="document.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));this.classList.add('selected');document.getElementById('p-color').value='${c}'">
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    <div class="field">
      <label>Description</label>
      <textarea id="p-desc" rows="2" placeholder="What's this project about?">${p ? p.description : ''}</textarea>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Status</label>
        <select id="p-status">
          ${Object.entries(STATUS_LABELS).map(([v, l]) =>
            `<option value="${v}" ${p?.status === v ? 'selected' : ''}>${l}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field">
        <label>Category</label>
        <select id="p-category">
          ${state.categories.map(c =>
            `<option value="${c}" ${p?.category === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveProject('${id || ''}')">Save</button>
    </div>
  `);

  setTimeout(() => document.getElementById('p-name')?.focus(), 50);
}

async function saveProject(id) {
  const name = document.getElementById('p-name').value.trim();
  if (!name) return;
  const description = document.getElementById('p-desc').value.trim();
  const status = document.getElementById('p-status').value;
  const category = document.getElementById('p-category').value;
  const emoji = document.getElementById('p-emoji').value.trim();
  const color = document.getElementById('p-color').value || PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length];

  if (id) {
    const p = state.projects.find(x => x.id === id);
    if (p) Object.assign(p, { name, description, status, category, emoji, color });
  } else {
    state.projects.push({ id: uuid(), name, description, status, category, emoji, color, createdAt: new Date().toISOString() });
  }

  closeModal();
  await persist();
  render();
}

// ── MODAL ENGINE ──────────────────────────────────────────────────────────────
function showModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// ── FAB ───────────────────────────────────────────────────────────────────────
function fabClick() {
  if (activeView === 'tasks' || activeView === 'dashboard') openTaskModal(null);
  else if (activeView === 'projects') openProjectModal();
  else if (activeView === 'project-detail') openTaskModal(null);
}

// ── AI BOT ────────────────────────────────────────────────────────────────────
let botHistory = [];
let botOpen = false;

function botClear() {
  botHistory = [];
  const el = document.getElementById('bot-messages');
  if (el) el.innerHTML = '';
  botAppendMessage('assistant', "Hi! Tell me what you need — I'll create tasks and projects for you.");
}

function toggleBot() {
  botOpen = !botOpen;
  document.getElementById('bot-panel').classList.toggle('open', botOpen);
  document.getElementById('bot-toggle-btn').classList.toggle('active', botOpen);
  if (botOpen) {
    setTimeout(() => document.getElementById('bot-input')?.focus(), 220);
    if (!document.getElementById('bot-messages').children.length) {
      botAppendMessage('assistant', "Hi! Tell me what you need — I'll create tasks and projects for you.");
    }
  }
}

function botAppendMessage(role, text) {
  const el = document.getElementById('bot-messages');
  if (!el) return;
  const div = document.createElement('div');
  div.className = `bot-msg bot-msg-${role}`;
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function botSetThinking(on) {
  const el = document.getElementById('bot-messages');
  if (!el) return;
  const existing = document.getElementById('bot-thinking');
  if (on && !existing) {
    const div = document.createElement('div');
    div.id = 'bot-thinking';
    div.className = 'bot-msg bot-msg-assistant bot-thinking';
    div.innerHTML = '<span></span><span></span><span></span>';
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  } else if (!on && existing) {
    existing.remove();
  }
}

function botInputAutoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function botInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    botSend();
  }
}

function getBotConfig() {
  const provider = localStorage.getItem('bot_provider') || 'anthropic';
  const apiKey = localStorage.getItem('bot_api_key') || localStorage.getItem('anthropic_api_key') || '';
  const model = localStorage.getItem('bot_model') || (provider === 'anthropic' ? 'claude-opus-4-6' : 'gpt-4o');
  const baseUrl = localStorage.getItem('bot_base_url') || 'https://api.openai.com/v1';
  return { provider, apiKey, model, baseUrl };
}

async function botSend() {
  const input = document.getElementById('bot-input');
  const text = input?.value.trim();
  if (!text) return;

  const config = getBotConfig();
  if (!config.apiKey) {
    const el = document.getElementById('bot-messages');
    if (el) {
      const div = document.createElement('div');
      div.className = 'bot-msg bot-msg-assistant';
      div.innerHTML = '⚠️ Add your AI API key in <a href="setup.html" style="color:#c4b5fd;text-decoration:underline">Settings</a> first.';
      el.appendChild(div);
      el.scrollTop = el.scrollHeight;
    }
    return;
  }

  input.value = '';
  input.style.height = 'auto';
  botAppendMessage('user', text);
  botHistory.push({ role: 'user', content: text });

  const btn = document.getElementById('bot-send-btn');
  if (btn) btn.disabled = true;
  botSetThinking(true);

  try {
    if (config.provider === 'anthropic') {
      await botCallAnthropic(config);
    } else {
      await botCallOpenAI(config);
    }
  } catch (e) {
    botSetThinking(false);
    botAppendMessage('assistant', `Error: ${e.message || 'Something went wrong.'}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const BOT_TOOLS = [
  {
    name: 'create_task',
    description: 'Create a new task. Use when the user mentions something they need to do, a to-do item, or any actionable item. Call this multiple times if multiple tasks are mentioned.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, actionable task title' },
        description: { type: 'string', description: 'Optional details' },
        status: { type: 'string', enum: ['not_started', 'in_progress', 'stagnated', 'done', 'other'] },
        urgency: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        category: { type: 'string', description: 'Category such as work or personal' },
        dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format if mentioned' },
        projectId: { type: 'string', description: 'ID of an existing project to assign this task to' },
      },
      required: ['title'],
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project. Use when the user mentions a larger initiative, area of work, or collection of related tasks.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'What this project is about' },
        status: { type: 'string', enum: ['not_started', 'in_progress', 'stagnated', 'done', 'other'] },
        category: { type: 'string', description: 'Category such as work or personal' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_task',
    description: 'Update fields of an existing task. Use this when the user wants to change status, urgency, due date, title, description, or project assignment of a task that already exists.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to update (from the task list in the system prompt)' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        status: { type: 'string', enum: ['not_started', 'in_progress', 'stagnated', 'done', 'other'] },
        urgency: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        dueDate: { type: 'string', description: 'New due date YYYY-MM-DD, or empty string to clear' },
        projectId: { type: 'string', description: 'Project ID to assign, or empty string to unassign' },
      },
      required: ['taskId'],
    },
  },
];

function botSystemPrompt() {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const todayStr = new Date().toISOString().split('T')[0];

  const activeTasks = state.tasks.filter(t => t.status !== 'done');
  const doneTasks = state.tasks.filter(t => t.status === 'done');
  const overdueTasks = activeTasks.filter(t => t.dueDate && t.dueDate < todayStr);
  const stagnatedTasks = activeTasks.filter(t => t.status === 'stagnated');

  const taskLines = state.tasks.length
    ? state.tasks.map(t => {
        const proj = t.projectId ? state.projects.find(p => p.id === t.projectId) : null;
        const parts = [
          `[id:${t.id}]`,
          `"${t.title}"`,
          `status:${t.status}`,
          `urgency:${t.urgency || 'low'}`,
          proj ? `project:"${proj.name}"` : 'no-project',
          t.dueDate ? `due:${t.dueDate}` : 'no-due',
          t.description ? `desc:"${t.description.slice(0, 80).replace(/"/g, "'")}"` : '',
        ].filter(Boolean);
        return '  ' + parts.join(' | ');
      }).join('\n')
    : '  (no tasks yet)';

  const projectLines = state.projects.length
    ? state.projects.map(p => `  [id:${p.id}] "${p.name}" | status:${p.status} | category:${p.category}${p.description ? ` | desc:"${p.description.slice(0,60).replace(/"/g,"'")}"` : ''}`).join('\n')
    : '  (no projects yet)';

  return `You are a personal productivity assistant embedded in a task management platform. Today is ${today}.

=== PLATFORM STATE ===
Tasks: ${state.tasks.length} total | ${activeTasks.length} active | ${doneTasks.length} done | ${overdueTasks.length} overdue | ${stagnatedTasks.length} stagnated

ALL TASKS:
${taskLines}

PROJECTS:
${projectLines}

Categories available: ${state.categories.join(', ')}

=== YOUR TOOLS ===
- create_task: add a new task
- create_project: add a new project
- update_task: change fields of an existing task (status, urgency, due date, title, description, project)

=== GUIDELINES ===
When the user says something they need to do → immediately call create_task, no confirmation.
When asked to update a task (mark done, change urgency, etc.) → call update_task with the task's ID from the list above.
When asked questions like "what should I work on?" → analyze urgency, due dates, overdue items, and stagnated items. Give a specific, useful answer.
When asked to identify unclear tasks → look for vague titles, items with no description and no due date.
When asked for a daily schedule → group by urgency and suggest an order. Be concrete.
Keep tool call confirmations brief. Use the task IDs from the list above for update_task.
Infer urgency: "urgent"/"ASAP" → high/critical; "can wait"/"eventually" → low.
Infer due dates from relative expressions like "tomorrow", "next Friday", "end of week".`;
}

async function botCallAnthropic({ apiKey, model }) {
  // Build Anthropic-format messages from simple botHistory
  const messages = botHistory.map(m => ({ role: m.role, content: m.content }));
  let finalText = '';
  let didCreateItems = false;

  for (let iter = 0; iter < 8; iter++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-client-side-access-api-key': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: botSystemPrompt(),
        tools: BOT_TOOLS,
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${res.status}`);
    }

    const data = await res.json();
    const content = data.content || [];
    messages.push({ role: 'assistant', content });

    const textParts = content.filter(b => b.type === 'text').map(b => b.text);
    if (textParts.length) finalText = textParts.join(' ');

    const toolUses = content.filter(b => b.type === 'tool_use');
    if (!toolUses.length || data.stop_reason === 'end_turn') break;

    const toolResults = [];
    for (const tu of toolUses) {
      const result = botExecuteTool(tu.name, tu.input);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
      didCreateItems = true;
    }
    if (didCreateItems) { await persist(); render(); }
    messages.push({ role: 'user', content: toolResults });
  }

  botSetThinking(false);
  if (finalText) botAppendMessage('assistant', finalText);
  else if (didCreateItems) botAppendMessage('assistant', 'Done!');

  // Persist only simple text back to history
  botHistory.push({ role: 'assistant', content: finalText || 'Done!' });
}

async function botCallOpenAI({ apiKey, model, baseUrl }) {
  // OpenAI-compatible format (OpenAI, Groq, Ollama, OpenRouter, etc.)
  const oaiTools = BOT_TOOLS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  // Build messages with system prompt prepended
  const messages = [
    { role: 'system', content: botSystemPrompt() },
    ...botHistory.map(m => ({ role: m.role, content: m.content })),
  ];

  let finalText = '';
  let didCreateItems = false;

  for (let iter = 0; iter < 8; iter++) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, max_tokens: 1024, tools: oaiTools, messages }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${res.status}`);
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) break;

    messages.push(msg);

    if (msg.content) finalText = msg.content;

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length || data.choices[0].finish_reason === 'stop') break;

    for (const tc of toolCalls) {
      const input = JSON.parse(tc.function.arguments);
      const result = botExecuteTool(tc.function.name, input);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      didCreateItems = true;
    }
    if (didCreateItems) { await persist(); render(); }
  }

  botSetThinking(false);
  if (finalText) botAppendMessage('assistant', finalText);
  else if (didCreateItems) botAppendMessage('assistant', 'Done!');

  botHistory.push({ role: 'assistant', content: finalText || 'Done!' });
}

function botExecuteTool(name, input) {
  try {
    if (name === 'create_task') {
      const cat = state.categories.includes(input.category) ? input.category : (state.categories[0] || 'personal');
      const projId = input.projectId && state.projects.find(p => p.id === input.projectId) ? input.projectId : null;
      const task = {
        id: uuid(),
        title: input.title,
        description: input.description || '',
        status: input.status || 'not_started',
        urgency: input.urgency || 'low',
        category: cat,
        dueDate: input.dueDate || null,
        projectId: projId,
        subtasks: [],
        createdAt: new Date().toISOString(),
      };
      state.tasks.push(task);
      return `Created task "${task.title}" (id: ${task.id})`;
    }

    if (name === 'create_project') {
      const cat = state.categories.includes(input.category) ? input.category : (state.categories[0] || 'personal');
      const project = {
        id: uuid(),
        name: input.name,
        description: input.description || '',
        status: input.status || 'not_started',
        category: cat,
        createdAt: new Date().toISOString(),
      };
      state.projects.push(project);
      return `Created project "${project.name}" (id: ${project.id})`;
    }

    if (name === 'update_task') {
      const task = state.tasks.find(t => t.id === input.taskId);
      if (!task) return `Task not found: ${input.taskId}`;
      if (input.title !== undefined) task.title = input.title;
      if (input.description !== undefined) task.description = input.description;
      if (input.status !== undefined) task.status = input.status;
      if (input.urgency !== undefined) task.urgency = input.urgency;
      if (input.dueDate !== undefined) task.dueDate = input.dueDate || null;
      if (input.projectId !== undefined) {
        task.projectId = input.projectId && state.projects.find(p => p.id === input.projectId) ? input.projectId : null;
      }
      return `Updated task "${task.title}" (id: ${task.id})`;
    }

    return `Unknown tool: ${name}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// ── POMODORO ──────────────────────────────────────────────────────────────────
const POMO_CIRC = 552.9; // 2π × r=88

function _pomoClearInterval() {
  if (pomo._interval !== null) {
    clearInterval(pomo._interval);
    pomo._interval = null;
  }
  pomo.running = false;
}

const pomo = {
  mode: 'work',
  secondsLeft: 25 * 60,
  totalSeconds: 25 * 60,
  running: false,
  round: 0,        // completed work rounds in current cycle (0–3)
  totalToday: 0,   // total completed work sessions today
  projectId: null,
  taskId: null,
  sessionPlan: '',
  history: [],     // [{taskTitle, plan, completedAt, duration}]
  cfg: { work: 25, short: 5, long: 15 },
  _interval: null,
  _planSaveTimer: null,
};

function pomoModeDuration(mode) {
  return pomo.cfg[mode] * 60;
}

function pomoSetMode(mode) {
  _pomoClearInterval();
  pomo.mode = mode;
  pomo.secondsLeft = pomoModeDuration(mode);
  pomo.totalSeconds = pomo.secondsLeft;
  pomoSave();
  renderPomodoro();
}

function pomoToggle() {
  if (pomo.running) {
    _pomoClearInterval();
  } else {
    pomo.running = true;
    pomo._interval = setInterval(pomoTick, 1000);
  }
  updatePomoDisplay();
}

function pomoReset() {
  _pomoClearInterval();
  pomo.secondsLeft = pomoModeDuration(pomo.mode);
  pomo.totalSeconds = pomo.secondsLeft;
  updatePomoDisplay();
}

function pomoTick() {
  if (pomo.secondsLeft <= 0) {
    pomoComplete();
    return;
  }
  pomo.secondsLeft--;
  updatePomoDisplay();
}

function pomoComplete() {
  _pomoClearInterval();
  pomoBeep();

  if (pomo.mode === 'work') {
    pomo.totalToday++;
    pomo.round = (pomo.round + 1) % 4;
    const taskTitle = pomo.taskId
      ? (state.tasks.find(t => t.id === pomo.taskId)?.title || null)
      : null;
    pomo.history.unshift({
      taskTitle,
      plan: pomo.sessionPlan || '',
      completedAt: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      duration: pomo.cfg.work,
    });
    if (pomo.history.length > 20) pomo.history.pop();
    logPomoCompleted(pomo.cfg.work);
    // Advance to break
    pomo.mode = pomo.round === 0 ? 'long' : 'short';
  } else {
    pomo.mode = 'work';
  }
  pomo.secondsLeft = pomoModeDuration(pomo.mode);
  pomo.totalSeconds = pomo.secondsLeft;
  pomoSave();
  renderPomodoro();
}

function pomoBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.3, 0.6].forEach(delay => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.5, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.25);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.25);
    });
  } catch (e) { /* AudioContext not available */ }
}

function updatePomoDisplay() {
  const ring = document.querySelector('.pomo-ring-fill');
  const timeEl = document.querySelector('.pomo-time-display');
  const btn = document.getElementById('pomo-btn');
  if (!ring || !timeEl) return;

  const progress = pomo.totalSeconds > 0 ? pomo.secondsLeft / pomo.totalSeconds : 1;
  ring.setAttribute('stroke-dashoffset', (POMO_CIRC * (1 - progress)).toFixed(2));

  const m = String(Math.floor(pomo.secondsLeft / 60)).padStart(2, '0');
  const s = String(pomo.secondsLeft % 60).padStart(2, '0');
  timeEl.innerHTML = `<span class="pomo-mm">${m}</span><span class="pomo-colon">:</span><span class="pomo-ss">${s}</span>`;

  if (btn) btn.textContent = pomo.running ? 'Pause' : (pomo.secondsLeft < pomo.totalSeconds ? 'Resume' : 'Start');
}

function pomoSave() {
  const todayStr = new Date().toISOString().split('T')[0];
  localStorage.setItem('pomo_state', JSON.stringify({
    mode: pomo.mode,
    round: pomo.round,
    totalToday: pomo.totalToday,
    history: pomo.history,
    cfg: pomo.cfg,
    projectId: pomo.projectId,
    taskId: pomo.taskId,
    sessionPlan: pomo.sessionPlan,
    savedDate: todayStr,
  }));
}

function pomoRestore() {
  try {
    const raw = localStorage.getItem('pomo_state');
    if (!raw) return;
    const saved = JSON.parse(raw);
    const todayStr = new Date().toISOString().split('T')[0];
    const sameDay = saved.savedDate === todayStr;

    pomo.cfg = { work: 25, short: 5, long: 15, ...saved.cfg };
    pomo.mode = saved.mode || 'work';
    pomo.round = sameDay ? (saved.round || 0) : 0;
    pomo.totalToday = sameDay ? (saved.totalToday || 0) : 0;
    pomo.history = sameDay ? (saved.history || []) : [];
    pomo.projectId = saved.projectId || null;
    pomo.taskId = saved.taskId || null;
    pomo.sessionPlan = saved.sessionPlan || '';
    // Always reset timer to full duration (don't restore partial timer)
    pomo.secondsLeft = pomoModeDuration(pomo.mode);
    pomo.totalSeconds = pomo.secondsLeft;
    pomo.running = false;
    pomo._interval = null;
  } catch (e) { /* ignore corrupt state */ }
}

function pomoSelectProject(id) {
  pomo.projectId = id || null;
  pomo.taskId = null; // reset task when project changes
  pomoSave();
  renderPomodoro();
}

function pomoSelectTask(id) {
  pomo.taskId = id || null;
  pomoSave();
}

function pomoUpdatePlan(val) {
  pomo.sessionPlan = val;
  clearTimeout(pomo._planSaveTimer);
  pomo._planSaveTimer = setTimeout(() => pomoSave(), 600);
}

function pomoCfgChange(key, val) {
  const n = parseInt(val, 10);
  if (!isNaN(n) && n > 0) {
    pomo.cfg[key] = n;
    if (pomo.mode === key && !pomo.running) {
      pomo.secondsLeft = n * 60;
      pomo.totalSeconds = pomo.secondsLeft;
      updatePomoDisplay();
    }
    pomoSave();
  }
}

function renderPomodoro() {
  const el = document.getElementById('view-pomodoro');
  if (!el) return;

  const modeColors = { work: '#7c3aed', short: '#10b981', long: '#3b82f6' };
  const modeLabels = { work: 'Focus', short: 'Short Break', long: 'Long Break' };
  const color = modeColors[pomo.mode];

  const progress = pomo.totalSeconds > 0 ? pomo.secondsLeft / pomo.totalSeconds : 1;
  const offset = (POMO_CIRC * (1 - progress)).toFixed(2);
  const m = String(Math.floor(pomo.secondsLeft / 60)).padStart(2, '0');
  const s = String(pomo.secondsLeft % 60).padStart(2, '0');
  const btnLabel = pomo.running ? 'Pause' : (pomo.secondsLeft < pomo.totalSeconds ? 'Resume' : 'Start');

  // Round dots + label
  const dots = Array.from({ length: 4 }, (_, i) =>
    `<div class="pomo-dot ${i < pomo.round ? 'filled' : ''}" style="${i < pomo.round ? `background:${color};border-color:${color};` : ''}"></div>`
  ).join('');
  const roundLabel = pomo.mode === 'work'
    ? `Session ${pomo.round + 1} of 4`
    : (pomo.mode === 'long' ? 'Long break — great work!' : 'Short break');

  // Project + task selector
  const projOptions = state.projects.map(p =>
    `<option value="${p.id}" ${p.id === pomo.projectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
  ).join('');

  const activeTasks = state.tasks.filter(t => t.status !== 'done' &&
    (!pomo.projectId || t.projectId === pomo.projectId));
  const taskOptions = activeTasks.map(t => {
    const proj = !pomo.projectId && t.projectId ? state.projects.find(p => p.id === t.projectId) : null;
    const label = escapeHtml(t.title) + (proj ? ` · ${escapeHtml(proj.name)}` : '');
    return `<option value="${t.id}" ${t.id === pomo.taskId ? 'selected' : ''}>${label}</option>`;
  }).join('');

  // History rows
  const historyRows = pomo.history.length
    ? pomo.history.map(h =>
        `<div class="pomo-hist-row">
          <span class="pomo-hist-time">${h.completedAt}</span>
          <span class="pomo-hist-task">${h.taskTitle || '—'}</span>
          <span class="pomo-hist-dur">${h.duration}m</span>
        </div>`
      ).join('')
    : `<div class="pomo-hist-empty">No sessions yet today</div>`;

  el.innerHTML = `
    <div class="pomo-container">
      <div class="pomo-header">
        <h2 class="pomo-title">Pomodoro</h2>
        <div class="pomo-stat">${pomo.totalToday > 0 ? `${pomo.totalToday} session${pomo.totalToday !== 1 ? 's' : ''} today` : 'Ready to focus'}</div>
      </div>

      <div class="pomo-mode-tabs">
        ${['work', 'short', 'long'].map(mode =>
          `<button class="pomo-mode-tab ${pomo.mode === mode ? 'active' : ''}"
            onclick="pomoSetMode('${mode}')"
            style="${pomo.mode === mode ? `background:${modeColors[mode]}22;color:${modeColors[mode]};border-color:${modeColors[mode]}66;` : ''}"
          >${modeLabels[mode]}</button>`
        ).join('')}
      </div>

      <div class="pomo-timer-section">
        <div class="pomo-timer-wrap">
          <svg class="pomo-ring" viewBox="0 0 200 200">
            <circle class="pomo-ring-bg" cx="100" cy="100" r="88"/>
            <circle class="pomo-ring-fill" cx="100" cy="100" r="88"
              stroke="${color}"
              stroke-dasharray="${POMO_CIRC}"
              stroke-dashoffset="${offset}"
              transform="rotate(-90 100 100)"/>
          </svg>
          <div class="pomo-time-display">
            <span class="pomo-mm">${m}</span><span class="pomo-colon">:</span><span class="pomo-ss">${s}</span>
          </div>
        </div>

        <div class="pomo-rounds">${dots}</div>
        <div class="pomo-round-label">${roundLabel}</div>

        <div class="pomo-controls">
          <button class="btn btn-ghost pomo-reset-btn" onclick="pomoReset()" title="Reset">↺</button>
          <button class="btn pomo-start-btn" id="pomo-btn" onclick="pomoToggle()"
            style="background:${color};"
          >${btnLabel}</button>
        </div>
      </div>

      <div class="pomo-task-section">
        <label class="pomo-task-label">Working on</label>
        ${state.projects.length ? `
        <select class="pomo-task-select" onchange="pomoSelectProject(this.value)" style="margin-bottom:8px">
          <option value="">— all projects —</option>
          ${projOptions}
        </select>` : ''}
        <select class="pomo-task-select" onchange="pomoSelectTask(this.value)">
          <option value="">— no task selected —</option>
          ${taskOptions}
        </select>
        <div class="pomo-plan-wrap">
          <textarea class="pomo-plan-input" placeholder="Session plan — what exactly will you do?" rows="3"
            oninput="pomoUpdatePlan(this.value)">${escapeHtml(pomo.sessionPlan)}</textarea>
        </div>
      </div>

      <div class="pomo-bottom">
        <div class="pomo-config">
          <div class="pomo-section-title">Timer settings (min)</div>
          <div class="pomo-cfg-row">
            <label>Focus <input type="number" min="1" max="90" value="${pomo.cfg.work}" oninput="pomoCfgChange('work',this.value)" class="pomo-cfg-input"/></label>
            <label>Short break <input type="number" min="1" max="30" value="${pomo.cfg.short}" oninput="pomoCfgChange('short',this.value)" class="pomo-cfg-input"/></label>
            <label>Long break <input type="number" min="1" max="60" value="${pomo.cfg.long}" oninput="pomoCfgChange('long',this.value)" class="pomo-cfg-input"/></label>
          </div>
        </div>

        <div class="pomo-history">
          <div class="pomo-section-title">Session history</div>
          <div class="pomo-hist-list">${historyRows}</div>
        </div>
      </div>
    </div>
  `;
}

// ── CLOCK ─────────────────────────────────────────────────────────────────────
function updateHeaderClock() {
  const el = document.getElementById('header-clock');
  if (!el) return;
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  el.textContent = `${date} · ${time}`;
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  if (!DriveStorage.isConfigured()) {
    window.location.href = 'setup.html';
    return;
  }

  if (!DriveStorage.isSignedIn()) {
    // Try silent sign-in first; show sign-in screen on failure
    try {
      await DriveStorage.signIn();
    } catch (e) {
      document.body.innerHTML = `
        <div style="height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0f0f13;color:#e8e8f0;font-family:Inter,sans-serif;gap:24px;">
          <div style="font-size:32px;font-weight:700;background:linear-gradient(135deg,#a78bfa,#60a5fa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">my platform</div>
          <div style="color:#6b7280;font-size:14px;">Sign in to access your data</div>
          <button onclick="window.location.reload()" style="padding:14px 32px;border-radius:999px;border:none;background:linear-gradient(135deg,#7c3aed,#3b82f6);color:#fff;font-size:15px;font-weight:600;cursor:pointer;">Sign in with Google</button>
          <a href="setup.html" style="color:#4b5563;font-size:12px;text-decoration:none;">Settings</a>
        </div>`;
      return;
    }
  }

  // Restore persisted UI state
  try {
    const savedFilters = JSON.parse(localStorage.getItem('filters') || 'null');
    if (savedFilters) Object.assign(filters, savedFilters);
  } catch (e) {}
  pomoRestore();

  await loadData();
  purgeOldTrash();
  navigate('dashboard');

  updateHeaderClock();
  setInterval(updateHeaderClock, 1000);

  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); fabClick(); }
  });
}

document.addEventListener('DOMContentLoaded', init);
