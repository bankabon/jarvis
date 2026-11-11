async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    let msg = r.statusText
    try { msg = (await r.json()).detail || msg } catch {}
    throw new Error(msg)
  }
  return r.json()
}

async function raw(url, int16) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: int16 })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.detail || r.statusText)
  return j
}

export const api = {
  settings: () => req('GET', '/api/settings'),
  saveSettings: (p) => req('PUT', '/api/settings', p),
  providers: () => req('GET', '/api/providers'),
  voices: () => req('GET', '/api/voices'),
  conversations: (archived = false) => req('GET', `/api/conversations?archived=${archived}`),
  archive: (id) => req('POST', `/api/conversations/${id}/archive`),
  unarchive: (id) => req('POST', `/api/conversations/${id}/unarchive`),
  newConversation: () => req('POST', '/api/conversations'),
  conversation: (id) => req('GET', `/api/conversations/${id}`),
  deleteConversation: (id) => req('DELETE', `/api/conversations/${id}`),
  send: (id, text, provider, model) => req('POST', `/api/conversations/${id}/messages`, { text, provider, model: model || null }),
  speakerProfiles: () => req('GET', '/api/speaker/profiles'),
  speakerCreate: (name) => req('POST', '/api/speaker/profiles', { name }),
  speakerDelete: (id) => req('DELETE', `/api/speaker/profiles/${id}`),
  speakerEnable: (id, enabled) => req('PUT', `/api/speaker/profiles/${id}/enabled`, { enabled }),
  speakerReset: (id) => req('POST', `/api/speaker/profiles/${id}/reset`),
  speakerAddSample: (id, pcm) => raw(`/api/speaker/profiles/${id}/samples`, pcm),
  speakerVerify: (pcm) => raw('/api/speaker/verify', pcm),
  stt: (pcm) => raw('/api/stt', pcm),
  tasks: () => req('GET', '/api/tasks'),
  task: (id) => req('GET', `/api/tasks/${id}`),
  approve: (id, all = false) => req('POST', `/api/tasks/${id}/approve`, { all }),
  decline: (id) => req('POST', `/api/tasks/${id}/decline`),
  setAllowAll: (id, value) => req('PUT', `/api/conversations/${id}/allow_all`, { value }),
  cancelTask: (id) => req('POST', `/api/tasks/${id}/cancel`),
  deleteTask: (id) => req('DELETE', `/api/tasks/${id}`),
}

export const PROVIDER_LABEL = { kiro: 'Kiro CLI', claude: 'Claude Code', codex: 'ChatGPT (Codex)' }
