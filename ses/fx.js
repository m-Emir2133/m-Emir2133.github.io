// Ateşten yükselen kıvılcımlar. Çok hafif: ~45 parçacık, 30 fps,
// pencere gizliyken (ör. oyun tam ekranken) tamamen durur.
const canvas = document.getElementById('embers')
const g = canvas.getContext('2d')
let W = 0, H = 0, dpr = 1, parts = [], running = false, last = 0, raf = 0
let originY = 0.9 // kıvılcımların çıktığı yükseklik (ekran oranı)
let boost = 0

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  W = canvas.clientWidth; H = canvas.clientHeight
  canvas.width = W * dpr; canvas.height = H * dpr
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function spawn(initial) {
  const spread = Math.min(W * 0.18, 120)
  return {
    x: W / 2 + (Math.random() - 0.5) * spread,
    y: initial ? H * originY - Math.random() * H * 0.6 : H * originY + Math.random() * 20,
    vx: (Math.random() - 0.5) * 0.3,
    vy: -(0.5 + Math.random() * 1.1),
    r: 0.6 + Math.random() * 1.8,
    life: 0,
    max: 160 + Math.random() * 220,
    phase: Math.random() * Math.PI * 2,
    hue: 18 + Math.random() * 28
  }
}

function frame(t) {
  if (!running) return
  raf = requestAnimationFrame(frame)
  if (t - last < 33) return // ~30 fps yeter
  last = t
  g.clearRect(0, 0, W, H)
  g.globalCompositeOperation = 'lighter'
  const want = 45 + Math.round(boost * 25)
  while (parts.length < want) parts.push(spawn(false))
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    p.life++
    p.phase += 0.05
    p.x += p.vx + Math.sin(p.phase) * 0.35
    p.y += p.vy * (1 + boost * 0.6)
    const k = p.life / p.max
    if (k >= 1 || p.y < -10) {
      if (parts.length > want) parts.splice(i, 1)
      else parts[i] = spawn(false)
      continue
    }
    const a = Math.sin(Math.PI * k) * 0.9
    const r = p.r * (1 - k * 0.5)
    g.fillStyle = `hsla(${p.hue}, 100%, ${60 + 15 * (1 - k)}%, ${a})`
    g.beginPath(); g.arc(p.x, p.y, r, 0, 6.283); g.fill()
    g.fillStyle = `hsla(${p.hue}, 100%, 55%, ${a * 0.18})`
    g.beginPath(); g.arc(p.x, p.y, r * 4, 0, 6.283); g.fill()
  }
}

function start() {
  if (running || document.hidden) return
  running = true
  resize()
  if (!parts.length) for (let i = 0; i < 40; i++) parts.push(spawn(true))
  raf = requestAnimationFrame(frame)
}

function stop() {
  running = false
  cancelAnimationFrame(raf)
  g.clearRect(0, 0, W, H)
}

let enabled = false
export function setFx(on) {
  enabled = on && !matchMedia('(prefers-reduced-motion: reduce)').matches
  document.body.classList.toggle('lite', !on)
  enabled ? start() : stop()
}
// Kıvılcımların çıkış noktası: ateş öğesinin ekrandaki konumu
export function setOrigin(el) {
  if (!el) return
  const r = el.getBoundingClientRect()
  originY = Math.min(0.98, Math.max(0.2, (r.top + r.height * 0.6) / window.innerHeight))
}
// Biri konuşunca ateş canlanır (0..1)
export function setBoost(v) { boost = v }

window.addEventListener('resize', () => running && resize())
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop()
  else if (enabled) start()
})
