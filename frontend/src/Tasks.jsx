import { useEffect, useRef, useState } from 'react'
import { api, PROVIDER_LABEL } from './api.js'

const STATUS = { running: ['実行中', 'run'], done: ['完了', 'ok'], error: ['失敗', 'err'], cancelled: ['中止', ''],
  confirm: ['確認待ち', 'run'], approved: ['許可済み', 'ok'], declined: ['却下', ''] }
const fmt = (ts) => new Date(ts * 1000).toLocaleString('ja-JP', { hour12: false })

export function StatusBadge({ s }) {
  const [label, cls] = STATUS[s] || [s, '']
  return <span className={`badge ${cls}`}>{label}</span>
}

function LogView({ taskId, onChanged }) {
  const [task, setTask] = useState(null)
  const [lines, setLines] = useState([])
  const [follow, setFollow] = useState(true)
  const [showDebug, setShowDebug] = useState(true)
  const box = useRef(null)

  useEffect(() => {
    setLines([]); setTask(null)
    let es
    const load = () => api.task(taskId).then(setTask)
    load()
    es = new EventSource(`/api/tasks/${taskId}/events`)
    es.onmessage = (e) => setLines((l) => [...l, JSON.parse(e.data)])
    es.addEventListener('end', () => { es.close(); load(); onChanged?.() })
    es.onerror = () => { /* 自動再接続を止める(終了時) */ if (es.readyState === 2) es.close() }
    return () => es.close()
  }, [taskId])

  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight }, [lines, follow])

  if (!task) return <p className="muted pad">読み込み中…</p>
  const visible = lines.filter((l) => showDebug || l.level !== 'debug')
  return (
    <div className="logview">
      <div className="loghead">
        <div>
          <b>#{task.id} {task.title}</b>
          <div className="muted">{PROVIDER_LABEL[task.provider] || task.provider}{task.model ? ` / ${task.model}` : ''} ・ {fmt(task.created_at)} ・ <StatusBadge s={task.status} /></div>
        </div>
        <div className="row">
          <label className="check"><input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} />詳細</label>
          <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />追従</label>
          {task.status === 'running' && <button className="btn danger" onClick={() => api.cancelTask(task.id)}>中止</button>}
        </div>
      </div>
      <div className="logbox" ref={box}>
        {visible.map((l) => (
          <div key={l.id} className={`ln ${l.level}`}>
            <span className="ts">{new Date(l.ts * 1000).toLocaleTimeString('ja-JP', { hour12: false })}</span>
            <span className="tx">{l.text}</span>
          </div>
        ))}
        {task.status === 'running' && <div className="ln info blink">▍</div>}
      </div>
      {task.answer && <div className="answer"><b>回答</b><div>{task.answer}</div></div>}
    </div>
  )
}

export default function Tasks({ selected, setSelected }) {
  const [tasks, setTasks] = useState([])
  const refresh = () => api.tasks().then(setTasks).catch(() => {})
  useEffect(() => { refresh(); const t = setInterval(refresh, 1500); return () => clearInterval(t) }, [])

  const del = async (e, id) => { e.stopPropagation(); await api.deleteTask(id).catch((er) => alert(er.message)); if (selected === id) setSelected(null); refresh() }

  return (
    <div className="tasks">
      <div className="tasklist">
        <h2>タスク</h2>
        {tasks.length === 0 && <p className="muted pad">まだタスクはありません。会話を始めると、依頼ごとにここへログが残ります。</p>}
        {tasks.map((t) => (
          <div key={t.id} className={`taskitem ${selected === t.id ? 'sel' : ''}`} onClick={() => setSelected(t.id)}>
            <div className="row between"><b>#{t.id}</b><StatusBadge s={t.status} /></div>
            <div className="ttl">{t.title}</div>
            <div className="muted row between"><span>{PROVIDER_LABEL[t.provider] || t.provider}{t.model ? ` / ${t.model}` : ''}</span>
              <span>{fmt(t.created_at)}{t.status !== 'running' && <button className="x" title="削除" onClick={(e) => del(e, t.id)}>×</button>}</span></div>
          </div>
        ))}
      </div>
      <div className="logpane">
        {selected ? <LogView key={selected} taskId={selected} onChanged={refresh} /> : <p className="muted pad">左のタスクを選ぶとログが表示されます。</p>}
      </div>
    </div>
  )
}
