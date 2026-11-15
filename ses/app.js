import { joinRoom } from './vendor/trystero.js'

const APP_ID = 'kamp-telsizi-v1'
const $ = id => document.getElementById(id)

// ---------- Ayarlar (tarayıcıda saklanır) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('kt.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('kt.' + k, JSON.stringify(v)) } catch {} }
}
const S = Object.assign({
  name: '', room: '', mode: 'vad', threshold: -50, pttKey: 'Space', gain: 100,
  quality: 24000, noise: true, sounds: true, mic: '', out: '',
  turnUrl: '', turnUser: '', turnPass: '', vols: {}
}, store.get('settings', {}))
const save = () => store.set('settings', S)

// ---------- Durum ----------
let room = null, info = null
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
  $('join').textContent = 'Mikrofon açılıyor…'
  try {
    await startAudio()
  } catch (e) {
    console.error(e)
    $('lobby-err').textContent = e && e.name === 'NotAllowedError'
      ? 'Mikrofon izni verilmedi. Adres çubuğundaki kilit simgesinden izin ver.'
      : 'Mikrofon açılamadı: ' + (e && e.message || e)
    $('join').disabled = false
    $('join').textContent = '🎙 Katıl'
    return
  }
  history.replaceState(null, '', '#oda=' + encodeURIComponent(code))
  startRoom(code)
  $('lobby').classList.add('hidden')
  $('call').classList.remove('hidden')
  $('room-label').textContent = code
  $('join').disabled = false
  $('join').textContent = '🎙 Katıl'
  renderSelf()
  fillDevices()
  updateControls()
}

// ---------- Ses hattı: mikrofon -> kapı (worklet) -> gönderilen akış ----------
async function openMic() {
  const c = { echoCancellation: S.noise, noiseSuppression: S.noise, autoGainControl: S.noise, channelCount: 1 }
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
  ctx = gate = micSrc = rawStream = sendStream = null
}

// ---------- Oda / P2P ----------
function startRoom(code) {
  const cfg = { appId: APP_ID, password: 'kt:' + code, identity: 'none' }
  if (S.turnUrl.trim()) {
    cfg.turnConfig = [{ urls: S.turnUrl.trim(), username: S.turnUser || undefined, credential: S.turnPass || undefined }]
  }
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
  p.el && p.el.remove()
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
  }
}

function applyVolume(p) {
  if (!p.audio) return
  const v = S.vols[p.name] ?? 100
  p.audio.volume = Math.max(0, Math.min(1, v / 100))
  p.audio.muted = deaf
}

function applySink(el) {
  if (S.out && el.setSinkId) el.setSinkId(S.out).catch(() => {})
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

function tickLevels() {
  for (const p of peers.values()) {
    let speaking = false
    if (p.an) {
      p.an.getFloatTimeDomainData(p.buf)
      let s = 0
      for (let i = 0; i < p.buf.length; i++) s += p.buf[i] * p.buf[i]
      speaking = Math.sqrt(s / p.buf.length) > 0.008
    }
    if (speaking !== p.speaking) {
      p.speaking = speaking
      p.el && p.el.classList.toggle('speaking', speaking)
    }
  }
}

function onLocalLevel({ level, open }) {
  gateOpen = open
  const pct = Math.max(0, Math.min(100, (level + 90) / 90 * 100))
  const bar = $('meter-bar')
  bar.style.width = pct + '%'
  bar.classList.toggle('open', open)
  const self = $('peer-self')
  self && self.classList.toggle('speaking', open && !muted)
}

async function leave() {
  loops.forEach(clearInterval); loops = []
  if (room) { try { await room.leave() } catch {} }
  room = info = null
  for (const id of [...peers.keys()]) removePeer(id)
  stopAudio()
  $('peers').innerHTML = ''
  $('call').classList.add('hidden')
  $('lobby').classList.remove('hidden')
  lastBytes = { sent: 0, recv: 0, t: 0 }
}

// ---------- Arayüz ----------
const colorOf = s => {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 45% 32%)`
}

function makeRow(id) {
  const li = document.createElement('li')
  li.className = 'peer'
  li.id = 'peer-' + id
  li.innerHTML = `<div class="avatar"></div>
    <div><div class="pname"></div><div class="pmeta"><span class="ping"></span><span class="icons"></span></div></div>
    <input class="pvol" type="range" min="0" max="100" step="5" title="Ses seviyesi">`
  return li
}

function renderSelf() {
  let li = $('peer-self')
  if (!li) {
    li = makeRow('self')
    li.querySelector('.pvol').remove()
    $('peers').prepend(li)
  }
  li.querySelector('.avatar').textContent = (S.name[0] || '?').toUpperCase()
  li.querySelector('.avatar').style.background = colorOf(S.name)
  li.querySelector('.pname').textContent = S.name + ' (sen)'
  li.querySelector('.icons').textContent = (muted ? '🔇 ' : '') + (deaf ? '🙉' : '')
}

function renderPeer(p) {
  if (!p.el) {
    p.el = makeRow(p.id)
    const vol = p.el.querySelector('.pvol')
    vol.oninput = () => { S.vols[p.name] = +vol.value; applyVolume(p); save() }
    $('peers').appendChild(p.el)
  }
  const el = p.el
  el.querySelector('.avatar').textContent = (p.name[0] || '?').toUpperCase()
  el.querySelector('.avatar').style.background = colorOf(p.name)
  el.querySelector('.pname').textContent = p.name
  const vol = el.querySelector('.pvol')
  if (document.activeElement !== vol) vol.value = S.vols[p.name] ?? 100
  const ping = el.querySelector('.ping')
  if (p.ping != null) {
    ping.textContent = p.ping + ' ms'
    ping.className = 'ping ' + (p.ping < 80 ? 'good' : p.ping < 180 ? 'mid' : 'bad')
  } else {
    ping.textContent = p.audio ? 'bağlı' : 'bağlanıyor…'
    ping.className = 'ping'
  }
  el.querySelector('.icons').textContent = (p.muted ? '🔇 ' : '') + (p.deaf ? '🙉' : '')
}

function updateStatus(up, down) {
  const n = peers.size
  let t = n === 0
    ? 'Odada şimdilik yalnızsın. “Davet linki” ile arkadaşlarını çağır.'
    : `Bağlı · ${n + 1} kişi`
  if (n > 0 && up != null) t += ` · ↑ ${up.toFixed(0)} kbps · ↓ ${down.toFixed(0)} kbps`
  $('status').textContent = t
}

function updateControls() {
  $('mute').classList.toggle('off', muted)
  $('mute').querySelector('span').textContent = muted ? 'Kapalı' : 'Mikrofon'
  $('deafen').classList.toggle('off', deaf)
  $('deafen').querySelector('span').textContent = deaf ? 'Sağır' : 'Kulaklık'
  $('ptt-hold').classList.toggle('hidden', S.mode !== 'ptt')
  $('ptt-hold').classList.toggle('on', pttDown)
  $('vad-wrap').classList.toggle('hidden', S.mode !== 'vad')
  $('ptt-wrap').classList.toggle('hidden', S.mode !== 'ptt')
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
  const s = $('status')
  if (!s) return
  s.textContent = '⚠ ' + msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => updateStatus(), 6000)
}

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
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ')
}

function initSettings() {
  $('mode').value = S.mode
  $('threshold').value = S.threshold
  $('thr-val').textContent = S.threshold
  $('in-gain').value = S.gain
  $('gain-val').textContent = S.gain
  $('quality').value = String(S.quality)
  $('noise').checked = S.noise
  $('sounds').checked = S.sounds
  $('ptt-key').textContent = keyName(S.pttKey)
  $('turn-url').value = S.turnUrl
  $('turn-user').value = S.turnUser
  $('turn-pass').value = S.turnPass
  const thrMark = () => ($('meter-thr').style.left = ((S.threshold + 90) / 90 * 100) + '%')
  thrMark()

  $('mode').onchange = e => { S.mode = e.target.value; save(); setPtt(false); pushGate(); updateControls() }
  $('threshold').oninput = e => { S.threshold = +e.target.value; $('thr-val').textContent = S.threshold; thrMark(); save(); pushGate() }
  $('in-gain').oninput = e => { S.gain = +e.target.value; $('gain-val').textContent = S.gain; save(); pushGate() }
  $('quality').onchange = e => { S.quality = +e.target.value; save(); tickStats() }
  $('noise').onchange = e => { S.noise = e.target.checked; save(); switchMic() }
  $('sounds').onchange = e => { S.sounds = e.target.checked; save() }
  $('mic-select').onchange = e => { S.mic = e.target.value; save(); switchMic() }
  $('out-select').onchange = e => { S.out = e.target.value; save(); peers.forEach(p => p.audio && applySink(p.audio)) }
  for (const k of ['turn-url', 'turn-user', 'turn-pass']) {
    $(k).onchange = () => {
      S.turnUrl = $('turn-url').value; S.turnUser = $('turn-user').value; S.turnPass = $('turn-pass').value; save()
    }
  }

  let capturing = false
  $('ptt-key').onclick = () => { capturing = true; $('ptt-key').textContent = 'Bir tuşa bas…' }
  window.addEventListener('keydown', e => {
    if (capturing) {
      e.preventDefault(); capturing = false
      S.pttKey = e.code; save()
      $('ptt-key').textContent = keyName(e.code)
      $('ptt-key').blur()
      return
    }
    if (!room || e.repeat) return
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName)
    if (S.mode === 'ptt' && e.code === S.pttKey && !typing) { e.preventDefault(); return setPtt(true) }
    if (typing) return
    if (e.code === 'KeyM') setMuted(!muted)
    if (e.code === 'KeyD') setDeaf(!deaf)
  })
  window.addEventListener('keyup', e => { if (e.code === S.pttKey) setPtt(false) })
  window.addEventListener('blur', () => setPtt(false))

  const hold = $('ptt-hold')
  hold.addEventListener('pointerdown', e => { hold.setPointerCapture(e.pointerId); setPtt(true) })
  hold.addEventListener('pointerup', () => setPtt(false))
  hold.addEventListener('pointercancel', () => setPtt(false))

  $('mute').onclick = () => setMuted(!muted)
  $('deafen').onclick = () => setDeaf(!deaf)
  $('leave').onclick = leave
  $('copy-link').onclick = async () => {
    const url = location.origin + location.pathname + '#oda=' + encodeURIComponent(S.room)
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

async function initUpdates() {
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
initUpdates()
