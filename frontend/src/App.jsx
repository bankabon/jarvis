import { useCallback, useEffect, useRef, useState } from 'react'
import { api, PROVIDER_LABEL } from './api.js'
import { Listener, MicGate, Speaker, isBye, matchWake, sttSupported, speakable, warmSpeech } from './voice.js'
import Orb from './Orb.jsx'
import Chat from './Chat.jsx'
import Tasks from './Tasks.jsx'
import Settings, { Setup } from './Settings.jsx'
import LivePanel from './LivePanel.jsx'
import JarvisStage from './JarvisStage.jsx'

const speaker = new Speaker()
const ACKS = ['はい、確認します。', '承知しました。取りかかります。', '承知しました。実行します。', 'はい。']
const gate = new MicGate()

export default function App() {
  const [settings, setSettings] = useState(null)
  const [info, setInfo] = useState(null)
  const [view, setView] = useState('chat')
  const [convs, setConvs] = useState([])
  const [archived, setArchived] = useState([])
  const [showArchive, setShowArchive] = useState(false)
  const [convId, setConvId] = useState(null)
  const [messages, setMessages] = useState([])
  const [provider, setProvider] = useState('')
  const [pending, setPending] = useState(0)
  const [runningTasks, setRunningTasks] = useState(0)
  const [selectedTask, setSelectedTask] = useState(null)
  const [liveTask, setLiveTask] = useState(null) // 右上のリアルタイム実行ログに出すタスク
  const [orb, setOrb] = useState('idle')
  const [interim, setInterim] = useState('')
  const [handsfree, setHandsfree] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [error, setError] = useState('')
  const [allowAll, setAllowAll] = useState(false)
  const [notice, setNotice] = useState('')
  const [stageOpen, setStageOpen] = useState(true)            // ハンズフリー中のジャービス専用画面を出すか
  const [stage, setStage] = useState({ heard: '', chunks: [], idx: -1, rest: '' })
  const [thinkSec, setThinkSec] = useState(0)
  const [speakerCount, setSpeakerCount] = useState(0) // 有効な登録済みの声の数
  const [modelSel, setModelSel] = useState({}) // 画面で選んだモデル {provider: model}

  // コールバックから最新状態を読むための ref
  const R = useRef({})
  const lastMsg = messages[messages.length - 1]
  const pendingConfirm = lastMsg && lastMsg.role === 'assistant' && lastMsg.task_status === 'confirm' ? lastMsg.task_id : null
  const curProvider = provider || settings?.default_provider || ''
  const curModel = modelSel[curProvider] ?? settings?.default_models?.[curProvider] ?? ''
  R.current = { settings, convId, provider, handsfree, pending, pendingConfirm, model: curModel, speakerCount }
  const followUntil = useRef(0)
  const listener = useRef(null)
  const lastMatchAt = useRef(0)
  const ackRef = useRef(Promise.resolve())   // 先出しの一言(「はい、確認します」)の再生待ち

  useEffect(() => {
    if (settings) gate.configure({ marginDb: settings.mic_margin_db, minDb: settings.mic_min_db })
  }, [settings])
  useEffect(() => {
    if (!pending) { setThinkSec(0); return }
    const t0 = Date.now()
    const i = setInterval(() => setThinkSec(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(i)
  }, [pending > 0])
  useEffect(() => { if (settings && handsfree) warmSpeech(ACKS, settings) }, [settings?.tts_engine, settings?.tts_voice, settings?.tts_rate, settings?.tts_pitch])
  const flash = (msg) => { setNotice(msg); clearTimeout(flash.t); flash.t = setTimeout(() => setNotice(''), 4500) }

  const refreshInfo = useCallback(() => api.providers().then(setInfo).catch((e) => setInfo({ bridge: false, error: e.message, providers: [] })), [])
  const refreshConvs = useCallback(() => {
    api.conversations().then(setConvs).catch(() => {})
    api.conversations(true).then(setArchived).catch(() => {})
  }, [])

  const [bootErr, setBootErr] = useState('')
  useEffect(() => {
    let dead = false
    // バックエンド起動待ちで失敗してもリトライし続ける
    const load = () => api.settings().then((s) => {
      if (dead) return
      setBootErr(''); setSettings(s); setProvider(s.default_provider)
      refreshInfo(); refreshConvs()
      api.speakerProfiles().then((r) => setSpeakerCount(r.profiles.filter((p) => p.enabled && p.n_samples > 0).length)).catch(() => {})
    }).catch((e) => { if (dead) return; setBootErr(e.message); setTimeout(load, 1500) })
    load()
    return () => { dead = true }
  }, [])

  // 実行中タスク数(サイドバーのバッジ)
  useEffect(() => {
    const t = setInterval(() => api.tasks().then((ts) => setRunningTasks(ts.filter((x) => x.status === 'running').length)).catch(() => {}), 2000)
    return () => clearInterval(t)
  }, [])

  const loadConv = useCallback(async (id) => {
    const c = await api.conversation(id)
    setMessages(c.messages)
    setAllowAll(!!c.allow_all)
    return c
  }, [])

  const openConv = async (id) => { setConvId(id); setView('chat'); await loadConv(id) }
  const newConv = async () => { const c = await api.newConversation(); setConvId(c.id); setMessages([]); setAllowAll(false); setView('chat'); refreshConvs(); return c.id }
  const archiveConv = async (e, id) => {
    e.stopPropagation()
    await api.archive(id)
    if (convId === id) { setConvId(null); setMessages([]) }
    refreshConvs()
  }
  const restoreConv = async (e, id) => { e.stopPropagation(); await api.unarchive(id); refreshConvs() }
  const delConv = async (e, id) => {
    e.stopPropagation()
    if (!confirm('この会話を削除しますか？')) return
    await api.deleteConversation(id)
    if (convId === id) { setConvId(null); setMessages([]) }
    refreshConvs()
  }

  // ---- 音声出力 ----
  // opts: {full: true なら全文を読む(確認・エラーなど重要な内容), ack: 先出しの一言}
  const say = useCallback(async (text, opts = {}) => {
    const s = R.current.settings
    if (!opts.ack) await ackRef.current                      // 先出しの一言を言い終えてから本題を話す
    const { spoken, rest } = opts.full || opts.ack ? speakable(text, 0) : speakable(text, s.speak_limit)
    listener.current?.pause(); gate.pause()
    setOrb('speaking')
    setStage((st) => ({ ...st, chunks: [], idx: -1, rest: opts.ack ? '' : rest }))
    try {
      await speaker.speak(spoken, s, {
        onStart: (chunks) => setStage((st) => ({ ...st, chunks })),
        onChunk: (i) => setStage((st) => ({ ...st, idx: i })),
      })
    } finally {
      followUntil.current = Date.now() + (s.followup_seconds || 45) * 1000
      gate.resume(); listener.current?.resume()
      setOrb(R.current.handsfree ? 'listening' : 'idle')
      setStage((st) => ({ ...st, idx: 999 }))               // 全部読み終えた表示(過去色)
    }
  }, [])

  const ACTION_RE = /作っ|作成|削除|消し|実行|変更|追加|直し|書い|開い|まとめ|調べ|探し|インストール|更新|移動|コピー|送っ|リネーム/
  const followTask = useCallback(async (cid, r, opts = {}) => {
    const s = R.current.settings
    setLiveTask(r.task_id) // 承認後の再実行(approve)もここを通るので自動で切り替わる
    setPending((n) => n + 1)
    setOrb('thinking')

    // 声で頼んで返事が遅い時は、先に一言返して待たせない（音声は事前キャッシュ済みなので即再生）
    let answered = false
    const ackTimer = (opts.voice && s.quick_ack && s.auto_speak) ? setTimeout(() => {
      if (answered) return
      const phrase = opts.approved ? '承知しました。実行します。' : ACTION_RE.test(opts.text || '') ? '承知しました。取りかかります。' : 'はい、確認します。'
      ackRef.current = say(phrase, { ack: true })
    }, 1100) : null

    await loadConv(cid)
    refreshConvs()
    let t
    try {
      do { await new Promise((ok) => setTimeout(ok, 300)); t = await api.task(r.task_id) } while (t.status === 'running')
    } finally { answered = true; clearTimeout(ackTimer); setPending((n) => Math.max(0, n - 1)) }
    if (R.current.convId === cid || !R.current.convId) await loadConv(cid)
    refreshConvs()
    // 確認待ち(confirm)の質問は重要なので全文を読み上げる
    if ((t.status === 'done' || t.status === 'confirm') && t.answer) {
      if (s.auto_speak) await say(t.answer, { full: t.status === 'confirm' }); else setOrb(R.current.handsfree ? 'listening' : 'idle')
    } else {
      setOrb(R.current.handsfree ? 'listening' : 'idle')
      if (t.status === 'error') {
        setError(`${PROVIDER_LABEL[r.provider] || r.provider} が失敗しました。「タスク」画面でログを確認できます (#${t.id})`)
        if (s.auto_speak && opts.voice) await say('うまくいきませんでした。画面を確認してください。', { full: true })
      }
    }
  }, [])

  const approve = useCallback(async (tid, all = false) => {
    try {
      setError('')
      const r = await api.approve(tid, all)
      await followTask(R.current.convId, r, { voice: R.current.handsfree, approved: true })
    } catch (e) { setOrb('idle'); setError(e.message) }
  }, [])

  const decline = useCallback(async (tid) => {
    try {
      await api.decline(tid)
      await loadConv(R.current.convId)
      speaker.stop(); await say('承知しました。実行しません。')
    } catch (e) { setError(e.message) }
  }, [])

  const revokeAll = async () => { await api.setAllowAll(R.current.convId, false); setAllowAll(false) }

  // ---- ユーザー発言(文字・音声共通) ----
  const YES = /^(はい|うん|ええ|お願い|おねがい|許可|実行|やって|いいよ|オーケー|ok|大丈夫)/i
  const NO = /^(いいえ|だめ|ダメ|やめ|キャンセル|中止|待って|実行しないで|やらないで)/
  const ALL = /(全部|全て|すべて|ぜんぶ).{0,6}(許可|オーケー|ok)|全許可/i
  const sendText = useCallback(async (text, opts = {}) => {
    const s = R.current.settings
    setStage((st) => ({ ...st, heard: text, chunks: [], idx: -1, rest: '' }))
    let cid = R.current.convId
    const pc = R.current.pendingConfirm
    try {
      setError('')
      if (pc) { // 確認待ち中の返事は、ここで許可/却下として扱う(AIには渡さない)
        const t = text.trim()
        if (ALL.test(t)) { setAllowAll(true); return approve(pc, true) }
        if (NO.test(t)) return decline(pc)
        if (YES.test(t)) return approve(pc, false)
        // それ以外は新しい依頼として扱い、保留中の操作は実行されないまま残る
      }
      if (!cid) cid = await newConv()
      const prov = R.current.provider || s.default_provider
      const r = await api.send(cid, text, prov, R.current.model)
      if (ALL.test(text) && !/しない|しません|ないで|やめ|取り消|解除|戻/.test(text)) setAllowAll(true)
      await followTask(cid, r, { voice: !!opts.voice, text })
    } catch (e) {
      setOrb('idle')
      setError(e.message)
    }
  }, [])

  // ---- 音声入力 ----
  const stopHandsfree = useCallback(() => { listener.current?.stop(); gate.stop(); setHandsfree(false); setOrb('idle') }, [])

  useEffect(() => {
    listener.current = new Listener({
      onInterim: (t) => { const s = R.current.settings; setInterim(!s.mic_gate || !gate.active || gate.heardRecently(2500) ? t : '') },
      onState: (st) => setMicOn(st === 'on'),
      onError: setError,
      onFinal: async (raw, conf) => {
        setInterim('')
        let text = raw
        const { settings: s, handsfree: hf } = R.current
        if (!text) return
        // 周囲より十分大きい声でなければ無視(音楽・テレビ・遠い話し声対策)
        if (s.mic_gate && gate.active && !gate.heardRecently(4500)) { flash(`声が小さい/遠いので無視しました: 「${text.slice(0, 24)}」`); return }
        if (s.mic_min_conf > 0 && conf > 0 && conf < s.mic_min_conf) { flash(`聞き取りの確信度が低いので無視しました: 「${text.slice(0, 24)}」`); return }
        // Whisperで文字起こしし直す(失敗・未準備ならブラウザの認識結果をそのまま使う)
        let seg = null
        if (s.stt_engine !== 'browser' && gate.active) {
          seg = gate.segment()
          if (seg) {
            const w = await api.stt(seg).catch(() => null)
            if (w && typeof w.text === 'string') {
              if (!w.text.trim()) { flash(`Whisperで聞き取れなかったので無視しました: 「${text.slice(0, 24)}」`); return }
              text = w.text.trim()
            }
          }
        }
        if (hf && isBye(text)) { stopHandsfree(); say('はい、またお呼びください。'); return }
        if (hf && s.wake_enabled) {
          const m = matchWake(text, s.wake_word)
          if (!m.hit && Date.now() > followUntil.current) return // 呼ばれていない
          text = m.rest
          if (!text) { followUntil.current = Date.now() + (s.followup_seconds || 45) * 1000; say('はい。'); return }
        }
        // 声紋照合：登録した声の持ち主か(音楽の歌声・テレビ・他の人を除外)
        const checkSpeaker = s.speaker_verify && R.current.speakerCount > 0 && gate.active && (hf || s.speaker_check_push)
        if (checkSpeaker) {
          const vseg = seg ?? gate.segment() // Whisperで取り出し済みなら同じ区間を再利用
          const r = vseg ? await api.speakerVerify(vseg).catch(() => null) : null // 照合に失敗したら通す(フェイルオープン)
          if (r?.match === true) lastMatchAt.current = Date.now()
          else if (r?.match === false) { flash(`登録した声と違うので無視しました（類似度 ${r.score} / 必要 ${r.threshold}）: 「${text.slice(0, 16)}」`); return }
          else if (r?.match === null && Date.now() - lastMatchAt.current > 60000) { flash('発話が短くて声を確認できないので無視しました（直近1分以内に本人確認できた時のみ短い返事を受け付けます）'); return }
        }
        sendText(text, { voice: true })
      },
    })
    return () => listener.current?.stop()
  }, [])

  const startGate = () => { if (R.current.settings.mic_gate) gate.start() }
  const pushToTalk = () => {
    if (micOn) { listener.current.stop(); if (!R.current.handsfree) gate.stop(); setOrb('idle'); return }
    speaker.stop(); setOrb('listening'); startGate(); listener.current.start(false)
  }
  const toggleHandsfree = () => {
    if (handsfree) return stopHandsfree()
    speaker.stop(); setHandsfree(true); setStageOpen(true); setOrb('listening'); startGate(); listener.current.start(true)
    warmSpeech(ACKS, R.current.settings)
  }

  if (!settings) return (
    <div className="boot">
      <div style={{ textAlign: 'center' }}>
        <Orb state="thinking" size={120} />
        <div>JARVIS 起動中…</div>
        {bootErr && <small className="muted">バックエンドに接続できません。再試行中… ({bootErr})<br />止まる場合は ./start.sh を実行し直してください</small>}
      </div>
    </div>
  )

  const installed = (info?.providers || []).filter((p) => p.installed)
  const orbState = pending > 0 && orb !== 'speaking' ? 'thinking' : orb

  return (
    <div className="app">
      {!settings.setup_done && (
        <Setup info={info} settings={settings} refreshInfo={refreshInfo}
          onDone={() => api.settings().then((s) => { setSettings(s); setProvider(s.default_provider) })} />
      )}

      <aside className="side">
        <div className="brand"><Orb state={orbState} size={96} /><h1>JARVIS</h1><small>ジャービス</small></div>
        <nav>
          <button className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')}>💬 会話</button>
          <button className={view === 'tasks' ? 'on' : ''} onClick={() => setView('tasks')}>📋 タスクログ{runningTasks > 0 && <span className="count">{runningTasks}</span>}</button>
          <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}>⚙️ 設定</button>
        </nav>
        <div className="convhead"><span>会話履歴</span><button onClick={newConv} title="新しい会話">＋</button></div>
        <div className="convlist">
          {convs.map((c) => (
            <div key={c.id} className={`conv ${convId === c.id ? 'sel' : ''}`} onClick={() => openConv(c.id)}>
              <div className="ttl">{c.title}</div>
              <div className="muted">{(c.providers || '').split(',').filter(Boolean).map((p) => PROVIDER_LABEL[p] || p).join(' → ') || '—'}
                <span>
                  <button className="x" onClick={(e) => archiveConv(e, c.id)} title="アーカイブ（半年後に自動削除）">📦</button>
                  <button className="x" onClick={(e) => delConv(e, c.id)} title="今すぐ削除">×</button>
                </span></div>
            </div>
          ))}
        </div>
        <div className="archive">
          <button className="convhead archbtn" onClick={() => setShowArchive((v) => !v)}>
            <span>📦 アーカイブ ({archived.length})</span><span>{showArchive ? '▲' : '▼'}</span>
          </button>
          {showArchive && (
            <div className="convlist arch">
              {archived.length === 0 && <small className="muted">アーカイブした会話はありません</small>}
              {archived.map((c) => (
                <div key={c.id} className={`conv ${convId === c.id ? 'sel' : ''}`} onClick={() => openConv(c.id)}>
                  <div className="ttl">{c.title}</div>
                  <div className="muted">あと{c.days_left}日で自動削除
                    <span>
                      <button className="x" onClick={(e) => restoreConv(e, c.id)} title="元に戻す">↩</button>
                      <button className="x" onClick={(e) => delConv(e, c.id)} title="今すぐ削除">×</button>
                    </span></div>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className={`btn hf ${handsfree ? 'on' : ''}`} onClick={toggleHandsfree} disabled={!sttSupported}>
          {handsfree ? '🎙 ハンズフリー中（停止）' : '🎙 ハンズフリー開始'}
        </button>
        {handsfree && !stageOpen && settings.stage_enabled && <button className="btn" onClick={() => setStageOpen(true)}>🖥 ジャービス画面に戻る</button>}
        {!sttSupported && <small className="muted">音声入力は Chrome / Edge / Safari で利用できます</small>}
      </aside>

      <main className="main">
        {info && !info.bridge && settings.setup_done && (
          <div className="warn top">ホストの bridge に接続できません。<code>./start.sh</code> を実行してください。 <button onClick={refreshInfo}>再確認</button></div>
        )}
        {notice && <div className="notice">{notice}</div>}
        {error && <div className="warn top">{error} <button onClick={() => setError('')}>×</button></div>}

        {view === 'chat' && (
          <Chat messages={messages} interim={interim} installed={installed} provider={provider || settings.default_provider}
            setProvider={setProvider} onSend={sendText} busy={pending} listening={micOn && !handsfree}
            onMic={pushToTalk} onSpeak={(t) => say(t)}
            pendingConfirm={pendingConfirm} onApprove={approve} onDecline={decline}
            allowAll={allowAll} onRevokeAll={revokeAll}
            model={curModel} setModel={(m) => setModelSel((o) => ({ ...o, [curProvider]: m }))}
            modelOptions={(info?.providers || []).find((p) => p.id === curProvider)?.models || []}
            onOpenTask={(id) => { setSelectedTask(id); setView('tasks') }} />
        )}
        {view === 'tasks' && <Tasks selected={selectedTask} setSelected={setSelectedTask} />}
        {view === 'settings' && (
          <Settings info={info} settings={settings} refreshInfo={refreshInfo}
            onSaved={(s) => { setSettings(s) }} onProfilesChanged={setSpeakerCount} />
        )}
      </main>

      {handsfree && stageOpen && settings.stage_enabled && (
        <JarvisStage state={orbState} heard={stage.heard} interim={interim} chunks={stage.chunks} activeIdx={stage.idx} rest={stage.rest}
          thinkingFor={thinkSec} pendingConfirm={pendingConfirm} notice={notice} error={error} micOn={micOn}
          provider={`${PROVIDER_LABEL[curProvider] || curProvider}${curModel ? ' / ' + curModel : ''}`}
          onApprove={(all) => approve(pendingConfirm, all)} onDecline={() => decline(pendingConfirm)}
          onClose={() => setStageOpen(false)} onStop={stopHandsfree} />
      )}

      {/* タスク画面では同じログが全面に出るので二重表示しない */}
      {liveTask && view !== 'tasks' && (
        <LivePanel taskId={liveTask}
          onOpenTask={(id) => { setSelectedTask(id); setView('tasks') }}
          onClose={() => setLiveTask(null)} />
      )}
    </div>
  )
}
