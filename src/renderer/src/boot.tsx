import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles.css'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import * as actions from './actions'

// Handy from DevTools (Ctrl+Shift+I) and for scripted UI checks.
;(window as unknown as { __studio: unknown }).__studio = { useStore, actions }

// No StrictMode: double-mounted effects would start duplicate processes.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
