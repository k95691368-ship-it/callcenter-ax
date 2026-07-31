import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { MENU } from '../src/components/Layout.jsx'

// App.jsx는 lazy(() => import(...))로 페이지를 불러오므로 node 환경에서 그대로 import하면
// JSX 모듈 전체가 딸려온다. 여기서 확인하려는 것은 "경로 표와 링크가 어긋나지 않는가"뿐이라
// 소스에서 경로만 읽어 비교한다.
const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../src/components/Layout.jsx', import.meta.url), 'utf8')

const pagePaths = [...appSource.matchAll(/\{\s*path:\s*'([^']+)'/g)].map((m) => m[1])
const routable = new Set(['/', ...pagePaths])

describe('메뉴·푸터 링크가 실제 라우트를 가리킨다', () => {
  // 실제로 있었던 일: /guide는 페이지도 API도 제목도 메뉴 링크도 있었는데 Route만 빠져
  // 있었다. 상단 메뉴와 푸터의 그 링크를 누르면 404가 나왔다 — 기능을 만드는 것과
  // 사용자에게 닿는 것은 다른 일이다.
  it('경로 표에서 최소한 주요 페이지들이 읽힌다 (파싱이 조용히 실패하지 않게)', () => {
    expect(pagePaths.length).toBeGreaterThanOrEqual(8)
    expect(pagePaths).toContain('/voc')
  })

  it('상단 메뉴의 모든 링크에 대응하는 라우트가 있다', () => {
    const missing = MENU.map((m) => m.to).filter((to) => !routable.has(to))
    expect(missing).toEqual([])
  })

  it('푸터의 내부 링크도 모두 라우트가 있다', () => {
    const links = [...layoutSource.matchAll(/<Link to="(\/[^"]*)"/g)].map((m) => m[1])
    expect(links.length).toBeGreaterThan(0)
    expect(links.filter((to) => !routable.has(to))).toEqual([])
  })

  it('모든 라우트에 문서 제목이 붙는다 (제목 없는 페이지는 스크린리더에서 이동이 안 들린다)', () => {
    // 제목은 PAGES 표에서 파생되므로 title이 비어 있는 항목만 확인하면 된다
    const titles = [...appSource.matchAll(/\{\s*path:\s*'[^']+',\s*title:\s*'([^']*)'/g)].map((m) => m[1])
    expect(titles).toHaveLength(pagePaths.length)
    expect(titles.every((t) => t.trim().length > 0)).toBe(true)
  })
})
