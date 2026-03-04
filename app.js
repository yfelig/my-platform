// ── STATE ────────────────────────────────────────────────────────────────────
let state = { projects: [], tasks: [], categories: ['work', 'personal'] };
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

// ── PERSISTENCE ───────────────────────────────────────────────────────────────
async function loadData() {
  try {
    state = await Gist.load();
    if (!state.categories) state.categories = ['work', 'personal'];
  } catch (e) {
    console.error('Load failed', e);
  }
}

async function persist() {
  if (saving) return;
  saving = true;
  try { await Gist.save(state); }
  catch (e) { console.error('Save failed', e); }
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

  render();
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function render() {
  if (activeView === 'dashboard') renderDashboard();
  if (activeView === 'projects') renderProjects();
  if (activeView === 'project-detail') renderProjectDetail();
  if (activeView === 'tasks') renderTasks();
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

  // Serve from cache if fresh (30 min)
  const cached = JSON.parse(localStorage.getItem('wx_cache') || 'null');
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
    valEl.textContent = cached.text;
    valEl.classList.remove('muted');
    if (iconEl) iconEl.textContent = cached.icon;
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

function getValidGoogleToken() {
  const token = localStorage.getItem('google_access_token');
  const expiry = parseInt(localStorage.getItem('google_token_expiry') || '0');
  if (token && Date.now() < expiry - 60000) return token;
  return null;
}

async function loadCalendar() {
  const el = document.getElementById('calendar-widget-body');
  if (!el) return;

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
        <h1 class="page-title">Good to see you, <span>Yair</span> 👋</h1>
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
  const cards = state.projects.map(p => `
    <div class="project-card" onclick="navigate('project-detail','${p.id}')">
      <div class="project-card-name">${p.name}</div>
      <div class="project-card-desc">${p.description || 'No description'}</div>
      <div class="project-card-footer">
        ${statusPill(p.status)}
        ${catPill(p.category)}
      </div>
    </div>
  `).join('');

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

  document.getElementById('view-project-detail').innerHTML = `
    <button class="back-btn" onclick="navigate('projects')">← Projects</button>
    <div class="page-header">
      <div>
        <h1 class="page-title"><span>${p.name}</span></h1>
        ${p.description ? `<p style="color:var(--text-muted);font-size:14px;margin-top:6px">${p.description}</p>` : ''}
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

  return `
    <div class="task-item ${isDone ? 'done' : ''}" onclick="openTaskModal(event,'${t.id}')">
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
    </div>
  `;
}

function bindTaskEvents() {}

// ── FILTERS ───────────────────────────────────────────────────────────────────
function setFilter(key, val) {
  filters[key] = val;
  renderTasks();
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
  task.status = task.status === 'done' ? 'not_started' : 'done';
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

  // Position below the clicked pill, clamp to viewport
  const rect = e.currentTarget.getBoundingClientRect();
  const pickerW = 160;
  let left = rect.left + window.scrollX;
  if (left + pickerW > window.innerWidth - 8) left = window.innerWidth - pickerW - 8;
  picker.style.top = `${rect.bottom + window.scrollY + 6}px`;
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

async function deleteTask(e, id) {
  e.stopPropagation();
  if (!confirm('Delete this task?')) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  await persist();
  render();
}

async function deleteTaskFromModal(id) {
  if (!confirm('Delete this task?')) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  closeModal();
  await persist();
  render();
}

async function deleteProject(id) {
  if (!confirm('Delete this project and all its tasks?')) return;
  state.projects = state.projects.filter(p => p.id !== id);
  state.tasks = state.tasks.filter(t => t.projectId !== id);
  await persist();
  navigate('projects');
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

// ── TASK MODAL ────────────────────────────────────────────────────────────────
function openTaskModal(e, id) {
  if (e) e.stopPropagation();
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
    state.tasks.push({
      id: uuid(), title, status, category, urgency, dueDate, description,
      projectId: projectCtx, subtasks, createdAt: new Date().toISOString(),
    });
  }

  closeModal();
  await persist();
  render();
}

// ── PROJECT MODAL ─────────────────────────────────────────────────────────────
function openProjectModal(id) {
  const p = id ? state.projects.find(x => x.id === id) : null;

  showModal(`
    <div class="modal-title">${p ? 'Edit Project' : 'New Project'}</div>
    <div class="field">
      <label>Name</label>
      <input id="p-name" type="text" value="${p ? p.name : ''}" placeholder="Project name" />
    </div>
    <div class="field">
      <label>Description</label>
      <textarea id="p-desc" rows="3" placeholder="What's this project about?">${p ? p.description : ''}</textarea>
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

  if (id) {
    const p = state.projects.find(x => x.id === id);
    if (p) Object.assign(p, { name, description, status, category });
  } else {
    state.projects.push({ id: uuid(), name, description, status, category, createdAt: new Date().toISOString() });
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

async function botSend() {
  const input = document.getElementById('bot-input');
  const text = input?.value.trim();
  if (!text) return;

  const apiKey = localStorage.getItem('anthropic_api_key');
  if (!apiKey) {
    botAppendMessage('assistant', '⚠️ Add your Anthropic API key in Settings (⚙) first.');
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
    await botCallClaude(apiKey);
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
];

function botSystemPrompt() {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const projectList = state.projects.length
    ? state.projects.map(p => `- ${p.name} (id: ${p.id}, status: ${p.status}, category: ${p.category})`).join('\n')
    : 'No projects yet.';
  const categoryList = state.categories.join(', ');

  return `You are a personal productivity assistant. Today is ${today}.

When the user tells you things they need to do, immediately call create_task or create_project — don't ask for confirmation. Create multiple tasks in one response if needed.

Existing projects:\n${projectList}

Available categories: ${categoryList}

Guidelines:
- If a project is mentioned by name and it already exists, use its ID for the task's projectId
- Infer urgency from language: "urgent"/"ASAP" → high or critical; "can wait"/"eventually" → low
- Infer due dates from relative expressions ("tomorrow", "next Friday", "next week")
- Keep task titles short and actionable (verb + object)
- After creating items, respond with a short confirmation — don't repeat the full list
- If the user asks a question unrelated to creating tasks, just answer it helpfully`;
}

async function botCallClaude(apiKey) {
  const messages = [...botHistory];
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
        model: 'claude-opus-4-6',
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

    if (didCreateItems) {
      await persist();
      render();
    }

    messages.push({ role: 'user', content: toolResults });
  }

  botSetThinking(false);
  if (finalText) {
    botAppendMessage('assistant', finalText);
  } else if (didCreateItems) {
    botAppendMessage('assistant', 'Done!');
  }

  botHistory = messages;
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

    return `Unknown tool: ${name}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  if (!Gist.isConfigured()) {
    window.location.href = 'setup.html';
    return;
  }

  await loadData();
  navigate('dashboard');

  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); fabClick(); }
  });
}

document.addEventListener('DOMContentLoaded', init);
