// ── STATE ────────────────────────────────────────────────────────────────────
let state = { projects: [], tasks: [], categories: ['work', 'personal'] };
let filters = { status: 'all', category: 'all' };
let activeView = 'dashboard';
let activeProjectId = null;
let saving = false;
let _subtasks = []; // temp state while editing subtasks in modal

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
  const clickable = taskId ? `onclick="cycleStatus(event,'${taskId}')" title="Tap to change status" style="cursor:pointer"` : '';
  return `<span class="pill pill-status-${s}" ${clickable}>${STATUS_LABELS[s] || s}</span>`;
}

function catPill(c) {
  return `<span class="pill pill-cat">${c}</span>`;
}

function urgencyBadge(u) {
  if (!u || u === 'low') return '';
  return `<span class="urgency-badge urgency-${u}">${URGENCY_LABELS[u]}</span>`;
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
        <div class="widget-icon">🌤</div>
        <div class="widget-body">
          <div class="widget-label">Weather</div>
          <div class="widget-value muted">Connect in settings</div>
        </div>
      </div>
      <div class="widget">
        <div class="widget-icon">📅</div>
        <div class="widget-body">
          <div class="widget-label">Today's Schedule</div>
          <div class="widget-value muted">Connect Gmail in settings</div>
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

  const dueMeta = t.dueDate ? `
    <span class="due-badge ${overdue ? 'overdue' : ''}">
      📅 ${fmt(t.dueDate)}${overdue ? ' overdue' : ''}
    </span>
  ` : '';

  const subtaskMeta = subtasks.length ? `
    <span class="subtask-count">${subtasksDone}/${subtasks.length} subtasks</span>
  ` : '';

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
        <button class="btn btn-ghost btn-sm btn-icon" style="color:#f87171" onclick="deleteTask(event,'${t.id}')">✕</button>
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

async function cycleStatus(e, id) {
  e.stopPropagation();
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  const idx = STATUS_CYCLE.indexOf(task.status);
  task.status = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
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

async function deleteProject(id) {
  if (!confirm('Delete this project and all its tasks?')) return;
  state.projects = state.projects.filter(p => p.id !== id);
  state.tasks = state.tasks.filter(t => t.projectId !== id);
  await persist();
  navigate('projects');
}

// ── SUBTASK EDITING (in modal) ─────────────────────────────────────────────────
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

  // Determine context defaults (when adding from inside a project)
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
      projectId: projectCtx, subtasks, createdAt: new Date().toISOString()
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
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-body').innerHTML = html;
  overlay.classList.add('open');
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
