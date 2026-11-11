import { useEffect, useRef, useState } from 'react'

const MAX_LINES = 200

// 右上に浮かぶ、実行中タスクのリアルタイムログ。
// 起動コマンド($ ...)、ツール呼び出し(🔧)、結果(↳)、エラーが流れてくる。
export default function LivePanel({ taskId, onOpenTask, onClose }) {
  const [lines, setLines] = useState([])
  const [live, setLive] = useState(false)
  const [open, setOpen] = useState(true)
  const [cmdOnly, setCmdOnly] = useState(false)
  const box = useRef(null)

  useEffect(() => {
    setLines([]); setLive(true)
    if (!taskId) return
    const es = new EventSource(`/api/tasks/${taskId}/events`)
    es.onmessage = (e) => {
      try { setLines((l) => [...l, JSON.parse(e.data)].slice(-MAX_LINES)) } catch {}
    }
    es.addEventListener('end', () => { setLive(false); es.close() })
    es.onerror = () => { if (es.readyState === 2) { setLive(false); es.close() } }
    return () => es.close()
  }, [taskId])

  useEffect(() => { if (open && box.current) box.current.scrollTop = box.current.scrollHeight }, [lines, open, cmdOnly])

  if (!taskId) return null
  // 起動コマンド($ ...) / Claudeのツール(level=tool) / Kiroのツール([tool] ...)
  const isCmd = (l) => l.level === 'tool' || /^(\$ |\[tool\])/.test(l.text || '')
  const visible = cmdOnly ? lines.filter(isCmd) : lines

  return (
    <div className={`livepanel ${open ? '' : 'min'}`}>
      <div className="livehead" onClick={() => setOpen((v) => !v)}>
        <span><span className={`dot ${live ? 'on' : ''}`} />実行ログ #{taskId}</span>
        <span className="row">
          {open && <label className="check" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={cmdOnly} onChange={(e) => setCmdOnly(e.target.checked)} />コマンドのみ
          </label>}
          <button className="x" title="タスク画面で開く" onClick={(e) => { e.stopPropagation(); onOpenTask?.(taskId) }}>↗</button>
          <button className="x" title="閉じる" onClick={(e) => { e.stopPropagation(); onClose?.() }}>×</button>
        </span>
      </div>
      {open && (
        <div className="livebox" ref={box}>
          {visible.map((l) => (
            <div key={l.id} className={`ln ${l.level}`}>
              <span className="tx">{l.text}</span>
            </div>
          ))}
          {live && <div className="ln info blink">▍</div>}
        </div>
      )}
    </div>
  )
}
