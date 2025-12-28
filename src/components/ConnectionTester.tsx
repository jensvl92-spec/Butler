import { useEffect, useState } from 'react'
import { getHAStates, getHAServices } from '../utils/home-assistant'

import { useApp } from '../lib/AppContext'

export default function ConnectionTester() {
  const { activeConnection } = useApp()
  const [status, setStatus] = useState<string>('Nog niet getest...')
  const [deviceCount, setDeviceCount] = useState<number>(0)
  const [serviceCount, setServiceCount] = useState<number>(0)

  useEffect(() => {
    async function testConnection() {
      if (!activeConnection) {
        setStatus('Selecteer een connectie om te testen')
        return
      }

      try {
        setStatus(`Verbinding testen met ${activeConnection.name}...`)
        const states = await getHAStates(activeConnection.api_url, activeConnection.api_token)
        const services = await getHAServices(activeConnection.api_url, activeConnection.api_token)

        console.log('States:', states)
        console.log('Services:', services)

        setDeviceCount(states.length)
        setServiceCount(Object.keys(services).length)
        setStatus('✅ Verbinding geslaagd!')
      } catch (err: any) {
        console.error('API error:', err)
        setStatus(`❌ Fout: ${err.message}`)
      }
    }

    testConnection()
  }, [activeConnection])

  return (
    <div style={{ padding: '1rem', border: '1px solid #ccc', borderRadius: '8px' }}>
      <h3>Home Assistant Connection Tester</h3>
      <p>Status: {status}</p>
      {status.startsWith('✅') && (
        <ul>
          <li>Devices gevonden: {deviceCount}</li>
          <li>Services gevonden: {serviceCount}</li>
        </ul>
      )}
    </div>
  )
}