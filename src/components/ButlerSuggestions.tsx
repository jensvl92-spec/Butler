import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../lib/AppContext'
import { Toast } from '@capacitor/toast'

interface Suggestion {
    id: string
    title: string
    description: string
    actions: any[]
    scheduled_actions?: any[]
    status: 'pending' | 'accepted' | 'rejected'
}

export function ButlerSuggestions() {
    const { haWebSocket, activeSuggestion, setActiveSuggestion, activeConnection, uiState } = useApp()

    useEffect(() => {
        // Subscribe to realtime updates for NEW suggestions
        const channel = supabase
            .channel('suggestions_channel')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'suggestions',
                    filter: 'status=eq.pending',
                },
                payload => {
                    console.log('🔔 New Suggestion received!', payload.new)
                    setActiveSuggestion(payload.new as any) // Type cast for now

                    // Native Toast for immediate attention
                    Toast.show({
                        text: `💡 Butler: ${payload.new.title}`,
                        duration: 'long'
                    })
                }
            )
            .subscribe()

        return () => {
            supabase.removeChannel(channel)
        }
    }, [])

    const handleAction = async (accepted: boolean) => {
        if (!activeSuggestion) return

        if (accepted) {
            console.log("✅ User accepted suggestion:", activeSuggestion.title)

            // Check if we need backend execution (e.g. create_automation or scheduled actions)
            const hasComplexActions = activeSuggestion.actions.some((a: any) => a.type === 'create_automation') || (activeSuggestion.scheduled_actions && activeSuggestion.scheduled_actions.length > 0);

            if (hasComplexActions && activeConnection) {
                // 🚀 Execute via Backend
                try {
                    await Toast.show({ text: '🤖 Processing...', duration: 'short' })

                    const SUPABASE_URL = (import.meta as any).env.VITE_SUPABASE_URL
                    const SUPABASE_ANON_KEY = (import.meta as any).env.VITE_SUPABASE_ANON_KEY

                    await fetch(`${SUPABASE_URL}/functions/v1/process-ai-command`, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            connection_id: activeConnection.id,
                            user_message: "Do it", // Trigger affirmative
                            language: uiState.language || 'en',
                            devices: [], // Not needed for confirmation
                            services: {},
                            rooms: [],
                            active_suggestion: activeSuggestion // Inject suggestion to force execution
                        }),
                    })
                    await Toast.show({ text: '✅ Automation Created!', duration: 'long' })
                } catch (e) {
                    console.error("Backend exec failed", e)
                    await Toast.show({ text: '❌ Failed to create automation', duration: 'long' })
                }
            } else if (haWebSocket) {
                // Execute Simple Actions Locally via WS
                for (const action of activeSuggestion.actions) {
                    try {
                        const domain = action.entity_id?.split('.')[0] || 'homeassistant'
                        await haWebSocket.sendMessage({
                            type: 'call_service',
                            domain: domain,
                            service: action.service,
                            service_data: action.data || { entity_id: action.entity_id }
                        })
                    } catch (err) {
                        console.error("❌ Failed to execute suggestion action", err)
                    }
                }
                await Toast.show({ text: '✅ Executed!', duration: 'short' })
            }
        } else {
            console.log("❌ User rejected suggestion")
        }

        // Update status in DB
        supabase.from('suggestions').update({
            status: accepted ? 'accepted' : 'rejected'
        }).eq('id', activeSuggestion.id).then(({ error }) => {
            if (error) console.error("Error updating suggestion status", error)
        })

        // Clear UI
        setActiveSuggestion(null)
    }

    if (!activeSuggestion) return null

    return (
        <div style={{
            position: 'fixed',
            bottom: '100px', // Above bottom nav if any
            left: '50%',
            transform: 'translateX(-50%)',
            width: '90%',
            maxWidth: '400px',
            backgroundColor: '#1f2937', // Dark gray
            color: 'white',
            padding: '16px',
            borderRadius: '12px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
            zIndex: 1000,
            border: '1px solid #374151'
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>💡 {activeSuggestion.title}</h3>
                <button
                    onClick={() => handleAction(false)}
                    style={{ background: 'transparent', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '1.2rem' }}
                >
                    ✕
                </button>
            </div>

            <p style={{ margin: '0 0 16px 0', color: '#d1d5db', fontSize: '0.9rem' }}>
                {activeSuggestion.description}
                {activeSuggestion.scheduled_actions && activeSuggestion.scheduled_actions.length > 0 && (
                    <span style={{ display: 'block', marginTop: '8px', color: '#60a5fa', fontWeight: 500 }}>
                        ⏳ Scheduled: {activeSuggestion.scheduled_actions[0].title}
                    </span>
                )}
            </p>

            <div style={{ display: 'flex', gap: '12px' }}>
                <button
                    onClick={() => handleAction(false)}
                    style={{
                        flex: 1,
                        padding: '8px',
                        borderRadius: '6px',
                        border: '1px solid #4b5563',
                        background: 'transparent',
                        color: 'white',
                        cursor: 'pointer'
                    }}
                >
                    No thanks
                </button>
                <button
                    onClick={() => handleAction(true)}
                    style={{
                        flex: 1,
                        padding: '8px',
                        borderRadius: '6px',
                        border: 'none',
                        background: '#3b82f6', // Blue
                        color: 'white',
                        fontWeight: 600,
                        cursor: 'pointer'
                    }}
                >
                    Do it
                </button>
            </div>
        </div>
    )
}
