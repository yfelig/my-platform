const Gist = (() => {
  const BASE = 'https://api.github.com';

  function getConfig() {
    return {
      token: localStorage.getItem('gist_token'),
      gistId: localStorage.getItem('gist_id'),
    };
  }

  function isConfigured() {
    const { token, gistId } = getConfig();
    return !!(token && gistId);
  }

  async function request(method, path, body) {
    const { token } = getConfig();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    return res.json();
  }

  async function load() {
    const { gistId } = getConfig();
    const data = await request('GET', `/gists/${gistId}`);
    const content = data.files['data.json']?.content;
    if (!content) return defaultData();
    return JSON.parse(content);
  }

  async function save(data) {
    const { gistId } = getConfig();
    await request('PATCH', `/gists/${gistId}`, {
      files: { 'data.json': { content: JSON.stringify(data, null, 2) } },
    });
  }

  async function createGist(token) {
    const res = await fetch(`${BASE}/gists`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({
        description: 'my-platform data',
        public: false,
        files: { 'data.json': { content: JSON.stringify(defaultData(), null, 2) } },
      }),
    });
    if (!res.ok) throw new Error(`Failed to create Gist: ${res.status}`);
    const data = await res.json();
    return data.id;
  }

  function defaultData() {
    return { projects: [], tasks: [], categories: ['work', 'personal'] };
  }

  return { load, save, createGist, isConfigured, getConfig, defaultData };
})();
