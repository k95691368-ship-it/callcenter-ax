// 서버는 상한을 넘는 입력을 조용히 앞부분만 남기고 자른다(analyze/qa 8000자, assist 4000자,
// search 질문 300자, 일괄 분석 통화당 2000자·5건 등). 화면에 아무 표시가 없으면 사용자는
// 뒷부분이 분석되지 않은 사실을 결과를 보고도 알 수 없다. 잘리기 전에 미리 알린다.

// 상한 안내의 공통 껍데기. 경고 문구를 담는 라이브 영역은 조건부로 붙이지 않고 항상
// DOM에 둔다 — 일부 스크린리더는 새로 삽입된 라이브 영역의 첫 내용을 읽지 않는다.
export function LimitNote({ children, warning }) {
  return (
    <p className={warning ? 'char-count over' : 'char-count'}>
      <span>{children}</span>
      <strong role="status">{warning ? ` ${warning}` : ''}</strong>
    </p>
  )
}

// 서버는 trim() 후 slice() 하므로 세는 기준도 trim 후 길이로 맞춘다 — 앞뒤 공백 때문에
// 화면 숫자와 실제 처리 길이가 어긋나면 경고 자체를 믿을 수 없게 된다.
export default function CharCount({ value, max, unit = '자' }) {
  const len = String(value || '').trim().length
  const fmt = (n) => n.toLocaleString('ko-KR')
  return (
    <LimitNote
      // 초과 글자 수를 문구에 넣으면 타이핑마다 문구가 바뀌어 스크린리더가 매 글자를
      // 다시 읽는다. 상한값만 담은 고정 문구로 두어 한 번만 읽히게 한다.
      warning={len > max ? `상한 초과 — 서버가 앞 ${fmt(max)}${unit}만 처리하고 뒷부분은 잘립니다.` : ''}
    >
      {fmt(len)} / {fmt(max)}
      {unit}
    </LimitNote>
  )
}
