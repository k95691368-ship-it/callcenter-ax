import { useState } from 'react'

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
  const set = (v) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? v(prev) : v
      savePersisted(key, next)
      return next
    })
  }
  return [value, set]
}
