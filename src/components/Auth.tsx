import React, { useState } from 'react'
import { signIn, signUp, signInWithGoogle } from '../utils/auth'

interface AuthProps {
  onAuthSuccess: () => void
}

export function Auth({ onAuthSuccess }: AuthProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState('')
  const [infoMessage, setInfoMessage] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setInfoMessage('')
    setLoading(true)

    try {
      const result = isSignUp ? await signUp(email, password) : await signIn(email, password)

      if (result.error) {
        setError(result.error.message)
      } else if (isSignUp && !result.data?.session) {
        setInfoMessage('✅ Account aangemaakt! Controleer je e-mail om je account te bevestigen voordat je inlogt.')
      } else {
        onAuthSuccess()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Er trad een fout op')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleSignIn = async () => {
    if (loading) return
    setError('')
    setInfoMessage('')
    setLoading(true)
    try {
      const { error: googleErr } = await signInWithGoogle()
      if (googleErr) {
        setError(googleErr.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google login mislukt')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>⚡ Butler</h1>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="E-mailadres"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Wachtwoord"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Bezig...' : isSignUp ? 'Account aanmaken' : 'Inloggen'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        {infoMessage && <p style={{ color: '#10b981', fontSize: '0.88rem', marginTop: '8px' }}>{infoMessage}</p>}

        <div style={{ display: 'flex', alignItems: 'center', margin: '16px 0', gap: '8px' }}>
          <hr style={{ flex: 1, border: 'none', borderTop: '1px solid #374151' }} />
          <span style={{ color: '#9ca3af', fontSize: '12px' }}>OF</span>
          <hr style={{ flex: 1, border: 'none', borderTop: '1px solid #374151' }} />
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={handleGoogleSignIn}
          style={{
            backgroundColor: '#fff',
            color: '#333',
            border: '1px solid #ddd',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            marginBottom: '16px',
            cursor: loading ? 'wait' : 'pointer'
          }}
        >
          Doorgaan met Google
        </button>

        <button className="toggle-auth" type="button" onClick={() => { setIsSignUp(!isSignUp); setError(''); setInfoMessage(''); }}>
          {isSignUp ? 'Heb je al een account? Log in' : 'Nog geen account? Registreer'}
        </button>
      </div>
    </div>
  )
}
