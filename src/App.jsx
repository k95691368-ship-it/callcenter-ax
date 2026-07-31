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
const AboutPage = lazy(() => import('./pages/AboutPage.jsx'))

function lazyRoute(element) {
  return <Suspense fallback={<p className="page-loading">불러오는 중...</p>}>{element}</Suspense>
}

// SPA는 라우트를 옮겨도 index.html의 단일 title이 그대로 남아, 스크린리더가 페이지가
// 바뀐 사실을 알리지 못한다. 경로가 늘 때 제목도 함께 늘도록 라우트 표 옆에 둔다.
const ROUTE_TITLES = {
  '/': '콜센터 AX 워크벤치 — STT·LLM·RAG·Auto QA 포트폴리오',
  '/pipeline': '전체 파이프라인 원클릭 시연 · 콜센터 AX 워크벤치',
  '/stt': '녹취 전사 (Whisper STT) · 콜센터 AX 워크벤치',
  '/analyze': '통화 분석 (분류·요약·감정) · 콜센터 AX 워크벤치',
  '/qa': '상담 품질 평가 (Auto QA) · 콜센터 AX 워크벤치',
  '/voc': 'VOC 대시보드 · 콜센터 AX 워크벤치',
  '/search': 'RAG 상담 지식 검색 · 콜센터 AX 워크벤치',
  '/assist': '실시간 상담 지원 (Agent Assist) · 콜센터 AX 워크벤치',
  '/about': '제작기 · 채용공고 매핑 · 콜센터 AX 워크벤치',
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
        <Route path="/pipeline" element={lazyRoute(<PipelinePage />)} />
        <Route path="/stt" element={lazyRoute(<SttPage />)} />
        <Route path="/analyze" element={lazyRoute(<AnalyzePage />)} />
        <Route path="/qa" element={lazyRoute(<QaPage />)} />
        <Route path="/voc" element={lazyRoute(<VocPage />)} />
        <Route path="/search" element={lazyRoute(<SearchPage />)} />
        <Route path="/assist" element={lazyRoute(<AssistPage />)} />
        <Route path="/about" element={lazyRoute(<AboutPage />)} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

export default App
