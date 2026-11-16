import { joinRoom } from './vendor/trystero.js'

const APP_ID = 'kamp-telsizi-v1'
const WEB_URL = 'https://m-emir2133.github.io/ses/'
// Masaüstü (Tauri) uygulamasının içinde mi çalışıyoruz?
const TAURI = window.__TAURI__
const isApp = !!(TAURI && TAURI.core)
const invoke = (cmd, args) => TAURI.core.invoke(cmd, args)
const $ = id => document.getElementById(id)

// ---------- Ayarlar (tarayıcıda saklanır) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('kt.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('kt.' + k, JSON.stringify(v)) } catch {} }
}
const S = Object.assign({
  name: '', room: '', mode: 'vad', threshold: -50, pttKey: 'Space', pttVk: 32, gain: 100,
  quality: 24000, ec: true, ns: true, agc: true, master: 100, lite: false, sounds: true, mic: '', out: '',
  turnUrl: '', turnUser: '', turnPass: '', vols: {}
}, store.get('settings', {}))
// Eski sürümden kalan tek 'noise' ayarını yeni üç ayara aktar
if (typeof S.noise === 'boolean') { S.ec = S.ns = S.agc = S.noise; delete S.noise }
const save = () => store.set('settings', S)

// ---------- Durum ----------
let room = null, info = null
let monitor = null
let ctx = null, gate = null, micSrc = null, rawStream = null, sendStream = null
let muted = false, deaf = false, pttDown = false, gateOpen = false
let loops = []
const peers = new Map() // peerId -> {id,name,muted,deaf,audio,an,buf,ping,speaking,el}
let lastBytes = { sent: 0, recv: 0, t: 0 }

// ---------- Giriş ekranı ----------
function initLobby() {
  $('name').value = S.name
  const m = location.hash.match(/oda=([^&]+)/)
  $('room').value = m ? decodeURIComponent(m[1]) : S.room
  $('rand-room').onclick = () => {
    const w = ['kamp', 'orman', 'ates', 'balta', 'magara', 'nehir', 'kulube', 'yamyam', 'cadir', 'mesale']
    const pick = () => w[Math.floor(Math.random() * w.length)]
    $('room').value = `${pick()}-${pick()}-${Math.floor(100 + Math.random() * 900)}`
  }
  $('join').onclick = join
  for (const id of ['name', 'room']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') join() })
}

const normRoom = s => s.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32)

async function join() {
  const name = $('name').value.trim().slice(0, 20)
  const code = normRoom($('room').value)
  $('lobby-err').textContent = ''
  if (!name) return ($('lobby-err').textContent = 'Bir isim yaz.')
  if (code.length < 3) return ($('lobby-err').textContent = 'Oda kodu en az 3 karakter olmalı.')
  S.name = name; S.room = code; save()
  $('join').disabled = true
  setJoinText('Mikrofon açılıyor…')
  try {
    await startAudio()
  } catch (e) {
    console.error(e)
    $('lobby-err').textContent = e && e.name === 'NotAllowedError'
      ? 'Mikrofon izni verilmedi. Adres çubuğundaki kilit simgesinden izin ver.'
      : 'Mikrofon açılamadı: ' + (e && e.message || e)
    $('join').disabled = false
    setJoinText()
    return
  }
  history.replaceState(null, '', '#oda=' + encodeURIComponent(code))
  setJoinText('Bağlanıyor…')
  await startRoom(code)
  syncPttKey()
  showScreen('call')
  $('room-label').textContent = code
  $('join').disabled = false
  setJoinText()
  renderSelf()
  fillDevices()
  updateControls()
}

// ---------- Ses hattı: mikrofon -> kapı (worklet) -> gönderilen akış ----------
async function openMic() {
  const c = { echoCancellation: S.ec, noiseSuppression: S.ns, autoGainControl: S.agc, channelCount: 1 }
  if (S.mic) c.deviceId = { exact: S.mic }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: c })
  } catch (e) {
    if (!S.mic || e.name === 'NotAllowedError') throw e
    S.mic = ''; save(); delete c.deviceId
    return navigator.mediaDevices.getUserMedia({ audio: c })
  }
}

async function startAudio() {
  rawStream = await openMic()
  ctx = new AudioContext({ latencyHint: 'interactive' })
  await ctx.audioWorklet.addModule('gate-worklet.js')
  gate = new AudioWorkletNode(ctx, 'gate', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit'
  })
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  gate.connect(dest)
  // "Kendini dinle" için mikrofon çıkışını hoparlöre de verebilen düğüm
  monitor = ctx.createGain()
  monitor.gain.value = 0
  gate.connect(monitor).connect(ctx.destination)
  applyCtxSink()
  micSrc = ctx.createMediaStreamSource(rawStream)
  micSrc.connect(gate)
  sendStream = dest.stream
  gate.port.onmessage = e => onLocalLevel(e.data)
  pushGate()
  if (ctx.state === 'suspended') await ctx.resume()
}

async function switchMic() {
  if (!ctx) return
  const old = rawStream
  try {
    rawStream = await openMic()
  } catch (e) {
    rawStream = old
    return toast('Mikrofon değiştirilemedi')
  }
  micSrc.disconnect()
  old.getTracks().forEach(t => t.stop())
  micSrc = ctx.createMediaStreamSource(rawStream)
  micSrc.connect(gate)
}

function pushGate() {
  if (!gate) return
  gate.port.postMessage({ mode: S.mode, threshold: S.threshold, ptt: pttDown, muted, inputGain: S.gain / 100 })
  // Susturulunca izi tamamen kapat: neredeyse hiç veri gitmez
  sendStream && sendStream.getAudioTracks().forEach(t => (t.enabled = !muted))
}

function stopAudio() {
  rawStream && rawStream.getTracks().forEach(t => t.stop())
  sendStream && sendStream.getTracks().forEach(t => t.stop())
  ctx && ctx.close().catch(() => {})
  ctx = gate = micSrc = rawStream = sendStream = monitor = null
  setMonitor(false)
}

// ---------- Oda / P2P ----------
// Varsayılan TURN (Metered ücretsiz plan): doğrudan bağlantı kurulamayan ağlarda
// (yurt/kampüs, mobil hat, CGNAT) ses bu sunucu üzerinden aktarılır.
const METERED_URL = 'https://kamptelsizi.metered.live/api/v1/turn/credentials?apiKey=4e1a58f5f6e4e9d1548aaae73ec8a2e0573f'
let meteredCache = null
async function defaultTurn() {
  if (meteredCache && Date.now() - meteredCache.t < 3600e3) return meteredCache.list
  try {
    const ctl = new AbortController()
    const tm = setTimeout(() => ctl.abort(), 4000)
    const r = await fetch(METERED_URL, { signal: ctl.signal })
    clearTimeout(tm)
    const list = (await r.json()).filter(s => s && s.username && /^turns?:/.test([].concat(s.urls)[0]))
    meteredCache = { t: Date.now(), list }
    return list
  } catch (e) {
    console.warn('TURN bilgisi alınamadı', e)
    return []
  }
}

async function startRoom(code) {
  const cfg = { appId: APP_ID, password: 'kt:' + code, identity: 'none' }
  // İsteğe bağlı: kendi eşleştirme (nostr) sunucunu kullan — ör. ?relay=wss://sunucu.com
  const relay = new URLSearchParams(location.search).get('relay')
  if (relay) cfg.relayConfig = { urls: relay.split(',') }
  const turn = await defaultTurn()
  if (S.turnUrl.trim()) {
    turn.unshift({ urls: S.turnUrl.trim(), username: S.turnUser || undefined, credential: S.turnPass || undefined })
  }
  if (turn.length) cfg.turnConfig = turn
  room = joinRoom(cfg, code)
  info = room.makeAction('info')

  info.onMessage((d, { peerId }) => {
    if (!d || typeof d !== 'object') return
    const p = ensurePeer(peerId)
    p.name = String(d.name || '?').slice(0, 20)
    p.muted = !!d.muted
    p.deaf = !!d.deaf
    applyVolume(p)
    renderPeer(p)
  })

  room.onPeerJoin(({ peerId }) => {
    ensurePeer(peerId)
    room.addStream(sendStream, { target: peerId }).catch(e => console.warn('addStream', e))
    info.send(myInfo(), { target: peerId }).catch(() => {})
    beep(true)
    updateStatus()
  })

  room.onPeerLeave(({ peerId }) => {
    removePeer(peerId)
    beep(false)
    updateStatus()
  })

  room.onPeerStream((stream, { peerId }) => attachStream(ensurePeer(peerId), stream))

  room.onError(err => {
    console.warn('room error', err)
    if (err.code === 'peer-connect-failed') {
      toast('Bir kişiyle doğrudan bağlantı kurulamadı. Ayarlar > Gelişmiş > TURN gerekebilir.')
    } else if (err.code === 'relay-failed') {
      toast('Eşleştirme sunucularına ulaşılamıyor, internetini kontrol et.')
    }
  })

  loops.push(setInterval(tickLevels, 90))
  loops.push(setInterval(tickStats, 2000))
  updateStatus()
}

const myInfo = () => ({ name: S.name, muted, deaf })
const broadcastInfo = () => info && info.send(myInfo()).catch(() => {})

function ensurePeer(id) {
  let p = peers.get(id)
  if (!p) {
    p = { id, name: '…', muted: false, deaf: false, audio: null, an: null, buf: null, ping: null, speaking: false, el: null }
    peers.set(id, p)
    renderPeer(p)
  }
  return p
}

function removePeer(id) {
  const p = peers.get(id)
  if (!p) return
  if (p.audio) { p.audio.srcObject = null; p.audio.remove() }
  try { p.src && p.src.disconnect() } catch {}
  if (p.el) {
    const el = p.el
    el.classList.add('leaving')
    setTimeout(() => { el.remove(); layoutSeats() }, 380)
  }
  peers.delete(id)
}

function attachStream(p, stream) {
  if (!p.audio) {
    p.audio = new Audio()
    p.audio.autoplay = true
    p.audio.style.display = 'none'
    document.body.appendChild(p.audio)
  }
  p.audio.srcObject = stream
  applySink(p.audio)
  applyVolume(p)
  p.audio.play().catch(() => toast('Sesi başlatmak için sayfaya bir kez tıkla.'))
  if (ctx) {
    try { p.src && p.src.disconnect() } catch {}
    p.src = ctx.createMediaStreamSource(stream)
    p.an = ctx.createAnalyser()
    p.an.fftSize = 512
    p.buf = new Float32Array(p.an.fftSize)
    p.src.connect(p.an)
    // %100 üstü yükseltme için Web Audio yolu
    p.boost = ctx.createGain()
    p.boost.gain.value = 0
    p.src.connect(p.boost).connect(ctx.destination)
  }
  applyVolume(p)
}

// Ses seviyesi: %100'e kadar normal oynatıcı (yankı önleme en iyi böyle çalışır),
// %100 üstünde Web Audio kazancıyla yükseltme.
const volOf = p => S.vols[p.name] ?? 100
function applyVolume(p) {
  if (!p.audio) return
  const eff = deaf ? 0 : (volOf(p) * S.master) / 100
  const boosted = eff > 100 && p.boost
  p.audio.muted = deaf || boosted
  p.audio.volume = Math.max(0, Math.min(1, eff / 100))
  if (p.boost) p.boost.gain.setTargetAtTime(boosted ? eff / 100 : 0, p.boost.context.currentTime, 0.02)
}

function applySink(el) {
  if (S.out && el.setSinkId) el.setSinkId(S.out).catch(() => {})
}
function applyCtxSink() {
  if (ctx && ctx.setSinkId) ctx.setSinkId(S.out || '').catch(() => {})
}

let monitoring = false
function setMonitor(on) {
  monitoring = on
  if (monitor) monitor.gain.setTargetAtTime(on ? 1 : 0, monitor.context.currentTime, 0.02)
  const b = document.getElementById('monitor-btn')
  if (b) { b.classList.toggle('on', on); b.textContent = on ? 'Dinlemeyi durdur' : 'Kendini dinle' }
}

function setBitrate(pc) {
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== 'audio') continue
    const prm = s.getParameters()
    if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}]
    if (prm.encodings[0].maxBitrate === S.quality) continue
    prm.encodings[0].maxBitrate = S.quality
    prm.encodings[0].priority = 'high'
    prm.encodings[0].networkPriority = 'high'
    s.setParameters(prm).catch(() => {})
  }
}

async function tickStats() {
  if (!room) return
  const all = room.getPeers()
  let sent = 0, recv = 0
  await Promise.all([...peers.values()].map(async p => {
    const pc = all[p.id] && all[p.id].connection
    if (pc) {
      setBitrate(pc)
      try {
        const st = await pc.getStats()
        st.forEach(r => {
          if (r.type === 'outbound-rtp' && r.kind === 'audio') sent += r.bytesSent || 0
          if (r.type === 'inbound-rtp' && r.kind === 'audio') recv += r.bytesReceived || 0
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) {
            p.ping = Math.round(r.currentRoundTripTime * 1000)
          }
        })
      } catch {}
    }
    if (p.ping == null) {
      try { p.ping = Math.round(await room.ping(p.id)) } catch {}
    }
    renderPeer(p)
  }))
  const now = performance.now()
  if (lastBytes.t) {
    const dt = (now - lastBytes.t) / 1000
    const up = Math.max(0, (sent - lastBytes.sent) * 8 / dt / 1000)
    const down = Math.max(0, (recv - lastBytes.recv) * 8 / dt / 1000)
    updateStatus(up, down)
  }
  lastBytes = { sent, recv, t: now }
}

const dbToLvl = db => Math.max(0, Math.min(1, (db + 58) / 36))

function tickLevels() {
  let any = false
  for (const p of peers.values()) {
    let lvl = 0
    if (p.an && !p.muted) {
      p.an.getFloatTimeDomainData(p.buf)
      let s = 0
      for (let i = 0; i < p.buf.length; i++) s += p.buf[i] * p.buf[i]
      const rms = Math.sqrt(s / p.buf.length)
      lvl = rms > 0.006 ? dbToLvl(20 * Math.log10(rms)) : 0
    }
    // yumuşak düşüş
    p.lvl = Math.max(lvl, (p.lvl || 0) * 0.6)
    const speaking = p.lvl > 0.08
    if (p.el) p.el.style.setProperty('--lvl', p.lvl.toFixed(2))
    if (speaking !== p.speaking) {
      p.speaking = speaking
      p.el && p.el.classList.toggle('speaking', speaking)
    }
    any = any || speaking
  }
}

let selfSpeaking = false, selfLvl = 0
function onLocalLevel({ level, open }) {
  gateOpen = open
  const pct = Math.max(0, Math.min(100, (level + 90) / 90 * 100))
  const bar = $('meter-bar')
  bar.style.width = pct + '%'
  bar.classList.toggle('open', open)
  const on = open && !muted
  selfLvl = on ? Math.max(dbToLvl(level), selfLvl * 0.6) : selfLvl * 0.5
  const self = $('peer-self')
  if (self) {
    self.style.setProperty('--lvl', selfLvl.toFixed(2))
    if (on !== selfSpeaking) self.classList.toggle('speaking', on)
  }
  selfSpeaking = on
}

async function leave() {
  loops.forEach(clearInterval); loops = []
  const r = room
  room = null; syncPttKey()
  if (r) { try { await r.leave() } catch {} }
  room = info = null
  for (const id of [...peers.keys()]) removePeer(id)
  stopAudio()
  for (const el of document.querySelectorAll('#circle .seat')) el.remove()
  selfSpeaking = false
  closeSettings()
  showScreen('lobby')
  lastBytes = { sent: 0, recv: 0, t: 0 }
}

// ---------- Arayüz ----------
function showScreen(name) {
  const call = name === 'call'
  $('lobby').classList.toggle('hidden', call)
  $('call').classList.toggle('hidden', !call)
  document.body.classList.toggle('in-call', call)
}

function setJoinText(t) {
  $('join').disabled = !!t
  $('join').querySelector('.cta-text').textContent = t || 'Katıl'
}

const hueOf = s => {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 360
}

const MUTE_SVG = '<svg><use href="#i-mic-off"/></svg>'
const DEAF_SVG = '<svg><use href="#i-head-off"/></svg>'

function makeSeat(id, self) {
  const el = document.createElement('div')
  el.className = 'seat ' + (self ? 'self' : 'peer')
  el.id = 'peer-' + id
  el.innerHTML = `
    <div class="seat-row">
      <div class="avatar"></div>
      <div class="seat-text"><div class="seat-name"></div><div class="seat-meta"></div></div>
      <span class="badge"></span>
    </div>
    ${self ? '' : `<div class="vol-pop"><svg class="vol-ico"><use href="#i-vol"/></svg><input class="pvol" type="range" min="0" max="200" step="5" aria-label="Ses seviyesi" title="Çift tıkla: %100"><b class="vol-val"></b></div>`}`
  $('circle').appendChild(el)
  return el
}

// Sen her zaman en üstte
function layoutSeats() {
  const self = $('peer-self')
  if (self && self !== $('circle').firstElementChild) $('circle').prepend(self)
  $('alone').classList.toggle('hidden', peers.size > 0)
}

function badgeHtml(isMuted, isDeaf) {
  return isDeaf ? DEAF_SVG : isMuted ? MUTE_SVG : ''
}

function renderSelf() {
  let el = $('peer-self')
  if (!el) { el = makeSeat('self', true); layoutSeats() }
  el.style.setProperty('--hue', hueOf(S.name))
  el.querySelector('.avatar').textContent = (S.name[0] || '?').toLocaleUpperCase('tr')
  el.querySelector('.seat-name').textContent = S.name
  el.querySelector('.seat-meta').textContent = 'Sen'
  const b = el.querySelector('.badge')
  const html = badgeHtml(muted, deaf)
  if (b.innerHTML !== html) b.innerHTML = html
}

function setRangeFill(r) {
  const p = ((r.value - r.min) / (r.max - r.min)) * 100
  r.style.setProperty('--p', p + '%')
}

function showVol(p) {
  const vol = p.el.querySelector('.pvol')
  setRangeFill(vol)
  const v = +vol.value
  const lab = p.el.querySelector('.vol-val')
  lab.textContent = '%' + v
  p.el.classList.toggle('boosted', v > 100)
}

function renderPeer(p) {
  if (!p.el) {
    p.el = makeSeat(p.id, false)
    const vol = p.el.querySelector('.pvol')
    const setVol = v => {
      S.vols[p.name] = v; vol.value = v; applyVolume(p); save()
      showVol(p)
    }
    vol.oninput = () => setVol(+vol.value)
    vol.ondblclick = () => setVol(100)
    p.el.querySelector('.vol-pop').addEventListener('click', e => e.stopPropagation())
    p.el.addEventListener('click', e => {
      e.stopPropagation()
      const was = p.el.classList.contains('open')
      document.querySelectorAll('.seat.open').forEach(s => s.classList.remove('open'))
      p.el.classList.toggle('open', !was)
    })
    layoutSeats()
  }
  const el = p.el
  el.style.setProperty('--hue', hueOf(p.name))
  el.querySelector('.avatar').textContent = (p.name[0] || '?').toLocaleUpperCase('tr')
  el.querySelector('.seat-name').textContent = p.name
  const vol = el.querySelector('.pvol')
  if (document.activeElement !== vol) {
    vol.value = volOf(p)
    showVol(p)
  }
  const meta = el.querySelector('.seat-meta')
  if (p.ping != null) {
    meta.textContent = p.ping + ' ms'
    meta.className = 'seat-meta ' + (p.ping < 80 ? 'good' : p.ping < 180 ? 'mid' : 'bad')
  } else {
    meta.textContent = p.audio ? 'bağlı' : 'bağlanıyor'
    meta.className = 'seat-meta'
  }
  const b = el.querySelector('.badge')
  const html = badgeHtml(p.muted, p.deaf)
  if (b.innerHTML !== html) b.innerHTML = html
}

function updateStatus(up, down) {
  const n = peers.size
  let t = n === 0 ? 'Odada şimdilik yalnızsın' : `${n + 1} kişi bağlı`
  if (n > 0 && up != null) t += ` · ↑${up.toFixed(0)} ↓${down.toFixed(0)} kbps`
  $('status').textContent = t
  $('live-dot').classList.toggle('ok', n > 0)
  $('alone').classList.toggle('hidden', n > 0)
}

function updateControls() {
  $('mute').classList.toggle('off', muted)
  $('mute').title = muted ? 'Mikrofonu aç (M)' : 'Mikrofonu kapat (M)'
  $('deafen').classList.toggle('off', deaf)
  $('deafen').title = deaf ? 'Sesi aç (D)' : 'Sağırlaştır (D)'
  $('ptt-hold').classList.toggle('hidden', S.mode !== 'ptt')
  $('ptt-hold').classList.toggle('on', pttDown)
  $('vad-wrap').classList.toggle('hidden', S.mode !== 'vad')
  $('meter-thr').classList.toggle('hidden', S.mode !== 'vad')
  $('ptt-wrap').classList.toggle('hidden', S.mode !== 'ptt')
  document.querySelectorAll('#mode-seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === S.mode))
  document.querySelectorAll('#quality-seg button').forEach(b => b.classList.toggle('active', +b.dataset.q === S.quality))
  renderSelf()
}

function setMuted(v) {
  muted = v
  if (!muted && deaf) deaf = false, peers.forEach(applyVolume)
  pushGate(); updateControls(); broadcastInfo()
}
let mutedBeforeDeaf = false
function setDeaf(v) {
  if (v) mutedBeforeDeaf = muted
  deaf = v
  muted = v ? true : mutedBeforeDeaf
  peers.forEach(applyVolume)
  pushGate(); updateControls(); broadcastInfo()
}
function setPtt(v) {
  if (pttDown === v) return
  pttDown = v
  pushGate()
  $('ptt-hold').classList.toggle('on', v)
}

let toastTimer
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.classList.toggle('warn', !/✓/.test(msg))
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 4500)
}

function openSettings() {
  $('settings').classList.remove('hidden')
  fillDevices()
}
function closeSettings() { $('settings').classList.add('hidden') }

function beep(up) {
  if (!S.sounds || !ctx) return
  const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime
  o.frequency.setValueAtTime(up ? 520 : 660, t)
  o.frequency.linearRampToValueAtTime(up ? 780 : 440, t + 0.12)
  g.gain.setValueAtTime(0.06, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
  o.connect(g).connect(ctx.destination)
  o.start(t); o.stop(t + 0.2)
}

async function fillDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    const fill = (sel, kind, cur) => {
      sel.innerHTML = ''
      const def = new Option('Varsayılan', '')
      sel.add(def)
      devs.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default').forEach((d, i) =>
        sel.add(new Option(d.label || `${kind === 'audioinput' ? 'Mikrofon' : 'Çıkış'} ${i + 1}`, d.deviceId)))
      sel.value = [...sel.options].some(o => o.value === cur) ? cur : ''
    }
    fill($('mic-select'), 'audioinput', S.mic)
    if ('setSinkId' in HTMLMediaElement.prototype) fill($('out-select'), 'audiooutput', S.out)
    else $('out-wrap').classList.add('hidden')
  } catch {}
}

function keyName(code) {
  const mouse = { Mouse1: 'Fare orta tuş', Mouse3: 'Fare yan tuş 1', Mouse4: 'Fare yan tuş 2' }
  return mouse[code] || code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ')
}

// Fare tuşu -> Windows sanal tuş kodu
const MOUSE_VK = { 1: 0x04, 3: 0x05, 4: 0x06 }

// Masaüstü uygulamasında tuşu Rust tarafı izler (oyun öndeyken de çalışır)
function syncPttKey() {
  if (!isApp) return
  invoke('set_ptt_key', { vk: room && S.mode === 'ptt' ? S.pttVk : 0 }).catch(() => {})
}

function initSettings() {
  $('mode').value = S.mode
  $('threshold').value = S.threshold
  $('thr-val').textContent = S.threshold
  $('in-gain').value = S.gain
  $('gain-val').textContent = S.gain
  $('quality').value = String(S.quality)
  for (const k of ['ec', 'ns', 'agc']) {
    $(k).checked = S[k]
    $(k).onchange = e => { S[k] = e.target.checked; save(); switchMic() }
  }
  $('lite').checked = S.lite
  $('lite').onchange = e => { S.lite = e.target.checked; save(); document.body.classList.toggle('lite', S.lite) }
  $('master').value = S.master
  $('master-val').textContent = S.master
  $('master').oninput = e => {
    S.master = +e.target.value; $('master-val').textContent = S.master; save(); peers.forEach(applyVolume)
  }
  $('monitor-btn').onclick = () => {
    if (!ctx) return toast('Mikrofon testi için önce bir odaya katıl')
    setMonitor(!monitoring)
    if (monitoring) toast('Kulaklık kullan, yoksa yankı olur')
  }
  $('sounds').checked = S.sounds
  $('ptt-key').textContent = keyName(S.pttKey)
  for (const r of document.querySelectorAll('.sheet input[type=range]')) {
    setRangeFill(r)
    r.addEventListener('input', () => setRangeFill(r))
  }
  document.querySelectorAll('#mode-seg button').forEach(b => b.onclick = () => {
    $('mode').value = b.dataset.mode
    $('mode').dispatchEvent(new Event('change'))
  })
  document.querySelectorAll('#quality-seg button').forEach(b => b.onclick = () => {
    $('quality').value = b.dataset.q
    $('quality').dispatchEvent(new Event('change'))
    updateControls()
  })
  $('open-settings').onclick = openSettings
  document.querySelectorAll('#settings [data-close]').forEach(b => b.onclick = closeSettings)
  document.addEventListener('click', () => document.querySelectorAll('.seat.open').forEach(s => s.classList.remove('open')))
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettings() })
  $('turn-url').value = S.turnUrl
  $('turn-user').value = S.turnUser
  $('turn-pass').value = S.turnPass
  const thrMark = () => ($('meter-thr').style.left = ((S.threshold + 90) / 90 * 100) + '%')
  thrMark()

  $('mode').onchange = e => { S.mode = e.target.value; save(); setPtt(false); pushGate(); updateControls(); syncPttKey() }
  $('threshold').oninput = e => { S.threshold = +e.target.value; $('thr-val').textContent = S.threshold; thrMark(); save(); pushGate() }
  $('in-gain').oninput = e => { S.gain = +e.target.value; $('gain-val').textContent = S.gain; save(); pushGate() }
  $('quality').onchange = e => { S.quality = +e.target.value; save(); tickStats() }
  $('sounds').onchange = e => { S.sounds = e.target.checked; save() }
  $('mic-select').onchange = e => { S.mic = e.target.value; save(); switchMic() }
  $('out-select').onchange = e => { S.out = e.target.value; save(); peers.forEach(p => p.audio && applySink(p.audio)); applyCtxSink() }
  for (const k of ['turn-url', 'turn-user', 'turn-pass']) {
    $(k).onchange = () => {
      S.turnUrl = $('turn-url').value; S.turnUser = $('turn-user').value; S.turnPass = $('turn-pass').value; save()
    }
  }

  let capturing = false
  const setKey = (code, vk) => {
    capturing = false
    S.pttKey = code; S.pttVk = vk; save()
    $('ptt-key').textContent = keyName(code)
    $('ptt-key').blur()
    syncPttKey()
  }
  $('ptt-key').onclick = () => {
    if (capturing) return
    setTimeout(() => { capturing = true }, 0)
    $('ptt-key').textContent = 'Bir tuşa ya da fare yan tuşuna bas…'
  }
  window.addEventListener('mousedown', e => {
    if (capturing && MOUSE_VK[e.button]) { e.preventDefault(); return setKey('Mouse' + e.button, MOUSE_VK[e.button]) }
    if (room && S.mode === 'ptt' && S.pttKey === 'Mouse' + e.button) setPtt(true)
  })
  window.addEventListener('mouseup', e => { if (S.pttKey === 'Mouse' + e.button) setPtt(false) })
  // Fare yan tuşlarının tarayıcıda geri/ileri gitmesini engelle
  window.addEventListener('auxclick', e => { if (e.button === 3 || e.button === 4) e.preventDefault() })
  window.addEventListener('keydown', e => {
    if (capturing) {
      e.preventDefault()
      if (e.code === 'Escape') { capturing = false; $('ptt-key').textContent = keyName(S.pttKey); return }
      return setKey(e.code, e.keyCode)
    }
    if (!room || e.repeat) return
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName)
    if (S.mode === 'ptt' && e.code === S.pttKey && !typing) { e.preventDefault(); return setPtt(true) }
    if (typing) return
    if (e.code === 'KeyM') setMuted(!muted)
    if (e.code === 'KeyD') setDeaf(!deaf)
  })
  window.addEventListener('keyup', e => { if (e.code === S.pttKey) setPtt(false) })
  if (!isApp) window.addEventListener('blur', () => setPtt(false))

  const hold = $('ptt-hold')
  hold.addEventListener('pointerdown', e => { hold.setPointerCapture(e.pointerId); setPtt(true) })
  hold.addEventListener('pointerup', () => setPtt(false))
  hold.addEventListener('pointercancel', () => setPtt(false))

  $('mute').onclick = () => setMuted(!muted)
  $('deafen').onclick = () => setDeaf(!deaf)
  $('leave').onclick = leave
  $('copy-link').onclick = async () => {
    const url = (isApp ? WEB_URL : location.origin + location.pathname) + '#oda=' + encodeURIComponent(S.room)
    try { await navigator.clipboard.writeText(url); toast('Davet linki kopyalandı ✓') }
    catch { prompt('Linki kopyala:', url) }
  }
  navigator.mediaDevices && navigator.mediaDevices.addEventListener('devicechange', fillDevices)
}

// ---------- Güncelleme ve kurulum ----------
let bootVersion = null
let swReg = null
const fetchVersion = async () => {
  const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
  return (await r.json()).version
}

async function checkUpdate() {
  try {
    const v = await fetchVersion()
    if (bootVersion && v && v !== bootVersion) {
      $('update-ver').textContent = 'v' + v
      $('update').classList.remove('hidden')
    }
  } catch {}
}

async function applyUpdate() {
  if (room && !confirm('Güncelleme için odadan kısa süreliğine çıkacaksın. Devam?')) return
  try { if (swReg) await swReg.update() } catch {}
  try { for (const k of await caches.keys()) await caches.delete(k) } catch {}
  location.reload()
}

// Masaüstü: GitHub Releases'ta yeni sürüm var mı? Varsa indirip kurar, uygulama yeniden açılır.
let appUpdate = null
async function checkAppUpdate() {
  try {
    appUpdate = await invoke('check_update')
    if (appUpdate) {
      $('update-ver').textContent = 'v' + appUpdate.version
      $('update').classList.remove('hidden')
    }
  } catch (e) { console.warn('güncelleme denetimi', e) }
}

async function applyAppUpdate() {
  if (!appUpdate) return
  if (room && !confirm('Güncelleme kurulurken odadan çıkacaksın, uygulama birkaç saniye içinde yeniden açılır. Devam?')) return
  $('update-btn').disabled = true
  $('update-btn').textContent = 'İndiriliyor…'
  try {
    await invoke('install_update', { url: appUpdate.url })
  } catch (e) {
    $('update-btn').disabled = false
    $('update-btn').textContent = 'Tekrar dene'
    alert('Güncelleme indirilemedi: ' + e)
  }
}

async function initAppMode() {
  document.body.classList.add('app')
  const info = await invoke('app_info').catch(() => null)
  $('ver').textContent = info ? 'v' + info.version : ''
  if (info && info.global_ptt) {
    $('ptt-hint').innerHTML = '✅ Oyun penceresi öndeyken de çalışır. Klavye tuşu ya da fare yan tuşu seçebilirsin.'
  }
  await TAURI.event.listen('ptt', e => { if (room && S.mode === 'ptt') setPtt(!!e.payload) })
  $('update-btn').onclick = applyAppUpdate
  checkAppUpdate()
  setInterval(checkAppUpdate, 30 * 60 * 1000)
}

async function initUpdates() {
  if (isApp) return initAppMode()
  try { bootVersion = await fetchVersion() } catch {}
  $('ver').textContent = bootVersion ? 'v' + bootVersion : ''
  $('update-btn').onclick = applyUpdate
  setInterval(checkUpdate, 5 * 60 * 1000)
  window.addEventListener('focus', checkUpdate)
  if ('serviceWorker' in navigator) {
    try { swReg = await navigator.serviceWorker.register('sw.js') } catch {}
  }
}

let installEvt = null
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault()
  installEvt = e
  $('install-btn').classList.remove('hidden')
})
$('install-btn').onclick = async () => {
  if (!installEvt) return
  installEvt.prompt()
  await installEvt.userChoice.catch(() => {})
  installEvt = null
  $('install-btn').classList.add('hidden')
}
window.addEventListener('beforeunload', () => { room && room.leave() })

initLobby()
initSettings()
document.body.classList.toggle('lite', S.lite)
updateControls()
showScreen('lobby')
initUpdates()
