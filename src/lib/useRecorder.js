import { useEffect, useRef, useState } from 'react'

// 마이크 녹음 (MediaRecorder) — 심사자가 파일 준비 없이 그 자리에서 시연할 수 있게 한다.
// /stt와 /pipeline이 같은 훅을 공유한다.
export function useRecorder({ onDone, onError }) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => () => {
    clearInterval(timerRef.current)
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }, [])

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        clearInterval(timerRef.current)
        setRecording(false)
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        const ext = (rec.mimeType || 'audio/webm').includes('ogg') ? 'ogg' : 'webm'
        onDone(new File([blob], `마이크 녹음.${ext}`, { type: blob.type }))
      }
      recorderRef.current = rec
      rec.start()
      setSeconds(0)
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
      setRecording(true)
    } catch {
      onError('마이크 권한이 필요합니다. 브라우저 주소창의 권한 요청을 허용해주세요.')
    }
  }

  function stop() {
    recorderRef.current?.stop()
  }

  return { recording, seconds, start, stop }
}
