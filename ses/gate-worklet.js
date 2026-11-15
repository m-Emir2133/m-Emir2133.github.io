// Ses kapısı (noise gate) — ses iş parçacığında çalışır, sekme arka plandayken de kısılmaz.
// Modlar: 'vad' (sesle aktif), 'ptt' (bas-konuş), 'open' (hep açık)
class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.mode = 'vad'
    this.threshold = -50 // dBFS
    this.ptt = false
    this.muted = false
    this.inputGain = 1
    this.gain = 0
    this.holdUntil = 0
    this.lastPost = 0
    this.peak = -100
    this.port.onmessage = e => Object.assign(this, e.data)
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const out = outputs[0][0]
    if (!out) return true
    const ch = input && input[0]
    if (!ch) {
      out.fill(0)
      return true
    }

    let sum = 0
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i]
    const rms = Math.sqrt(sum / ch.length) * this.inputGain
    const db = rms > 0 ? 20 * Math.log10(rms) : -100
    if (db > this.peak) this.peak = db

    const now = currentTime
    let open
    if (this.muted) open = false
    else if (this.mode === 'open') open = true
    else if (this.mode === 'ptt') open = this.ptt
    else {
      if (db > this.threshold) this.holdUntil = now + 0.35
      open = now < this.holdUntil
    }

    // Yumuşak açılış/kapanış (tık sesi olmasın)
    const target = open ? 1 : 0
    const step = open ? 0.25 : 0.02
    for (let i = 0; i < ch.length; i++) {
      this.gain += (target - this.gain) * step
      out[i] = ch[i] * this.gain * this.inputGain
    }

    if (now - this.lastPost > 0.05) {
      this.port.postMessage({ level: this.peak, open })
      this.peak = -100
      this.lastPost = now
    }
    return true
  }
}

registerProcessor('gate', GateProcessor)
