import { Suspense, lazy, useEffect } from 'react'
import { Routes, Route, Link, useLocation, useNavigationType } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import HubPage from './pages/HubPage.jsx'
import { scrollPageToTop } from './components/motion.js'

const PipelinePage = lazy(() => import('./pages/PipelinePage.jsx'))
const SttPage = lazy(() => import('./pages/SttPage.jsx'))
const AnalyzePage = lazy(() => import('./pages/AnalyzePage.jsx'))
const QaPage = lazy(() => import('./pages/QaPage.jsx'))
const VocPage = lazy(() => import('./pages/VocPage.jsx'))
const SearchPage = lazy(() => import('./pages/SearchPage.jsx'))
const AssistPage = lazy(() => import('./pages/AssistPage.jsx'))
const GuidePage = lazy(() => import('./pages/GuidePage.jsx'))
const AboutPage = lazy(() => import('./pages/AboutPage.jsx'))

function lazyRoute(element) {
  return <Suspense fallback={<p className="page-loading">불러오는 중...</p>}>{element}</Suspense>
}

// 경로 표 — 라우트·제목·메뉴가 모두 여기서 파생된다.
//
// 예전에는 셋이 따로 적혀 있었다. 그래서 /guide는 페이지도 API도 제목도 메뉴 링크도
// 있는데 **Route만 빠져** 있었고, 상단 메뉴와 푸터의 그 링크를 누르면 404가 나왔다.
// 기능을 만드는 것과 사용자에게 닿는 것은 다른 일이다. 한 표에서 파생시키면 갈라질 수 없다.
export const PAGES = [
  { path: '/pipeline', title: '전체 파이프라인 원클릭 시연', component: PipelinePage },
  { path: '/stt', title: '녹취 전사 (Whisper STT)', component: SttPage },
  { path: '/analyze', title: '통화 분석 (분류·요약·감정)', component: AnalyzePage },
  { path: '/qa', title: '상담 품질 평가 (Auto QA)', component: QaPage },
  { path: '/voc', title: 'VOC 대시보드', component: VocPage },
  { path: '/search', title: 'RAG 상담 지식 검색', component: SearchPage },
  { path: '/assist', title: '실시간 상담 지원 (Agent Assist)', component: AssistPage },
  { path: '/guide', title: '통화 중 스크립트 가이드', component: GuidePage },
  { path: '/about', title: '제작기 · 채용공고 매핑', component: AboutPage },
]

// SPA는 라우트를 옮겨도 index.html의 단일 title이 그대로 남아, 스크린리더가 페이지가
// 바뀐 사실을 알리지 못한다.
const SUFFIX = '콜센터 AX 워크벤치'
const ROUTE_TITLES = {
  '/': `${SUFFIX} — STT·LLM·RAG·Auto QA 포트폴리오`,
  ...Object.fromEntries(PAGES.map((p) => [p.path, `${p.title} · ${SUFFIX}`])),
}
const NOT_FOUND_TITLE = '페이지를 찾을 수 없습니다 · 콜센터 AX 워크벤치'

function useRouteChrome() {
  const { pathname } = useLocation()
  const navType = useNavigationType()
  useEffect(() => {
    // /analyze/ 처럼 끝에 슬래시가 붙어도 라우트는 매칭된다. 정규화하지 않으면 정상
    // 페이지에 "찾을 수 없습니다" 제목이 붙는다.
    const key = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
    document.title = ROUTE_TITLES[key] || NOT_FOUND_TITLE
    // 뒤로가기(POP)에서는 스크롤을 건드리지 않는다. 브라우저가 복원한 위치를 덮어쓰면
    // 긴 페이지(VOC 대시보드·제작기)에서 읽던 자리를 매번 잃는다.
    if (navType !== 'POP') scrollPageToTop()
  }, [pathname, navType])
}

function NotFound() {
  return (
    <div className="tool-page notfound">
      <header className="tool-header">
        <span className="tool-tag">404</span>
        <h1>페이지를 찾을 수 없습니다</h1>
        <p>주소가 바뀌었거나 잘못 입력됐을 수 있어요.</p>
      </header>
      <div className="hub-cta notfound-cta">
        <Link to="/" className="btn-primary">홈으로</Link>
        <Link to="/pipeline" className="btn-ghost">파이프라인 시연 보기</Link>
      </div>
    </div>
  )
}

function App() {
  useRouteChrome()
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HubPage />} />
        {PAGES.map(({ path, component: Page }) => (
          <Route key={path} path={path} element={lazyRoute(<Page />)} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

export default App
