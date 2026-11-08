import React, { Component, ErrorInfo, ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AppProvider } from './lib/AppContext'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class RootErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('RootErrorBoundary caught error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '24px',
          color: '#f9fafb',
          backgroundColor: '#0a0a0f',
          minHeight: '100vh',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '3rem', marginBottom: '16px' }}>⚠️</div>
          <h2 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>Er is een fout opgetreden bij het laden</h2>
          <p style={{ color: '#ef4444', marginBottom: '20px', maxWidth: '400px', fontSize: '0.9rem', wordBreak: 'break-word' }}>
            {this.state.error?.message || 'Onbekende fout tijdens initialisatie'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '12px 24px',
              backgroundColor: '#6366f1',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Herladen
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <AppProvider>
        <App />
      </AppProvider>
    </RootErrorBoundary>
  </React.StrictMode>
)

