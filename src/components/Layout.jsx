import { NavLink, Outlet, Link, useLocation } from 'react-router-dom'
import ErrorBoundary from './ErrorBoundary.jsx'

const MENU = [
  { to: '/', label: '홈', end: true },
  { to: '/stt', label: '녹취 전사' },
  { to: '/analyze', label: '통화 분석' },
  { to: '/qa', label: 'Auto QA' },
  { to: '/voc', label: 'VOC 대시보드' },
  { to: '/search', label: 'RAG 검색' },
  { to: '/about', label: '제작기' },
]

export default function Layout() {
  const location = useLocation()
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        본문으로 건너뛰기
      </a>
      <header className="topbar">
        <NavLink to="/" className="topbar-brand">
          <span className="topbar-logo">CC</span>
          콜센터 AX 워크벤치
        </NavLink>
        <nav className="topbar-nav">
          {MENU.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'topbar-link active' : 'topbar-link')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="app-main" id="main-content">
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <footer className="app-footer">
        <div className="footer-grid">
          <div className="footer-col">
            <p className="footer-title">파이프라인 바로가기</p>
            <Link to="/stt">녹취 전사 (Whisper STT)</Link>
            <Link to="/analyze">통화 분석 (분류·요약·감정)</Link>
            <Link to="/qa">상담 품질 평가 (Auto QA)</Link>
            <Link to="/voc">VOC 대시보드</Link>
            <Link to="/search">RAG 상담 지식 검색</Link>
          </div>
          <div className="footer-col">
            <p className="footer-title">이 포트폴리오</p>
            <p className="footer-text">
              콜센터 솔루션 기업의 "인공지능 융합" 직무(신입)를 위해 만든 취업 포트폴리오입니다.
              채용공고의 담당업무 — STT, LLM, NLP, RAG, Auto QA — 를 동작하는 파이프라인으로
              구현했습니다.
            </p>
          </div>
          <div className="footer-col">
            <p className="footer-title">기술 스택</p>
            <p className="footer-text">
              React 19 · Vite · Cloudflare Pages Functions · Workers AI (Whisper·bge-m3) ·
              Cloudflare D1 · Claude Opus 4.8 (tool 강제 호출로 구조화 응답)
            </p>
          </div>
        </div>
        <p className="footer-bottom">
          모든 통화·상담사·기업("한빛텔레콤")은 가상의 시나리오입니다 · 업로드 음성은 전사 후
          저장하지 않습니다
        </p>
      </footer>
    </div>
  )
}
