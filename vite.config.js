import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // 앱 코드를 고쳐도 프레임워크 청크의 브라우저 캐시는 그대로 살아 있게 한다.
        // 지연 로드 페이지가 쓰는 패키지까지 끌어오지 않도록 프레임워크만 지정한다.
        manualChunks(id) {
          if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor'
          }
          return null
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8788',
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
})
