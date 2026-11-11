// 音声入出力。STT=ブラウザのWeb Speech API / TTS=backend(edge-tts, Aivis) → 失敗時はブラウザ標準音声

const SR = window.SpeechRecognition || window.webkitSpeechRecognition
export const sttSupported = !!SR

// ---------------- TTS ----------------
export function splitSentences(text) {
  const t = text.replace(/\s+/g, ' ').trim()
  const parts = t.match(/[^。！？!?\n]+[。！？!?]?/g) || [t]
  // 短い文は結合して合成回数を減らす
  const out = []
  let buf = ''
  for (const p of parts) {
    if ((buf + p).length > 80 && buf) { out.push(buf); buf = p } else buf += p
  }
  if (buf) out.push(buf)
  return out.filter((s) => s.trim())
}

export function browserVoices() {
  return (window.speechSynthesis?.getVoices() || []).filter((v) => v.lang?.toLowerCase().startsWith('ja'))
}

function speakBrowser(text, s, signal) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if (!synth) return resolve()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ja-JP'
    const v = browserVoices().find((x) => x.name === s.browser_voice) || browserVoices()[0]
    if (v) u.voice = v
    u.rate = 1 + (s.tts_rate || 0) / 100
    u.onend = u.onerror = () => resolve()
    signal.addEventListener('abort', () => { synth.cancel(); resolve() })
    synth.speak(u)
  })
}

// 短い定型句(「はい、確認します」等)は音声をキャッシュして、再生までの待ちをゼロにする
const audioCache = new Map()
const ckey = (s, t) => `${s.engine}|${s.voice}|${s.rate}|${s.pitch}|${t}`
export function speechOpts(settings, over = {}) {
  return {
    engine: settings.tts_engine, voice: settings.tts_voice, rate: settings.tts_rate, pitch: settings.tts_pitch,
    browser_voice: settings.browser_voice, tts_rate: settings.tts_rate, ...over,
  }
}
export async function warmSpeech(texts, settings) {
  const s = speechOpts(settings)
  if (s.engine === 'browser') return
  for (const t of texts) {
    if (audioCache.has(ckey(s, t))) continue
    try { await fetchAudio(t, s, undefined, true) } catch { /* 失敗しても無視 */ }
  }
}

// 長い返答は先頭の数文だけ読み上げ、残りは画面表示にする(重要な通知は limit=0 で全文)
export function speakable(text, limit) {
  const clean = text.replace(/```[\s\S]*?```/g, 'コードは画面をご覧ください。').replace(/https?:\/\/\S+/g, 'リンク').replace(/[`*_#>|]+/g, '').replace(/\s+/g, ' ').trim()
  if (!limit || clean.length <= limit) return { spoken: clean, rest: '' }
  const sents = clean.match(/[^。！？!?]+[。！？!?]?/g) || [clean]
  let out = ''
  for (const s of sents) {
    if (out && (out + s).length > limit) break
    out += s
  }
  if (out.length > limit * 1.5) out = out.slice(0, limit)
  return { spoken: out.replace(/[。！？!?]$/, '') + (out.length < clean.length ? '。続きは画面に表示しています。' : ''), rest: clean.slice(out.length).trim() }
}

async function fetchAudio(text, s, signal, cacheOnly = false) {
  const key = ckey(s, text)
  let blob = audioCache.get(key)
  if (!blob) {
    blob = await fetchBlob(text, s, signal)
    if (text.length <= 40) {
      audioCache.set(key, blob)
      if (audioCache.size > 40) audioCache.delete(audioCache.keys().next().value)
    }
  }
  return cacheOnly ? null : URL.createObjectURL(blob)
}

async function fetchBlob(text, s, signal) {
  const body = { text }
  if (s.engine) body.engine = s.engine
  if (s.voice) body.voice = s.voice
  if (s.rate !== undefined) body.rate = s.rate
  if (s.pitch !== undefined) body.pitch = s.pitch
  const r = await fetch('/api/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  if (!r.ok) throw new Error('tts ' + r.status)
  return await r.blob()
}

function playUrl(url, signal) {
  return new Promise((resolve, reject) => {
    const a = new Audio(url)
    const done = () => { URL.revokeObjectURL(url); resolve() }
    a.onended = done
    a.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio')) }
    signal.addEventListener('abort', () => { a.pause(); done() })
    a.play().catch(reject)
  })
}

// 1つの発話を文ごとに先読みしながら再生する。中断は AbortController で。
export class Speaker {
  constructor() { this.ctrl = null }
  stop() { this.ctrl?.abort(); this.ctrl = null }
  // opts: {engine, voice, rate, pitch, browser_voice, tts_rate} (設定の上書き)
  async speak(text, settings, opts = {}) {
    this.stop()
    const ctrl = new AbortController()
    this.ctrl = ctrl
    const { signal } = ctrl
    const { onStart, onChunk, ...over } = opts
    const s = speechOpts(settings, over)
    const chunks = splitSentences(text.replace(/```[\s\S]*?```/g, 'コードは画面をご覧ください。').replace(/https?:\/\/\S+/g, 'リンク').replace(/[`*_#>|]+/g, ''))
    onStart?.(chunks)
    let next = null
    const prefetch = (i) => (s.engine === 'browser' || i >= chunks.length) ? null
      : fetchAudio(chunks[i], s, signal).catch(() => null)
    next = prefetch(0)
    for (let i = 0; i < chunks.length && !signal.aborted; i++) {
      const cur = next
      next = prefetch(i + 1)
      const url = cur ? await cur : null
      if (signal.aborted) break
      onChunk?.(i)
      try {
        if (!url) throw new Error('fallback')
        await playUrl(url, signal)
      } catch {
        if (!signal.aborted) await speakBrowser(chunks[i], s, signal) // フォールバック
      }
    }
    if (this.ctrl === ctrl) this.ctrl = null
  }
}

// ---------------- STT ----------------
export class Listener {
  // cbs: {onInterim(text), onFinal(text), onState('on'|'off'), onError(msg)}
  constructor(cbs) { this.cbs = cbs; this.rec = null; this.want = false; this.paused = false; this.continuous = false }

  start(continuous) {
    if (!SR) return this.cbs.onError?.('このブラウザは音声認識に未対応です (Chrome / Edge / Safari を使用)')
    this.stop()
    this.want = true
    this.continuous = continuous
    this._open()
  }

  _open() {
    if (!this.want || this.paused) return
    const rec = new SR()
    rec.lang = 'ja-JP'
    rec.continuous = true
    rec.interimResults = true
    rec.onstart = () => this.cbs.onState?.('on')
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const t = r[0].transcript
        if (r.isFinal) {
          this.cbs.onFinal?.(t.trim(), r[0].confidence)
          if (!this.continuous) { this.stop(); return }
        } else interim += t
      }
      if (interim) this.cbs.onInterim?.(interim)
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.want = false
        this.cbs.onError?.('マイクの使用が許可されていません。ブラウザのアドレスバーでマイクを許可してください')
      }
    }
    rec.onend = () => {
      this.cbs.onState?.('off')
      if (this.want && !this.paused) setTimeout(() => this._open(), 250)
    }
    this.rec = rec
    try { rec.start() } catch { /* already started */ }
  }

  // TTS再生中は自分の声を拾わないよう一時停止
  pause() { this.paused = true; try { this.rec?.abort() } catch {} }
  resume() { this.paused = false; if (this.want) this._open() }
  stop() {
    this.want = false
    try { this.rec?.abort() } catch {}
    this.rec = null
    this.cbs.onState?.('off')
  }
}

// ---------------- ウェイクワード ----------------
const WAKE_DEFAULTS = ['ジャービス', 'ジャーヴィス', 'ジャービズ', 'じゃーびす', 'ジャーピス', 'jarvis', 'ジャルビス']

export function matchWake(text, wakeWord) {
  const words = [...new Set([wakeWord, ...(wakeWord === 'ジャービス' ? WAKE_DEFAULTS : [])].filter(Boolean))]
  const lower = text.toLowerCase()
  for (const w of words) {
    const i = lower.indexOf(w.toLowerCase())
    if (i >= 0) {
      const rest = (text.slice(0, i) + text.slice(i + w.length)).replace(/^[、,。\s]+|[、,。\s]+$/g, '')
      return { hit: true, rest }
    }
  }
  return { hit: false, rest: text }
}

export const isBye = (t) => /バイバイ|ばいばい|bye ?bye/i.test(t)


// ---------------- マイク音量ゲート ----------------
// 認識(Web Speech)とは別にマイク音量を監視し、「周囲の音より十分大きい声」があった時だけ認識結果を採用する。
// 周囲音(音楽など)は常時学習するので、音楽が流れていればその分しきい値が上がる。
const WORKLET = `class Cap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      this.buf.push(new Float32Array(ch)); this.n += ch.length
      if (this.n >= 2048) {
        const out = new Float32Array(this.n); let o = 0
        for (const b of this.buf) { out.set(b, o); o += b.length }
        this.port.postMessage(out, [out.buffer]); this.buf = []; this.n = 0
      }
    }
    return true
  }
}
registerProcessor('cap', Cap)`

const SPK_RATE = 16000
const RING_SEC = 30

export class MicGate {
  constructor() {
    this.ctx = null; this.stream = null; this.timer = null
    this.level = -100; this.floor = null
    this.marginDb = 12; this.minDb = -55
    this.lastLoudAt = 0; this.paused = false; this.onLevel = null
    // 声紋照合用に、16kHz mono の生音声をリングバッファに保持する
    this.ring = new Float32Array(SPK_RATE * RING_SEC); this.wr = 0
    this.acc = 0; this.cnt = 0; this.pos = 0; this.ratio = 3
    this.inSeg = false; this.segStart = 0; this.segEnd = 0
  }

  _push(chunk) {
    const N = this.ring.length
    for (let i = 0; i < chunk.length; i++) {
      this.acc += chunk[i]; this.cnt++; this.pos += 1
      if (this.pos >= this.ratio) { // 箱型平均でダウンサンプル
        this.ring[this.wr % N] = this.acc / this.cnt
        this.wr++; this.acc = 0; this.cnt = 0; this.pos -= this.ratio
      }
    }
  }
  mark() { return this.wr }
  // [from,to) を Int16 PCM(16kHz) として取り出す
  grab(from, to, maxSec = 12) {
    const N = this.ring.length
    to = Math.min(to ?? this.wr, this.wr)
    from = Math.max(from, to - maxSec * SPK_RATE, this.wr - N + 1)
    if (to <= from) return null
    const out = new Int16Array(to - from)
    for (let i = from; i < to; i++) out[i - from] = Math.max(-1, Math.min(1, this.ring[i % N])) * 32767
    return out
  }
  // 直近の「声として検知した区間」の音声。取り出したら次の区間に進める
  segment() {
    if (!this.segEnd || this.segEnd <= this.segStart) return null
    const seg = this.grab(this.segStart, Math.min(this.wr, this.segEnd + 3200), 10)
    this.segStart = this.segEnd
    return seg
  }
  get active() { return !!this.ctx }
  get threshold() { return Math.max(this.minDb, (this.floor ?? -90) + this.marginDb) }
  configure({ marginDb, minDb }) {
    if (marginDb !== undefined) this.marginDb = marginDb
    if (minDb !== undefined) this.minDb = minDb
  }
  heardRecently(ms) { return Date.now() - this.lastLoudAt < ms }
  pause() { this.paused = true }
  resume() { this.paused = false; this.lastLoudAt = 0; this.inSeg = false; this.segStart = this.segEnd = this.wr } // 自分の発話中の音は無かったことにする

  async start() {
    if (this.ctx) return true
    try {
      // AGC は切る(遠い音楽と近い声の音量差を潰してしまうため)
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      })
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const src = ctx.createMediaStreamSource(this.stream)
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800 // 声の帯域だけで測る
      const an = ctx.createAnalyser(); an.fftSize = 1024
      src.connect(hp); hp.connect(lp); lp.connect(an)
      this.ratio = ctx.sampleRate / SPK_RATE
      try { // 生音声のキャプチャ(声紋用)。失敗しても音量ゲートは動かす
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })))
        const cap = new AudioWorkletNode(ctx, 'cap')
        cap.port.onmessage = (e) => this._push(e.data)
        const sink = ctx.createGain(); sink.gain.value = 0
        src.connect(cap); cap.connect(sink); sink.connect(ctx.destination)
      } catch { /* 声紋照合は使えない */ }
      this.ctx = ctx
      const buf = new Float32Array(an.fftSize)
      this.timer = setInterval(() => {
        an.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9)
        this.level = db
        if (this.floor === null) this.floor = db
        const loud = db > this.threshold
        if (!this.paused) {
          if (db < this.floor) this.floor = db                       // 静かになったら即追従
          else {
            // 声の最中は遅く追従。ただし約4秒途切れず大きい音が続くなら音楽等とみなして素早く追従
            this.loudRun = loud ? (this.loudRun || 0) + 1 : 0
            this.floor += (db - this.floor) * (loud ? (this.loudRun > 80 ? 0.03 : 0.002) : 0.02)
          }
          this.floor = Math.min(-20, Math.max(-90, this.floor))
          if (loud) {
            this.lastLoudAt = Date.now()
            if (!this.inSeg) { this.inSeg = true; this.segStart = Math.max(0, this.wr - 4800) } // 0.3秒手前から
            this.segEnd = this.wr
          } else if (this.inSeg && Date.now() - this.lastLoudAt > 1500) this.inSeg = false
        }
        this.onLevel?.({ level: db, floor: this.floor, threshold: this.threshold, loud })
      }, 50)
      return true
    } catch (e) {
      this.stop()
      return false
    }
  }

  stop() {
    clearInterval(this.timer); this.timer = null
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null
    this.ctx?.close?.(); this.ctx = null
    this.floor = null; this.lastLoudAt = 0; this.inSeg = false; this.wr = 0; this.segStart = this.segEnd = 0
  }
}
