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
 * Fetch wrapper with hard timeout that works reliably on Android CapacitorHttp
 * (CapacitorHttp ignores AbortController.signal on POST requests, so Promise.race enforces the deadline).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { controller.abort() } catch { }
      reject(new Error(`Timeout (${Math.round(timeoutMs / 1000)}s): Home Assistant reageert niet`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeoutPromise
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function getFallbackHAUrl(connectionId?: string | null): string {
  if (!connectionId || typeof localStorage === 'undefined') return ''
  try {
    return normalizeHAUrl(localStorage.getItem(`ha_fallback_url_${connectionId}`) || '')
  } catch {
    return ''
  }
}

export function setFallbackHAUrl(connectionId: string, rawUrl: string): string {
  const trimmed = (rawUrl || '').trim()
  if (!trimmed) {
    try { localStorage.removeItem(`ha_fallback_url_${connectionId}`) } catch { }
    return ''
  }
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const clean = normalizeHAUrl(withProto)
  try { localStorage.setItem(`ha_fallback_url_${connectionId}`, clean) } catch { }
  return clean
}

/**
 * Probes primary + optional fallback URL (e.g. local Wi-Fi + Tailscale) in parallel
 * and returns the first reachable Home Assistant URL.
 */
export async function probeBestHAUrl(
  primaryUrl: string,
  fallbackUrl: string,
  token: string,
  timeoutMs = 4500
): Promise<{ url: string; reachable: boolean; error?: string }> {
  const cleanPrimary = normalizeHAUrl(primaryUrl)
  const cleanFallback = normalizeHAUrl(fallbackUrl)
  const candidates = [cleanPrimary, cleanFallback].filter((u, idx, arr) => Boolean(u) && arr.indexOf(u) === idx)

  if (candidates.length === 0) {
    return { url: cleanPrimary, reachable: false, error: 'Geen Home Assistant URL ingesteld' }
  }

  const effectiveToken = sanitizeHAToken(token)
  const probeOne = async (baseUrl: string): Promise<string> => {
    const res = await fetchWithTimeout(
      buildHAUrl('/api/', baseUrl),
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${effectiveToken}`,
          'Content-Type': 'application/json'
        }
      },
      timeoutMs
    )
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status} (ongeldige token)`)
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return baseUrl
  }

  if (candidates.length === 1) {
    try {
      const okUrl = await probeOne(candidates[0])
      return { url: okUrl, reachable: true }
    } catch (err: any) {
      return { url: candidates[0], reachable: false, error: err?.message || 'Niet bereikbaar' }
    }
  }

  // ES2020-compatible first-fulfilled race (Wi-Fi at home OR Tailscale on 5G — fastest reachable wins!)
  return await new Promise((resolve) => {
    let settled = false
    let failedCount = 0
    let firstError = 'Geen van de Home Assistant URLs bereikbaar'

    candidates.forEach((candidate) => {
      probeOne(candidate)
        .then((winner) => {
          if (!settled) {
            settled = true
            resolve({ url: winner, reachable: true })
          }
        })
        .catch((err: any) => {
          if (failedCount === 0 && err?.message) {
            firstError = err.message
          }
          failedCount++
          if (!settled && failedCount >= candidates.length) {
            settled = true
            resolve({ url: cleanPrimary, reachable: false, error: firstError })
          }
        })
    })
  })
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