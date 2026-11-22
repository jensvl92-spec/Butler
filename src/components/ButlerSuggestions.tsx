import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../lib/AppContext'
import { Toast } from '@capacitor/toast'
import { callHAService, normalizeHAUrl, sanitizeHAToken } from '../utils/home-assistant'
import { saveHAAutomation } from '../utils/ha-api'

export function ButlerSuggestions() {
    const { haWebSocket, activeSuggestion, setActiveSuggestion, activeConnection } = useApp()
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        if (!activeConnection?.id) return

        // Strictly scope realtime subscription to this user's active connection_id!
        const channel = supabase
            .channel(`suggestions_${activeConnection.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'suggestions',
                    filter: `connection_id=eq.${activeConnection.id}`,
                },
                (payload: any) => {
                    if (payload.new?.status && payload.new.status !== 'pending') return
                    setActiveSuggestion(payload.new as any)
                    Toast.show({
                        text: `💡 Butler: ${payload.new?.title || 'Nieuw voorstel'}`,
                        duration: 'long'
                    }).catch(() => {})
                }
            )
            .subscribe()

        return () => {
            supabase.removeChannel(channel)
        }
    }, [activeConnection?.id, setActiveSuggestion])

    const handleAction = async (accepted: boolean) => {
        if (!activeSuggestion || busy) return
        setBusy(true)

        let execSuccess = true
        const actions = Array.isArray(activeSuggestion.actions) ? activeSuggestion.actions : []

        try {
            if (accepted && activeConnection) {
                const cleanUrl = normalizeHAUrl(activeConnection.api_url)
                const cleanToken = sanitizeHAToken(activeConnection.api_token)

                if ((activeSuggestion as any).ha_automation && typeof (activeSuggestion as any).ha_automation === 'object') {
                    await saveHAAutomation(cleanUrl, cleanToken, (activeSuggestion as any).ha_automation)
                }

                for (const action of actions) {
                    if (!action) continue
                    if (action.type === 'create_automation' && action.data && typeof action.data === 'object') {
                        await saveHAAutomation(cleanUrl, cleanToken, action.data)
                        continue
                    }

                    if (!action.entity_id || !action.service) continue
                    const parts = action.service.includes('.')
                        ? action.service.split('.')
                        : [action.entity_id.split('.')[0], action.service]
                    const [domain, service] = parts
                    const serviceData = { ...(action.data || {}), entity_id: action.entity_id }

                    if (haWebSocket && haWebSocket.isConnected()) {
                        await haWebSocket.sendMessage({
                            type: 'call_service',
                            domain,
                            service,
                            service_data: serviceData
                        }, 6000)
                    } else {
                        await callHAService(domain, service, serviceData, cleanUrl, cleanToken)
                    }
                }

                Toast.show({ text: '✅ Uitgevoerd in Home Assistant!', duration: 'short' }).catch(() => {})
            }
        } catch (err: any) {
            execSuccess = false
            console.error('❌ Failed to execute suggestion:', err)
            Toast.show({ text: `❌ Uitvoeren mislukt: ${err?.message || 'Onbekende fout'}`, duration: 'long' }).catch(() => {})
        }

        if (!accepted || execSuccess) {
            const { error } = await supabase
                .from('suggestions')
                .update({ status: accepted ? 'accepted' : 'rejected' })
                .eq('id', activeSuggestion.id)

            if (error) console.error('Error updating suggestion status', error)
            setActiveSuggestion(null)
        }
        setBusy(false)
    }

    if (!activeSuggestion) return null

    return (
        <div style={{
            position: 'fixed',
            bottom: '90px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '90%',
            maxWidth: '400px',
            backgroundColor: '#1f2937',
            color: 'white',
            padding: '16px',
            borderRadius: '14px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
            zIndex: 1000,
            border: '1px solid #374151'
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>💡 {activeSuggestion.title}</h3>
                <button
                    disabled={busy}
                    onClick={() => handleAction(false)}
                    style={{ background: 'transparent', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '1.2rem' }}
                >
                    ✕
                </button>
            </div>

            <p style={{ margin: '0 0 16px 0', color: '#d1d5db', fontSize: '0.9rem' }}>
                {activeSuggestion.description}
                {Array.isArray(activeSuggestion.scheduled_actions) && activeSuggestion.scheduled_actions.length > 0 && (
                    <span style={{ display: 'block', marginTop: '8px', color: '#60a5fa', fontWeight: 500 }}>
                        ⏳ Gepland: {activeSuggestion.scheduled_actions[0].title}
                    </span>
                )}
            </p>

            <div style={{ display: 'flex', gap: '12px' }}>
                <button
                    disabled={busy}
                    onClick={() => handleAction(false)}
                    style={{
                        flex: 1, padding: '8px', borderRadius: '8px',
                        border: '1px solid #4b5563', background: 'transparent',
                        color: 'white', cursor: 'pointer'
                    }}
                >
                    Nee bedankt
                </button>
                <button
                    disabled={busy}
                    onClick={() => handleAction(true)}
                    style={{
                        flex: 1, padding: '8px', borderRadius: '8px',
                        border: 'none', background: '#3b82f6',
                        color: 'white', fontWeight: 600, cursor: 'pointer'
                    }}
                >
                    {busy ? 'Bezig...' : 'Uitvoeren'}
                </button>
            </div>
        </div>
    )
}
