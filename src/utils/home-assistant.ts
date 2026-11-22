/// <reference types="vite/client" />
import { HADevice } from '../types'

/**
 * Canonical Home Assistant URL normalizer.
 * Preserves reverse-proxy subpaths (e.g. https://example.com/ha) while stripping
 * trailing slashes and accidental API/UI suffixes.
 */
export function normalizeHAUrl(rawUrl?: string | null): string {
  if (!rawUrl) return ''
  let clean = rawUrl.trim().replace(/\/+$/, '')
  const suffixes = ['/api/websocket', '/api/states', '/api', '/config/dashboard']
  for (const suffix of suffixes) {
    if (clean.toLowerCase().endsWith(suffix)) {
      clean = clean.slice(0, -suffix.length)
    }
  }
  return clean.replace(/\/+$/, '')
}

/**
 * Canonical Home Assistant token sanitizer (extracts JWT if wrapped and strips whitespace/non-ASCII).
 */
export function sanitizeHAToken(token?: string | null): string {
  const raw = (token || import.meta.env.VITE_HA_TOKEN || '').trim()
  if (!raw) return ''
  const jwtMatch = raw.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
  const extracted = jwtMatch ? jwtMatch[0] : raw
  return extracted.replace(/\s/g, '').replace(/[^\x00-\x7F]/g, '')
}

/**
 * Fetch wrapper with AbortController timeout.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function getHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

export function buildHAUrl(path: string, baseUrl?: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  const base = normalizeHAUrl(baseUrl)
  return base ? `${base}${cleanPath}` : cleanPath
}

const VALID_HA_SLUG = /^[a-z0-9_]+$/

/** Haal alle Home Assistant states op */
export async function getHAStates(url?: string, token?: string): Promise<HADevice[]> {
  const effectiveToken = sanitizeHAToken(token)
  const fullUrl = buildHAUrl('/api/states', url)

  const response = await fetchWithTimeout(fullUrl, {
    headers: getHeaders(effectiveToken),
  })

  if (!response.ok) {
    throw new Error(`Home Assistant API error: ${response.status}`)
  }

  return response.json()
}

/** Haal alle beschikbare Home Assistant services op */
export async function getHAServices(url?: string, token?: string): Promise<Record<string, any>> {
  const effectiveToken = sanitizeHAToken(token)
  const fullUrl = buildHAUrl('/api/services', url)

  const response = await fetchWithTimeout(fullUrl, {
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

  return servicesArray
}

/** Roep een specifieke Home Assistant service aan */
export async function callHAService(
  domain: string,
  service: string,
  serviceData: Record<string, any>,
  url?: string,
  token?: string
): Promise<any> {
  const cleanDomain = (domain || '').trim().toLowerCase()
  const cleanService = (service || '').trim().toLowerCase()

  if (!VALID_HA_SLUG.test(cleanDomain) || !VALID_HA_SLUG.test(cleanService)) {
    throw new Error(`Ongeldig Home Assistant domein of service: ${domain}.${service}`)
  }

  const effectiveToken = sanitizeHAToken(token)
  const fullUrl = buildHAUrl(`/api/services/${encodeURIComponent(cleanDomain)}/${encodeURIComponent(cleanService)}`, url)

  try {
    const response = await fetchWithTimeout(fullUrl, {
      method: 'POST',
      headers: getHeaders(effectiveToken),
      body: JSON.stringify(serviceData),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`Home Assistant service call failed: ${response.status} - ${errorText}`)
    }

    const text = await response.text()
    if (!text || !text.trim()) return { ok: true }
    try {
      return JSON.parse(text)
    } catch {
      return { ok: true, raw: text }
    }
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`HA Service Call Error (${fullUrl})`, error)
    if (msg.includes('call failed')) throw error
    throw new Error(`Network Error calling ${fullUrl}: ${msg}`)
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
      const serviceNames = Array.isArray(domainServices)
        ? domainServices.map((s: any) => s?.service || String(s))
        : Object.keys(domainServices || {})
      return `${domain}: ${serviceNames.join(', ')}`
    })
    .join('\n')

  return `Available Home Assistant Devices:\n${deviceList}\n\nAvailable Services:\n${serviceList}`
}