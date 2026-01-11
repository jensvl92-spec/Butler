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
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const result = isSignUp ? await signUp(email, password) : await signIn(email, password)

      if (result.error) {
        setError(result.error.message)
      } else {
        onAuthSuccess()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>Home Assistant AI</h1>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Sign In'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}

        <div style={{ display: 'flex', alignItems: 'center', margin: '16px 0', gap: '8px' }}>
          <hr style={{ flex: 1, border: 'none', borderTop: '1px solid #ddd' }} />
          <span style={{ color: '#666', fontSize: '12px' }}>OR</span>
          <hr style={{ flex: 1, border: 'none', borderTop: '1px solid #ddd' }} />
        </div>

        <button
          type="button"
          onClick={() => signInWithGoogle()}
          style={{
            backgroundColor: '#fff',
            color: '#333',
            border: '1px solid #ddd',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            marginBottom: '16px',
            cursor: 'pointer'
          }}
        >
          Google
        </button>

        <button className="toggle-auth" onClick={() => setIsSignUp(!isSignUp)}>
          {isSignUp ? 'Have an account? Sign In' : "Don't have an account? Sign Up"}
        </button>
      </div>
    </div>
  )
}
