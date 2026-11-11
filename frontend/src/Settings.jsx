import { useEffect, useRef, useState } from 'react'
import { api, PROVIDER_LABEL } from './api.js'
import { MicGate, Speaker, browserVoices } from './voice.js'

const speaker = new Speaker()

export function AiPicker({ info, value, onChange }) {
  if (!info) return <p className="muted">AIの状態を確認中…</p>
  return (
    <div>
      {!info.bridge && (
        <div className="warn">
          ホストの bridge に接続できません。<code>./start.sh</code> で起動しているか確認してください。<br />
          <small>{info.error}</small>
        </div>
      )}
      {info.bridge && info.providers.map((p) => (
        <label key={p.id} className={`choice ${value === p.id ? 'sel' : ''} ${p.installed ? '' : 'off'}`}>
          <input type="radio" name="prov" disabled={!p.installed} checked={value === p.id} onChange={() => onChange(p.id)} />
          <span className="grow">
            <b>{PROVIDER_LABEL[p.id] || p.label}</b>
            <small>{p.installed ? ` ${p.version || ''}` : ' ― このPCに未インストール'}</small>
          </span>
          {p.installed ? <span className="badge ok">利用可</span> : <span className="badge">未導入</span>}
        </label>
      ))}
    </div>
  )
}

export function VoicePicker({ draft, setDraft }) {
  const [voices, setVoices] = useState(null)
  const [bvoices, setBvoices] = useState(browserVoices())
  const [testing, setTesting] = useState(false)

  useEffect(() => { api.voices().then(setVoices).catch(() => setVoices({ edge: [], aivis: [] })) }, [])
  useEffect(() => {
    const f = () => setBvoices(browserVoices())
    window.speechSynthesis?.addEventListener?.('voiceschanged', f)
    return () => window.speechSynthesis?.removeEventListener?.('voiceschanged', f)
  }, [])

  const set = (k, v) => setDraft({ ...draft, [k]: v })
  const setEngine = (e) => {
    const first = voices?.[e]?.[0]?.id || ''
    setDraft({ ...draft, tts_engine: e, tts_voice: first || draft.tts_voice })
  }
  const list = draft.tts_engine === 'browser' ? null : voices?.[draft.tts_engine]

  const test = async () => {
    setTesting(true)
    await speaker.speak('こんにちは。ジャービスです。本日もよろしくお願いいたします。', draft)
    setTesting(false)
  }

  return (
    <div className="form">
      <div className="seg">
        {[['edge', 'edge-tts（流暢な日本語）'], ['voicevox', 'VOICEVOX'], ['aivis', 'AivisSpeech'], ['browser', 'ブラウザ/OS標準']].map(([id, label]) => (
          <button key={id} className={draft.tts_engine === id ? 'on' : ''} onClick={() => setEngine(id)}>{label}</button>
        ))}
      </div>

      {draft.tts_engine === 'browser' ? (
        <label>音声
          <select value={draft.browser_voice} onChange={(e) => set('browser_voice', e.target.value)}>
            <option value="">自動（日本語）</option>
            {bvoices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        </label>
      ) : (
        <label>声
          <select value={draft.tts_voice} onChange={(e) => set('tts_voice', e.target.value)}>
            {(list || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      )}
      {['voicevox', 'aivis'].includes(draft.tts_engine) && (
        <>
          {voices?.[draft.tts_engine + '_error'] && (
            <div className="warn">{voices[draft.tts_engine + '_error']}<br />
              <small>{draft.tts_engine === 'voicevox'
                ? '初回はエンジンのイメージ取得に数分かかります。./start.sh で起動中か、docker compose ps で voicevox を確認してください。PCにVOICEVOXアプリを入れた場合は、URLを http://host.docker.internal:50021 にしてください。'
                : 'AivisSpeech を起動してください（既定ポート10101）。'}</small>
            </div>
          )}
          <label>エンジンURL
            <input value={draft[draft.tts_engine + '_url']} onChange={(e) => set(draft.tts_engine + '_url', e.target.value)} />
            <small className="muted">変更後は保存してから声一覧を開き直してください</small>
          </label>
          {draft.tts_engine === 'voicevox' && <small className="muted">VOICEVOXの音声を公開・配信する場合は「VOICEVOX:キャラクター名」のクレジット表記が必要です。</small>}
        </>
      )}

      <label>速さ {draft.tts_rate > 0 ? '+' : ''}{draft.tts_rate}%
        <input type="range" min="-40" max="40" value={draft.tts_rate} onChange={(e) => set('tts_rate', +e.target.value)} />
      </label>
      {['edge', 'voicevox'].includes(draft.tts_engine) && (
        <label>高さ {draft.tts_pitch > 0 ? '+' : ''}{draft.tts_pitch}Hz
          <input type="range" min="-30" max="30" value={draft.tts_pitch} onChange={(e) => set('tts_pitch', +e.target.value)} />
        </label>
      )}
      <button className="btn" onClick={test} disabled={testing}>{testing ? '再生中…' : '▶ 声をテスト'}</button>
    </div>
  )
}

// マイク感度：リアルタイムメーター。灰=周囲音(学習値) 緑=声 線=しきい値
export function MicMeter({ draft, set }) {
  const [on, setOn] = useState(false)
  const [st, setSt] = useState({ level: -100, floor: -90, threshold: -55, loud: false })
  const gate = useRef(null)
  if (!gate.current) gate.current = new MicGate()
  useEffect(() => { gate.current.configure({ marginDb: draft.mic_margin_db, minDb: draft.mic_min_db }) }, [draft.mic_margin_db, draft.mic_min_db])
  useEffect(() => () => gate.current.stop(), [])
  const toggle = async () => {
    if (on) { gate.current.stop(); setOn(false); return }
    gate.current.onLevel = setSt
    const ok = await gate.current.start()
    if (!ok) alert('マイクを使えませんでした。ブラウザのマイク許可を確認してください')
    setOn(ok)
  }
  const pct = (db) => `${Math.max(0, Math.min(100, ((db + 90) / 90) * 100))}%`
  return (
    <div className="form">
      <label className="check"><input type="checkbox" checked={draft.mic_gate} onChange={(e) => set('mic_gate', e.target.checked)} />
        周囲より大きい声だけ採用する（音楽・テレビ・遠い話し声を無視）</label>
      <label>声を拾う厳しさ：周囲より <b>{draft.mic_margin_db}dB</b> 以上大きい声だけ
        <input type="range" min="3" max="30" value={draft.mic_margin_db} onChange={(e) => set('mic_margin_db', +e.target.value)} />
        <small className="muted">右ほど荒い（近くで大きめに話した声だけ反応）。左ほど敏感。音楽を流す時は 15〜20 がおすすめ</small>
      </label>
      <label>これより小さい音は常に無視：<b>{draft.mic_min_db}dB</b>
        <input type="range" min="-80" max="-30" value={draft.mic_min_db} onChange={(e) => set('mic_min_db', +e.target.value)} />
      </label>
      <label>聞き取り確信度の下限：<b>{draft.mic_min_conf}</b>
        <input type="range" min="0" max="0.9" step="0.05" value={draft.mic_min_conf} onChange={(e) => set('mic_min_conf', +e.target.value)} />
        <small className="muted">低い確信度（歌詞などの聞き間違い）を捨てます。0で無効</small>
      </label>
      <button className="btn" onClick={toggle}>{on ? '■ メーター停止' : '🎤 メーターでテスト（音楽を流しながら調整）'}</button>
      {on && (
        <div className="meter" title="灰=周囲音 / 緑=現在の音量 / 赤線=しきい値">
          <div className="bar floor" style={{ width: pct(st.floor) }} />
          <div className={`bar lvl ${st.loud ? 'loud' : ''}`} style={{ width: pct(st.level) }} />
          <div className="thr" style={{ left: pct(st.threshold) }} />
          <span className="mt">{st.loud ? '🟢 声として認識' : '⚪ 無視'}　現在 {Math.round(st.level)}dB / 周囲 {Math.round(st.floor)}dB / しきい値 {Math.round(st.threshold)}dB</span>
        </div>
      )}
    </div>
  )
}

const ENROLL_TEXTS = [
  '今日はいい天気ですね。散歩に行きたいです。',
  'ジャービス、明日の予定を教えてください。',
  'この資料をまとめて、要点だけ読み上げてください。',
  '新しいファイルを作って、中身は確認用のテキストにしてください。',
  '音楽を流しながらでも、私の声だけを聞き取ってください。',
]

// 声の登録(話者認証)：登録した声の持ち主だけを採用する
export function SpeakerSection({ draft, set, onChanged }) {
  const [info, setInfo] = useState(null)
  const [name, setName] = useState('')
  const [enroll, setEnroll] = useState(null) // {pid,name,idx,state:'ready'|'rec'|'send',msg,secs}
  const [test, setTest] = useState(null)
  const [lvl, setLvl] = useState(-100)
  const gate = useRef(null)
  const timer = useRef(null)
  if (!gate.current) gate.current = new MicGate()
  useEffect(() => () => { clearInterval(timer.current); gate.current.stop() }, [])

  const load = () => api.speakerProfiles().then((r) => { setInfo(r); onChanged?.(r.profiles.filter((p) => p.enabled && p.n_samples > 0).length) }).catch(() => {})
  useEffect(() => { load() }, [])

  const ensureMic = async () => {
    gate.current.onLevel = (s) => setLvl(s.level)
    const ok = await gate.current.start()
    if (!ok) alert('マイクを使えませんでした。ブラウザのマイク許可を確認してください')
    return ok
  }
  // maxSec 秒録る。stopFn() が呼ばれたら早めに終了
  const record = (maxSec, onTick) => new Promise((resolve) => {
    const from = gate.current.mark(); const t0 = Date.now()
    const stop = () => { clearInterval(timer.current); resolve(gate.current.grab(from, gate.current.mark(), maxSec + 1)) }
    gate.current.stopRec = stop
    timer.current = setInterval(() => {
      const s = (Date.now() - t0) / 1000; onTick(s)
      if (s >= maxSec) stop()
    }, 100)
  })

  const startEnroll = async (pid, pname, from = 0) => {
    if (!(await ensureMic())) return
    setEnroll({ pid, name: pname, idx: from, state: 'ready', msg: '', secs: 0, done: 0 })
  }
  const createAndEnroll = async () => {
    if (!name.trim()) return
    const r = await api.speakerCreate(name.trim()); setName(''); await load()
    startEnroll(r.id, r.name)
  }
  const recOne = async () => {
    setEnroll((e) => ({ ...e, state: 'rec', msg: '', secs: 0 }))
    const pcm = await record(9, (s) => setEnroll((e) => e && ({ ...e, secs: s })))
    setEnroll((e) => ({ ...e, state: 'send', msg: 'アップロード中…' }))
    try {
      const r = await api.speakerAddSample(enroll.pid, pcm)
      const q = r.consistency == null ? '' : `（これまでの声との一貫性 ${r.consistency.toFixed(2)}）`
      setEnroll((e) => ({ ...e, state: 'ready', idx: e.idx + 1, done: r.n_samples, msg: `✅ ${r.seconds}秒 登録しました ${q}` }))
      load()
    } catch (err) {
      setEnroll((e) => ({ ...e, state: 'ready', msg: `⚠ ${err.message}` }))
    }
  }
  const finish = () => { gate.current.stop(); setEnroll(null); load() }

  const runTest = async () => {
    if (!(await ensureMic())) return
    setTest({ state: 'rec', secs: 0 })
    const pcm = await record(5, (s) => setTest({ state: 'rec', secs: s }))
    setTest({ state: 'send' })
    try { setTest({ state: 'done', ...(await api.speakerVerify(pcm)) }) } catch (e) { setTest({ state: 'err', msg: e.message }) }
    gate.current.stop()
  }

  const del = async (p) => { if (confirm(`「${p.name}」の声の登録を削除しますか？`)) { await api.speakerDelete(p.id); load() } }
  const have = info?.profiles?.some((p) => p.n_samples > 0)
  const done = enroll?.idx >= ENROLL_TEXTS.length

  return (
    <div className="form">
      <p className="muted">声を登録すると、ハンズフリー中は<b>登録した声の持ち主の発話だけ</b>を採用します（音楽の歌声・テレビ・家族の声を無視）。
        声紋データはこのPCのDBにだけ保存され、外部には送られません。🎤ボタンで押して話す時は、既定では照合しません（声が出にくい時の保険）。</p>
      {info && !info.model_ready && <div className="warn">声紋モデルが見つかりません。./start.sh でイメージを再ビルドしてください。</div>}

      {(info?.profiles || []).map((p) => (
        <div key={p.id} className="choice">
          <label className="check grow"><input type="checkbox" checked={p.enabled} onChange={async (e) => { await api.speakerEnable(p.id, e.target.checked); load() }} />
            <b>{p.name}</b> <small className="muted">登録サンプル {p.n_samples}件{p.n_samples < 3 ? '（3件以上を推奨）' : ''}</small></label>
          <button className="btn ghost" onClick={() => startEnroll(p.id, p.name, 0)}>追加で録音</button>
          <button className="btn ghost" onClick={async () => { await api.speakerReset(p.id); load() }}>登録し直す</button>
          <button className="btn danger" onClick={() => del(p)}>削除</button>
        </div>
      ))}

      {!enroll && (
        <div className="row">
          <input placeholder="登録する人の名前（例：自分）" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" disabled={!name.trim() || !info?.model_ready} onClick={createAndEnroll}>＋ 声を登録する</button>
        </div>
      )}

      {enroll && (
        <div className="enroll">
          <b>「{enroll.name}」の声を登録（{Math.min(enroll.idx, ENROLL_TEXTS.length)}/{ENROLL_TEXTS.length}）</b>
          <small className="muted">普段使うマイク・距離で、静かな場所で、いつもの声で読んでください。3件以上で使えます。</small>
          {!done ? (
            <>
              <div className="prompt">「{ENROLL_TEXTS[enroll.idx]}」</div>
              <div className="meterbar"><div style={{ width: `${Math.max(0, Math.min(100, ((lvl + 80) / 80) * 100))}%` }} /></div>
              <div className="row">
                {enroll.state === 'ready' && <button className="btn primary" onClick={recOne}>● 録音して読む（最大9秒）</button>}
                {enroll.state === 'rec' && <button className="btn danger" onClick={() => gate.current.stopRec?.()}>■ 読み終わった（{enroll.secs.toFixed(1)}秒）</button>}
                {enroll.state === 'send' && <span className="muted">処理中…</span>}
                {enroll.state === 'ready' && enroll.done >= 3 && <button className="btn" onClick={finish}>登録を完了する</button>}
                {enroll.state === 'ready' && enroll.done < 3 && <button className="btn ghost" onClick={finish}>中断</button>}
              </div>
            </>
          ) : <div className="ok">✅ 全て録音しました。</div>}
          {enroll.msg && <div className={enroll.msg.startsWith('⚠') ? 'warn' : 'ok'}>{enroll.msg}</div>}
          {done && <button className="btn primary" onClick={finish}>登録を完了する</button>}
        </div>
      )}

      <label className="check"><input type="checkbox" checked={draft.speaker_verify} onChange={(e) => set('speaker_verify', e.target.checked)} />
        登録した声の人だけ採用する（ハンズフリー時）</label>
      <label className="check"><input type="checkbox" checked={draft.speaker_check_push} onChange={(e) => set('speaker_check_push', e.target.checked)} />
        🎤の押して話す時も声を照合する</label>
      <label>本人とみなす類似度：<b>{draft.speaker_threshold.toFixed(2)}</b>以上
        <input type="range" min="0.3" max="0.9" step="0.01" value={draft.speaker_threshold} onChange={(e) => set('speaker_threshold', +e.target.value)} />
        <small className="muted">高いほど厳しい（他人は通らないが、自分の声が弾かれやすい）。下の「照合テスト」で自分と他の人の点数を見て決めてください</small>
      </label>
      <div className="row">
        <button className="btn" disabled={!have || test?.state === 'rec'} onClick={runTest}>🎤 照合テスト（5秒話す）</button>
        {test?.state === 'rec' && <><span className="muted">録音中 {test.secs.toFixed(1)}秒…</span><button className="btn danger" onClick={() => gate.current.stopRec?.()}>■</button></>}
        {test?.state === 'send' && <span className="muted">照合中…</span>}
        {test?.state === 'err' && <span className="warn">{test.msg}</span>}
        {test?.state === 'done' && (test.match === null
          ? <span className="warn">短すぎて判定できません（{test.seconds}秒）。もう少し話してください</span>
          : <span className={test.match ? 'ok' : 'warn'}>{test.match ? '✅ 本人' : '🚫 別人と判定'}　類似度 <b>{test.score}</b>（必要 {test.threshold}）{test.who && ` / 最も近い登録: ${test.who}`}</span>)}
      </div>
    </div>
  )
}

export function Setup({ info, settings, onDone, refreshInfo }) {
  const firstInstalled = info?.providers?.find((p) => p.installed)?.id || ''
  const [draft, setDraft] = useState({ ...settings, default_provider: settings.default_provider || firstInstalled })
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (!draft.default_provider && firstInstalled) setDraft((d) => ({ ...d, default_provider: firstInstalled }))
  }, [firstInstalled])

  const finish = async () => { await api.saveSettings({ ...draft, setup_done: true }); onDone() }
  return (
    <div className="overlay">
      <div className="modal">
        <h1>JARVIS 初期設定</h1>
        <div className="steps">{['① 使うAI', '② 読み上げの声'].map((t, i) => <span key={t} className={i === step ? 'on' : ''}>{t}</span>)}</div>
        {step === 0 && (
          <>
            <p className="muted">普段使うAIを選んでください。会話ごとに、いつでも画面上で切り替えられます（履歴は引き継がれます）。</p>
            <AiPicker info={info} value={draft.default_provider} onChange={(v) => setDraft({ ...draft, default_provider: v })} />
            <div className="row end">
              <button className="btn ghost" onClick={refreshInfo}>再確認</button>
              <button className="btn primary" disabled={!draft.default_provider} onClick={() => setStep(1)}>次へ</button>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <p className="muted">日本語を流暢に話す声を選べます。初期値は自然な女性の声(Nanami)です。</p>
            <VoicePicker draft={draft} setDraft={setDraft} />
            <div className="row end">
              <button className="btn ghost" onClick={() => setStep(0)}>戻る</button>
              <button className="btn primary" onClick={finish}>はじめる</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function Settings({ info, settings, onSaved, refreshInfo, onProfilesChanged }) {
  const [draft, setDraft] = useState(settings)
  const [saved, setSaved] = useState(false)
  const set = (k, v) => setDraft({ ...draft, [k]: v })
  const save = async () => { onSaved(await api.saveSettings(draft)); setSaved(true); setTimeout(() => setSaved(false), 1500) }

  return (
    <div className="page">
      <h2>設定</h2>
      <section>
        <h3>既定のAI</h3>
        <AiPicker info={info} value={draft.default_provider} onChange={(v) => set('default_provider', v)} />
        <button className="btn ghost" onClick={refreshInfo}>AIの状態を再確認</button>
        <h3>既定のモデル</h3>
        <p className="muted">空欄＝各AIの既定。会話画面の入力欄でも一時的に変更できます。</p>
        {(info?.providers || []).filter((p) => p.installed).map((p) => (
          <label key={p.id}>{PROVIDER_LABEL[p.id] || p.label}
            <input list={`dm-${p.id}`} value={draft.default_models?.[p.id] || ''} placeholder="既定"
              onChange={(e) => set('default_models', { ...(draft.default_models || {}), [p.id]: e.target.value })} />
            <datalist id={`dm-${p.id}`}>{(p.models || []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
          </label>
        ))}
        <label className="check">
          <span>実行権限</span>
          <select value={draft.permission_mode} onChange={(e) => set('permission_mode', e.target.value)}>
            <option value="confirm">標準：作成・編集は自動／削除・コマンド実行は毎回確認</option>
            <option value="safe">読み取りのみ（何も変更しない）</option>
            <option value="full" disabled={!info?.allow_full}>常に全許可（非推奨）{info?.allow_full ? '' : ' ― bridge で BRIDGE_ALLOW_FULL=1 が必要'}</option>
          </select>
        </label>
        <p className="muted">会話中に「全部許可」と話しかけると、その会話だけ確認なしになります（「許可を戻して」で解除）。</p>
        {info?.workdir && <p className="muted">AIの作業フォルダ: <code>{info.workdir}</code></p>}
      </section>
      <section>
        <h3>声（読み上げ）</h3>
        <VoicePicker draft={draft} setDraft={setDraft} />
        <label className="check"><input type="checkbox" checked={draft.auto_speak} onChange={(e) => set('auto_speak', e.target.checked)} /> 回答を自動で読み上げる</label>
        <label>読み上げる最大文字数：<b>{draft.speak_limit === 0 ? '全文' : draft.speak_limit + '文字'}</b>
          <input type="range" min="0" max="400" step="20" value={draft.speak_limit} onChange={(e) => set('speak_limit', +e.target.value)} />
          <small className="muted">超えた分は読み上げず画面に表示します（確認・エラーなど重要な内容は常に全文）。0で全文</small>
        </label>
        <label className="check"><input type="checkbox" checked={draft.quick_ack} onChange={(e) => set('quick_ack', e.target.checked)} /> 声で頼んで返事が遅い時は、先に「はい、確認します」と一言返す</label>
        <label className="check"><input type="checkbox" checked={draft.stage_enabled} onChange={(e) => set('stage_enabled', e.target.checked)} /> ハンズフリー中は「ジャービスが話している」専用画面にする</label>
      </section>
      <section>
        <h3>マイク感度（周囲の音の除外）</h3>
        <MicMeter draft={draft} set={set} />
      </section>
      <section>
        <h3>声の登録（話者認証）</h3>
        <SpeakerSection draft={draft} set={set} onChanged={onProfilesChanged} />
      </section>
      <section>
        <h3>ウェイクワード（ハンズフリー時）</h3>
        <label className="check"><input type="checkbox" checked={draft.wake_enabled} onChange={(e) => set('wake_enabled', e.target.checked)} /> 呼びかけた時だけ反応する</label>
        <label>呼び名 <input value={draft.wake_word} onChange={(e) => set('wake_word', e.target.value)} /></label>
        <label>呼びかけ不要で続けて話せる秒数 <input type="number" min="5" max="600" value={draft.followup_seconds} onChange={(e) => set('followup_seconds', +e.target.value)} /></label>
      </section>
      <section>
        <h3>人格 (persona) と履歴</h3>
        <textarea rows="5" value={draft.persona} onChange={(e) => set('persona', e.target.value)} />
        <label>アーカイブした会話を自動削除するまでの日数（180日＝約半年）
          <input type="number" min="7" max="1095" value={draft.archive_retention_days} onChange={(e) => set('archive_retention_days', +e.target.value)} />
        </label>
        <label>AIに引き継ぐ直近の発言数 <input type="number" min="0" max="100" value={draft.history_limit} onChange={(e) => set('history_limit', +e.target.value)} /></label>
      </section>
      <div className="row"><button className="btn primary" onClick={save}>保存</button>{saved && <span className="ok">保存しました</span>}</div>
    </div>
  )
}
