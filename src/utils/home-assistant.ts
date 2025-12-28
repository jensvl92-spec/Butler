/// <reference types="vite/client" />
import { HADevice } from '../types'

const HA_URL = import.meta.env.VITE_HA_URL
const HA_TOKEN = import.meta.env.VITE_HA_TOKEN

// Helper: standaard headers
function getHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

// Helper: resolve URL
// If a baseUrl is provided (from a connection), we use it directly (CORS permitting).
// If no baseUrl, we assume we want to hit the local proxy (development).
function getUrl(path: string, _baseUrl?: string): string {
  if (_baseUrl) {
    // Remove trailing slash from base and leading slash from path to join cleanly
    const base = _baseUrl.replace(/\/$/, '')
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    return `${base}${cleanPath}`
  }
  // No base URL provided -> use relative path (Proxy)
  return path
}

// Helper: resolve Token
function getToken(token?: string): string {
  return token ?? import.meta.env.VITE_HA_TOKEN ?? ''
}

/** Haal alle Home Assistant states op */
export async function getHAStates(url?: string, token?: string): Promise<HADevice[]> {
  const effectiveToken = getToken(token)
  const fullUrl = getUrl('/api/states', url)

  const response = await fetch(fullUrl, {
    headers: getHeaders(effectiveToken),
  })

  if (!response.ok) {
    throw new Error(`Home Assistant API error: ${response.status}`)
  }

  return response.json()
}

/** Haal alle beschikbare Home Assistant services op */
export async function getHAServices(url?: string, token?: string): Promise<Record<string, any>> {
  const effectiveToken = getToken(token)
  const fullUrl = getUrl('/api/services', url)

  const response = await fetch(fullUrl, {
    headers: getHeaders(effectiveToken),
  })

  if (!response.ok) {
    throw new Error(`Home Assistant API error: ${response.status}`)
  }

  const servicesArray = await response.json()

  // Transform array [{domain: "light", services: {...}}, ...] to key-value object
  const servicesObj: Record<string, any> = {}
  if (Array.isArray(servicesArray)) {
    servicesArray.forEach((domainObj: any) => {
      if (domainObj.domain && domainObj.services) {
        servicesObj[domainObj.domain] = domainObj.services
      }
    })
    return servicesObj
  }

  return servicesArray // Fallback if it's already an object (unlikely)
}

/** Roep een specifieke Home Assistant service aan */
export async function callHAService(
  domain: string,
  service: string,
  serviceData: Record<string, any>,
  url?: string,
  token?: string
): Promise<any> {
  const effectiveToken = getToken(token)
  const fullUrl = getUrl(`/api/services/${domain}/${service}`, url)

  try {
    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: getHeaders(effectiveToken),
      body: JSON.stringify(serviceData),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Home Assistant service call failed: ${response.status} - ${errorText}`)
    }

    return response.json()
  } catch (error: any) {
    console.error(`HA Service Call Error (${fullUrl})`, error)
    // Re-throw with URL context
    if (error.message.includes('call failed')) throw error // Pass through HTTP errors
    throw new Error(`Network Error calling ${fullUrl}: ${error.message}`)
  }
}

/** Bouw een tekstuele context van devices en services */
export function buildHAToolContext(
  devices: HADevice[],
  services: Record<string, any>
): string {
  const deviceList = devices
    .map((d) => `- ${d.entity_id}: ${d.state} (${JSON.stringify(d.attributes)})`)
    .join('\n')

  const serviceList = Object.entries(services)
    .map(([domain, domainServices]) => {
      const servicesArray = Array.isArray(domainServices)
        ? domainServices
        : Object.values(domainServices)
      return `${domain}: ${servicesArray.map((s: any) => s.service || s).join(', ')}`
    })
    .join('\n')

  return `Available Home Assistant Devices:\n${deviceList}\n\nAvailable Services:\n${serviceList}`
}