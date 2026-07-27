import { Suspense, lazy } from 'react'
import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import HubPage from './pages/HubPage.jsx'

const SttPage = lazy(() => import('./pages/SttPage.jsx'))
const AnalyzePage = lazy(() => import('./pages/AnalyzePage.jsx'))
const QaPage = lazy(() => import('./pages/QaPage.jsx'))
const VocPage = lazy(() => import('./pages/VocPage.jsx'))
const SearchPage = lazy(() => import('./pages/SearchPage.jsx'))
const AboutPage = lazy(() => import('./pages/AboutPage.jsx'))

function lazyRoute(element) {
  return <Suspense fallback={<p className="page-loading">불러오는 중...</p>}>{element}</Suspense>
}

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HubPage />} />
        <Route path="/stt" element={lazyRoute(<SttPage />)} />
        <Route path="/analyze" element={lazyRoute(<AnalyzePage />)} />
        <Route path="/qa" element={lazyRoute(<QaPage />)} />
        <Route path="/voc" element={lazyRoute(<VocPage />)} />
        <Route path="/search" element={lazyRoute(<SearchPage />)} />
        <Route path="/about" element={lazyRoute(<AboutPage />)} />
      </Route>
    </Routes>
  )
}

export default App
