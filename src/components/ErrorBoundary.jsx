import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <h2>화면을 표시하는 중 문제가 발생했습니다</h2>
          <p>일시적인 오류일 수 있습니다. 아래 버튼으로 다시 시도해주세요.</p>
          <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
