import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import { App } from './App'
import { initLanguage } from './lib/i18n'
import { ToastProvider } from './lib/toast'
import './index.css'

// 在渲染前恢复上次选择的语言，避免首帧闪一下默认语言
const lang = initLanguage()
document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      storageKey="blocknexus-theme"
      disableTransitionOnChange
    >
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
)
