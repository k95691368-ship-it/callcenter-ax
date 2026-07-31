import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

// 클래스 이름은 대부분 "이름표"라 CSS가 없어도 화면이 깨지지 않는다.
// 그런데 sr-only는 다르다 — **정의되지 않으면 기능이 반대로 동작한다.**
// 숨기라고 붙인 클래스에 규칙이 없으면 그 텍스트가 화면에 그대로 노출된다.
// 실제로 /guide의 aria-live 안내문("녹취 고지")이 진행바 아래에 낱말로 떠 있었다.
//
// 그래서 "모든 클래스에 CSS가 있어야 한다"가 아니라, **없으면 깨지는 클래스만** 검사한다.

const cssText = ['src/App.css', 'src/index.css']
  .map((p) => {
    try {
      return readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
    } catch {
      return ''
    }
  })
  .join('\n')

function sourceFiles() {
  const out = []
  for (const dir of ['../src/pages', '../src/components']) {
    const base = new URL(`${dir}/`, import.meta.url)
    for (const name of readdirSync(base)) {
      if (name.endsWith('.jsx')) out.push({ name, text: readFileSync(new URL(name, base), 'utf8') })
    }
  }
  return out
}

describe('sr-only — 정의되지 않으면 숨기려던 텍스트가 노출된다', () => {
  const files = sourceFiles()
  const users = files.filter((f) => /className="[^"]*\bsr-only\b/.test(f.text))

  it('sr-only를 쓰는 화면이 존재한다 (이 테스트가 헛돌지 않는지 확인)', () => {
    expect(users.length).toBeGreaterThan(0)
  })

  it('CSS에 .sr-only 규칙이 정의돼 있다', () => {
    expect(cssText).toMatch(/\.sr-only\s*\{/)
  })

  it('화면에서 실제로 사라지는 방식으로 정의돼 있다 (display:none이면 스크린리더도 못 읽는다)', () => {
    const block = cssText.match(/\.sr-only\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(block).toMatch(/position:\s*absolute/)
    expect(block).toMatch(/clip:/)
    // display:none·visibility:hidden으로 숨기면 보조기술도 읽지 못한다
    expect(block).not.toMatch(/display:\s*none/)
    expect(block).not.toMatch(/visibility:\s*hidden/)
  })
})
