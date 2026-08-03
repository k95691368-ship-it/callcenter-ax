import { useEffect, useRef, useState } from 'react'

// 마이크 녹음 (MediaRecorder) — 평가자가 파일 준비 없이 그 자리에서 시연할 수 있게 한다.
// /stt와 /pipeline이 같은 훅을 공유한다.

// 녹음 상한 — 넘으면 자동 정지한다. 없으면 켜둔 채 잊은 녹음이 서버 입력 한도를
// 넘길 만큼 커진 뒤에야 413으로 거부된다.
export const MAX_RECORD_SECONDS = 300

export function useRecorder({ onDone, onError }) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef(null)
  const timerRef = useRef(null)
  const streamRef = useRef(null)
  const unmountedRef = useRef(false)
  // 콜백을 ref에 미러링한다 — onstop이 start() 시점의 콜백을 붙잡고 있으면
  // 그 뒤 렌더의 상태를 읽는 콜백으로 바뀔 때 조용히 어긋난다.
  const doneRef = useRef(onDone)
  const errorRef = useRef(onError)
  doneRef.current = onDone
  errorRef.current = onError

  useEffect(
    () => () => {
      unmountedRef.current = true
      clearInterval(timerRef.current)
      const rec = recorderRef.current
      if (rec?.state === 'recording') {
        // onstop을 먼저 끊는다. 그대로 두면 페이지를 떠난 뒤에 onDone이 발화해
        // 파이프라인(STT·화자분리·분석·QA 4개 유료 호출)이 보이지 않는 화면을 위해 실행된다.
        rec.onstop = null
        try {
          rec.stop()
        } catch {
          /* 이미 정지된 경우 무시 */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    },
    []
  )

  async function start() {
    let stream = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        clearInterval(timerRef.current)
        setRecording(false)
        if (unmountedRef.current) return
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        const ext = (rec.mimeType || 'audio/webm').includes('ogg') ? 'ogg' : 'webm'
        doneRef.current(new File([blob], `마이크 녹음.${ext}`, { type: blob.type }))
      }
      recorderRef.current = rec
      rec.start()
      setSeconds(0)
      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          const next = s + 1
          if (next >= MAX_RECORD_SECONDS) {
            clearInterval(timerRef.current)
            try {
              rec.stop()
            } catch {
              /* 이미 정지 */
            }
          }
          return next
        })
      }, 1000)
      setRecording(true)
    } catch (err) {
      // MediaRecorder 생성 실패(일부 iOS·구형 브라우저)도 여기로 온다.
      // 스트림을 정리하지 않으면 탭의 마이크 표시가 계속 켜진 채 남는다.
      stream?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
      errorRef.current(
        denied
          ? '마이크 권한이 필요합니다. 브라우저 주소창의 권한 요청을 허용해주세요.'
          : `마이크를 사용할 수 없습니다. (${err?.name || '알 수 없는 오류'}) 파일 업로드로 시도해주세요.`
      )
    }
  }

  function stop() {
    try {
      recorderRef.current?.stop()
    } catch {
      /* 이미 정지된 경우 무시 */
    }
  }

  return { recording, seconds, start, stop, maxSeconds: MAX_RECORD_SECONDS }
}
