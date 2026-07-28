import { Suspense, lazy } from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import HubPage from './pages/HubPage.jsx'

const PipelinePage = lazy(() => import('./pages/PipelinePage.jsx'))
const SttPage = lazy(() => import('./pages/SttPage.jsx'))
const AnalyzePage = lazy(() => import('./pages/AnalyzePage.jsx'))
const QaPage = lazy(() => import('./pages/QaPage.jsx'))
const VocPage = lazy(() => import('./pages/VocPage.jsx'))
const SearchPage = lazy(() => import('./pages/SearchPage.jsx'))
const AboutPage = lazy(() => import('./pages/AboutPage.jsx'))

function lazyRoute(element) {
  return <Suspense fallback={<p className="page-loading">불러오는 중...</p>}>{element}</Suspense>
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
        <Route path="/about" element={lazyRoute(<AboutPage />)} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

export default App
