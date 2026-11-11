import { useEffect, useRef, useState } from 'react'
import { PROVIDER_LABEL } from './api.js'

export default function Chat({ messages, interim, installed, provider, setProvider, onSend, busy, onOpenTask, onSpeak, listening, onMic, pendingConfirm, onApprove, onDecline, allowAll, onRevokeAll, model, setModel, modelOptions }) {
  const [text, setText] = useState('')
  const end = useRef(null)
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, interim, busy])

  const submit = () => { const t = text.trim(); if (!t) return; setText(''); onSend(t) }
  return (
    <div className="chat">
      {allowAll && (
        <div className="warn top allall">⚠ この会話は<b>全許可中</b>です（削除・実行も確認なしで進みます）。
          <button onClick={onRevokeAll}>確認ありに戻す</button></div>
      )}
      <div className="msgs">
        {messages.length === 0 && <p className="muted pad">「ジャービス、今日の天気は？」のように話しかけるか、下に入力してください。</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="who">
              {m.role === 'user' ? 'あなた' : <>ジャービス <span className="badge">{PROVIDER_LABEL[m.provider] || m.provider}</span></>}
            </div>
            <div className="body">{m.content}</div>
            {m.role === 'assistant' && (
              <div className="acts">
                <button onClick={() => onSpeak(m.content)}>🔊 読み上げ</button>
                {m.task_id && <button onClick={() => onOpenTask(m.task_id)}>📋 ログ</button>}
              </div>
            )}
            {m.role === 'assistant' && m.task_id === pendingConfirm && (
              <div className="confirm">
                <button className="btn primary" onClick={() => onApprove(m.task_id, false)}>✅ 許可して実行（今回だけ）</button>
                <button className="btn danger" onClick={() => onDecline(m.task_id)}>🚫 やめる</button>
                <button className="btn ghost" onClick={() => onApprove(m.task_id, true)} title="この会話の間、確認なしで実行します">この会話は全部許可</button>
                <small className="muted">声で「はい」「やめて」「全部許可」でも答えられます</small>
              </div>
            )}
          </div>
        ))}
        {interim && <div className="msg user interim"><div className="body">{interim}</div></div>}
        {busy > 0 && <div className="msg assistant"><div className="body muted blink">考え中…（{busy}件実行中）</div></div>}
        <div ref={end} />
      </div>
      <div className="composer">
        <select value={provider} onChange={(e) => setProvider(e.target.value)} title="この発言を担当するAI（途中で切替OK・履歴は引き継ぎ）">
          {installed.map((p) => <option key={p.id} value={p.id}>{PROVIDER_LABEL[p.id] || p.label}</option>)}
        </select>
        <input className="model" list="model-options" value={model} onChange={(e) => setModel(e.target.value)}
          placeholder="モデル：既定" title="このAIで使うモデル。候補から選ぶか直接入力（空欄＝そのAIの既定）" />
        <datalist id="model-options">
          {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </datalist>
        <textarea rows="1" value={text} placeholder="メッセージを入力 (Enterで送信 / Shift+Enterで改行)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
        <button className={`mic ${listening ? 'on' : ''}`} onClick={onMic} title="押して話す">🎤</button>
        <button className="btn primary" onClick={submit}>送信</button>
      </div>
    </div>
  )
}
