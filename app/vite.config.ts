import path from 'path'
import { execSync } from 'child_process'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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

// https://vite.dev/config/
export default defineConfig({
  base: '/gongcam/',
  plugins: [react(), tailwindcss(), versionFilePlugin(appVersion)],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
})
