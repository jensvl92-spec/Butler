import React, { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../lib/AppContext'
import { processHASync } from '../utils/ha-api'

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
      // Trim whitespace from inputs
      // Also clean the URL to remove trailing slashes or subpaths like /lovelace
      // Example: https://ha.com/lovelace -> https://ha.com
      let cleanUrl = apiUrl.trim()
      try {
        const urlObj = new URL(cleanUrl)
        cleanUrl = `${urlObj.protocol}//${urlObj.host}`
      } catch (e) {
        // invalid url, keep as is
      }

      // Trim whitespace and remove invisible characters/non-ascii
      // "RequestInit: String contains non ISO-8859-1 code point" implies bad chars
      const trimmedToken = apiToken.trim().replace(/[^\x00-\x7F]/g, "")

      // Note: We skip the connection test here because direct browser requests 
      // to Home Assistant fail due to CORS. The connection will be validated 
      // when actually used through the Vite proxy.

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

      if (dbError) throw dbError

      addConnection(data[0])

      // 🔄 Trigger Initial Sync
      // We do this immediately so the user sees results
      try {
        await processHASync(data[0].id, cleanUrl, trimmedToken, user.id)
      } catch (syncErr) {
        // User can manually re-sync later (feature to be added) or it will work next time.

        // Check for likely CORS error (TypeError: Failed to fetch is the standard CORS error message in Chrome)
        if (syncErr instanceof TypeError && syncErr.message === 'Failed to fetch') {
          setError(`Connection saved, but HA refused connection (CORS). Please add "${window.location.origin}" to your HA configuration.yaml (http: cors_allowed_origins).`)
        } else {
          console.error('Initial sync failed', syncErr)
        }
      }

      setName('')
      setApiUrl('')
      setApiToken('')
      onConnectionAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
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
