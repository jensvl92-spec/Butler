import React, { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../lib/AppContext'
import { processHASync } from '../utils/ha-api'
import { normalizeHAUrl, sanitizeHAToken, fetchWithTimeout } from '../utils/home-assistant'
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

    if (!user?.id) {
      setError('Je bent niet ingelogd. Log eerst opnieuw in.')
      return
    }

    setLoading(true)

    try {
      let rawUrl = apiUrl.trim()
      if (!/^https?:\/\//i.test(rawUrl)) {
        rawUrl = 'http://' + rawUrl
      }
      const cleanUrl = normalizeHAUrl(rawUrl)
      const trimmedToken = sanitizeHAToken(apiToken)

      if (!trimmedToken) {
        throw new Error('Vul een geldige Long-Lived Access Token in.')
      }

      // Pre-flight check with 8s timeout
      try {
        logger.info(`Testing Connection: ${cleanUrl}`)
        const testRes = await fetchWithTimeout(`${cleanUrl}/api/`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${trimmedToken}`,
            'Content-Type': 'application/json'
          }
        }, 8000)

        if (testRes.status === 401 || testRes.status === 403) {
          throw new Error('❌ Authenticatie mislukt (401/403): ongeldige Long-Lived Access Token.')
        }

        if (!testRes.ok) {
          throw new Error(`❌ Home Assistant gaf foutstatus HTTP ${testRes.status}. Controleer de URL.`)
        }

        logger.info('✅ Connection Verified!')
      } catch (testErr: any) {
        if (testErr?.message?.includes('❌')) {
          throw testErr
        }
        logger.warn('Connection Test Failed:', testErr)
        const proceed = window.confirm('Verbindingstest mislukt (mogelijk CORS of lokaal netwerk). Toch opslaan?')
        if (!proceed) {
          throw new Error('❌ Kon Home Assistant niet bereiken. Controleer WiFi/Tailscale en URL.')
        }
      }

      const { data, error: dbError } = await supabase
        .from('ha_connections')
        .insert({
          user_id: user.id,
          name: name.trim(),
          api_url: cleanUrl,
          api_token: trimmedToken,
        })
        .select()

      if (dbError || !data || data.length === 0) {
        logger.error('Failed to insert connection', dbError)
        throw dbError || new Error('Kon verbinding niet opslaan.')
      }

      addConnection(data[0])

      // Trigger Initial Sync (writes Dashboard-compatible deviceGroups tiles!)
      let hadCorsError = false
      try {
        await processHASync(data[0].id, cleanUrl, trimmedToken, user.id)
      } catch (syncErr: any) {
        if (syncErr instanceof TypeError && syncErr.message === 'Failed to fetch') {
          hadCorsError = true
          setError(`Verbinding opgeslagen, maar Home Assistant weigerde directe sync (CORS). Voeg "${window.location.origin}" toe aan cors_allowed_origins in configuration.yaml.`)
        } else {
          logger.error('Initial sync failed', syncErr)
        }
      }

      if (!hadCorsError) {
        setName('')
        setApiUrl('')
        setApiToken('')
        onConnectionAdded()
      }
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : 'Er trad een fout op'
      setError(msg)
      logger.error('Connection Setup Failed', { error: msg })
    } finally {
      setLoading(false)
    }
  }

  const isTailscale = /(^|\/\/)100\./.test(apiUrl) || apiUrl.includes('.ts.net')

  return (
    <div className="setup-container">
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Naam verbinding (bv. Thuis)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="Home Assistant URL (bv. http://100.x.y.z:8123 of https://ha.mijndomein.be)"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          required
        />
        {isTailscale && (
          <p style={{ color: '#10b981', fontSize: '0.8rem', marginTop: '4px' }}>
            🛡️ <b>Tailscale gedetecteerd:</b> Zorg dat de Tailscale VPN-app op deze telefoon verbonden is.
          </p>
        )}
        {apiUrl.includes('.local') && (
          <p style={{ color: 'orange', fontSize: '0.8rem', marginTop: '4px' }}>
            ⚠️ Android ondersteunt <b>.local</b> vaak niet. Gebruik je Tailscale IP (100.x.x.x) of lokaal IP (192.168.x.x).
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
          {loading ? 'Verbinden...' : 'Verbinden'}
        </button>
      </form>
      {error && <p className="error" style={{ marginTop: '10px' }}>{error}</p>}
    </div>
  )
}
