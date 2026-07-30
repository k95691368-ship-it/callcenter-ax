import { useRef, useState } from 'react'

// 커스텀 설정(QA 체크리스트·도메인 사전·내 문서)을 브라우저에만 보관한다.
// 서버 미저장 원칙 유지 — 시크릿 모드 등 저장 불가 환경에서도 기능은 그대로 동작.

export function loadPersisted(key, initial) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return initial
    const parsed = JSON.parse(raw)
    return parsed == null ? initial : parsed
  } catch {
    return initial
  }
}

export function savePersisted(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 저장 실패는 무시 — 기능 흐름을 막지 않는다
  }
}

export function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => loadPersisted(key, initial))
  // 저장은 updater 밖에서 한다. React는 updater를 순수 함수로 보고 StrictMode에서
  // 두 번 호출하므로, 안에서 localStorage를 쓰면 부수효과가 중복 실행된다.
  const latest = useRef(value)
  latest.current = value
  const set = (v) => {
    const next = typeof v === 'function' ? v(latest.current) : v
    latest.current = next
    setValue(next)
    savePersisted(key, next)
  }
  return [value, set]
}
