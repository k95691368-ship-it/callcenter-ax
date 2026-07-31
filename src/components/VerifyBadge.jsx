// 검증층이 "막았을 때"만 notice가 뜨고 통과했을 때는 화면에 아무 흔적이 남지 않으면,
// 심사자는 검증층이 존재하는지조차 알 수 없다. 통과했을 때도 실측 근거를 배지로 남긴다.
// 값이 없으면 아무것도 그리지 않는다 — 검증하지 않은 응답(데모·폴백)에 통과 배지가
// 붙어 과장이 되는 것을 막기 위해서다.

import { MAX_DIARIZE_CER } from '../lib/diarizeGuard.js'

export function VerifyBadge({ children, title }) {
  return (
    <span className="chip verify-chip" title={title}>
      ✓ {children}
    </span>
  )
}

// diarize 응답의 preserved_cer — 원문 보존 게이트를 통과한 경우의 실측 CER.
// 게이트가 막은 응답에는 이 필드가 없고 guarded/notice만 오므로 값 유무로 구분된다.
export function PreservedCerBadge({ cer }) {
  if (typeof cer !== 'number' || !Number.isFinite(cer)) return null
  return (
    <VerifyBadge
      title={`화자 분리 결과를 원문과 문자 단위로 대조한 실측 CER입니다. ${Math.round(
        MAX_DIARIZE_CER * 100
      )}%를 넘으면 분리 결과를 버리고 원문을 유지합니다 — 지시가 아니라 검증으로 확인한 수치입니다.`}
    >
      원문 보존 검증 통과 · CER {(cer * 100).toFixed(1)}%
    </VerifyBadge>
  )
}

// voc-report 응답의 numbers_verified — 리포트 속 숫자가 실제 집계(또는 파생 퍼센트)에
// 존재하는지 대조한 결과. false면 서버가 notice로 경고하므로 true일 때만 배지를 띄운다.
export function NumbersVerifiedBadge({ verified }) {
  if (verified !== true) return null
  return (
    <VerifyBadge title="리포트에 등장하는 모든 숫자를 위 집계 수치(및 그 파생 퍼센트)와 대조해 확인했습니다. 대조되지 않는 숫자가 있으면 통과 배지 대신 경고가 표시됩니다.">
      숫자 검증 통과
    </VerifyBadge>
  )
}
