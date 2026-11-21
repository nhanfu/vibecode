interface SpeechResultItem {
  transcript: string
}

interface SpeechResultEvent {
  resultIndex: number
  results: ArrayLike<ArrayLike<SpeechResultItem> & { isFinal: boolean }>
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechResultEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function recognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const VOICE_LANG = 'vi-VN'

export const voiceSupported = (): boolean => recognitionCtor() !== null

export interface Dictation {
  stop(): void
}

export function startDictation(opts: {
  lang: string
  onFinal: (text: string) => void
  onInterim: (text: string) => void
  onEnd: (error: string | null) => void
}): Dictation | null {
  const Ctor = recognitionCtor()
  if (!Ctor) return null
  const rec = new Ctor()
  rec.lang = opts.lang
  rec.continuous = true
  rec.interimResults = true
  let error: string | null = null
  rec.onresult = (e) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) opts.onFinal(r[0].transcript)
      else interim += r[0].transcript
    }
    opts.onInterim(interim)
  }
  rec.onerror = (e) => {
    error = e.error
  }
  rec.onend = () => opts.onEnd(error)
  rec.start()
  return { stop: () => rec.stop() }
}
