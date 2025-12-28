import React, { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../lib/AppContext'
import { processHASync } from '../utils/ha-api'

// @ts-ignore
import { logger } from '../utils/logger'

interface ConnectionSetupProps {
  onConnectionAdded: () => void
}

export function ConnectionSetup({ onConnectionAdded }: ConnectionSetupProps) {
  const { user, addConnection } = useApp()
  const [name, setName] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      // Trim whitespace and handle full browser URLs
      let cleanUrl = apiUrl.trim()
      try {
        const urlObj = new URL(cleanUrl)
        // FORCE the URL to be just protocol + host + port
        // This strips /config/dashboard, /lovelace, etc. automatically
        // e.g. https://ha.com:8123/config/dashboard -> https://ha.com:8123
        cleanUrl = urlObj.origin
      } catch (e) {
        // Invalid URL, let it fail naturally later or keep raw input
      }

      // SMART TOKEN EXTRACTION
      // Users often copy labels like "Token: eyJ..." or "Long-Lived Access Token: eyJ..."
      // HA tokens are JWTs starting with 'eyJ' and are ~183 chars
      // Extract just the token part using regex
      const jwtMatch = apiToken.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
      const extractedToken = jwtMatch ? jwtMatch[0] : apiToken

      // Then sanitize: remove ALL whitespace and non-ASCII
      const trimmedToken = extractedToken.replace(/\s/g, '').replace(/[^\x00-\x7F]/g, "")

      // Note: We skip the connection test here because direct browser requests 
      // to Home Assistant fail due to CORS. The connection will be validated 
      // when actually used through the Vite proxy.

      // VERIFY AUTHENTICATION (Pre-flight)
      try {
        logger.info(`Testing Connection: ${cleanUrl}`)
        const testRes = await fetch(`${cleanUrl}/api/`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${trimmedToken}`,
            'Content-Type': 'application/json'
          }
        })

        if (testRes.status === 401) {
          throw new Error('❌ Authentication Failed: Invalid Token. Please verify your Long-Lived Access Token.')
        }

        if (testRes.ok) {
          logger.info('✅ Connection Verified!')
        }
      } catch (testErr: any) {
        // ERROR HANDLING UPGRADE:
        if (testErr.message.includes('Authentication Failed')) {
          throw testErr
        }

        // 2. Network / DNS / Host Unreachable Error
        logger.warn('Connection Test Failed (non-fatal):', testErr)
        // LEGACY BEHAVIOR RESTORED:
        if (confirm('Connection test failed (possibly due to CORS or local network). Save anyway?')) {
          // proceed
        } else {
          throw new Error(`❌ Network Error: Could not reach server. \nCheck: \n1. Is your phone on the same WiFi? \n2. Does your router block loopback? (Try 192.168.x.x) \n3. Is the URL correct?`)
        }
      }

      // Save connection to database
      const { data, error: dbError } = await supabase
        .from('ha_connections')
        .insert({
          user_id: user.id,
          name: name.trim(),
          api_url: cleanUrl,
          api_token: trimmedToken,
        })
        .select()

      if (dbError) {
        logger.error('Failed to insert connection', dbError)
        throw dbError
      }

      addConnection(data[0])

      // 🔄 Trigger Initial Sync
      try {
        await processHASync(data[0].id, cleanUrl, trimmedToken, user.id)
      } catch (syncErr: any) {
        // Check for likely CORS error (TypeError: Failed to fetch is the standard CORS error message in Chrome)
        if (syncErr instanceof TypeError && syncErr.message === 'Failed to fetch') {
          setError(`Connection saved, but HA refused connection (CORS). Please add "${window.location.origin}" to your HA configuration.yaml (http: cors_allowed_origins).`)
          logger.warn('Initial Sync CORS Error', { origin: window.location.origin })
        } else {
          logger.error('Initial sync failed', syncErr)
        }
      }

      setName('')
      setApiUrl('')
      setApiToken('')
      onConnectionAdded()
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : 'An error occurred'
      setError(msg)
      logger.error('Connection Setup Failed', { error: msg, stack: err.stack })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="setup-container">
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Connection Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          type="url"
          placeholder="Home Assistant URL (e.g., http://192.168.1.100:8123)"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          required
        />
        {apiUrl.includes('.local') && (
          <p style={{ color: 'orange', fontSize: '0.8rem', marginTop: '4px' }}>
            ⚠️ Android often fails to resolve <b>.local</b> domains. Please use the <b>IP Address</b> (e.g. 192.168.1.x) if connection fails.
          </p>
        )}
        <input
          type="password"
          placeholder="Long-Lived Access Token"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Connecting...' : 'Connect'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
