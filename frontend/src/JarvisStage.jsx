import Orb from './Orb.jsx'

const LABEL = { idle: '待機中', listening: '聞いています', thinking: '考えています', speaking: '' }

// ハンズフリー中の専用画面：チャットではなく「ジャービスが話している」形で見せる。
// 中央に大きな球体、その下にジャービスの言葉(今読み上げている文を強調)、上に自分の発言。
export default function JarvisStage({ state, heard, interim, chunks, activeIdx, rest, thinkingFor, pendingConfirm, notice, error,
  onApprove, onDecline, onClose, onStop, micOn, provider }) {
  const speaking = state === 'speaking'
  return (
    <div className={`stage stage-${state}`}>
      <div className="stage-top">
        <span className="stage-prov">{provider}</span>
        <span className={`miclamp ${micOn ? 'on' : ''}`}>{micOn ? '● マイクON' : '○ マイク待機'}</span>
      </div>

      <div className="stage-center">
        <div className="stage-heard">
          {interim ? <span className="live">「{interim}」</span> : heard ? <span>あなた：「{heard}」</span> : <span className="hint">「ジャービス」と呼びかけてください</span>}
        </div>

        <Orb state={state} size={280} />
        <div className="stage-state">{LABEL[state] ?? ''}{state === 'thinking' && thinkingFor > 3 ? `（${thinkingFor}秒）` : ''}</div>

        <div className="stage-say" aria-live="polite">
          {chunks.length > 0 ? chunks.map((c, i) => (
            <span key={i} className={i === activeIdx ? 'now' : i < activeIdx ? 'past' : speaking ? 'next' : 'past'}>{c}</span>
          )) : null}
          {rest && <div className="stage-rest">{rest}</div>}
        </div>

        {pendingConfirm && (
          <div className="stage-confirm">
            <button className="btn primary big" onClick={() => onApprove(false)}>✅ 許可して実行</button>
            <button className="btn danger big" onClick={onDecline}>🚫 やめる</button>
            <small className="muted">「はい」「やめて」と声でも答えられます</small>
          </div>
        )}
      </div>

      <div className="stage-bottom">
        {notice && <div className="notice">{notice}</div>}
        {error && <div className="warn">{error}</div>}
        <div className="row end">
          <button className="btn ghost" onClick={onClose}>💬 チャット画面に切り替え</button>
          <button className="btn danger" onClick={onStop}>■ ハンズフリー終了</button>
        </div>
      </div>
    </div>
  )
}
