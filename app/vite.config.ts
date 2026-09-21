import path from 'path'
import { execSync } from 'child_process'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'

function currentGitVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}

// 배포 시점의 커밋 해시를 dist/version.json에 기록한다.
// 앱이 주기적으로 이 파일을 no-store로 fetch해, 실행 중인 번들과 다르면
// 새 배포가 있다는 뜻이므로 자동으로 새로고침한다 (index.html의 10분
// HTTP 캐시 때문에 배포 후에도 옛 번들이 계속 로드되는 문제를 해결).
function versionFilePlugin(version: string): Plugin {
  return {
    name: 'version-file',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version, builtAt: new Date().toISOString() }),
      })
    },
  }
}

const appVersion = currentGitVersion()

// 🔧 [번들 분석 도구, 2026-09-21] ChatPage/AdminPage를 React.lazy로
// 분리(2.69MB → 599KB)한 이력이 있다 — 앞으로도 이런 판단을 감으로
// 하지 않고 데이터로 하기 위한 도구. 기본 빌드(npm run build, CI/배포)
// 에서는 전혀 동작하지 않고, ANALYZE=1 npm run build로 명시적으로 켰을
// 때만 dist/stats.html(gitignore된 dist/ 안이라 커밋되지 않음)을 만든다
// — 런타임 산출물(JS/CSS)에는 어떤 경우에도 영향을 주지 않는다.
const shouldAnalyze = process.env.ANALYZE === '1'

// https://vite.dev/config/
export default defineConfig({
  base: '/gongcam/',
  plugins: [
    react(),
    tailwindcss(),
    versionFilePlugin(appVersion),
    shouldAnalyze &&
      visualizer({
        filename: 'dist/stats.html',
        gzipSize: true,
        brotliSize: true,
        template: 'treemap',
      }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
})
