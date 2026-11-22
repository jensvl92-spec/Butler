import { Contacts } from '@capacitor-community/contacts';
import { Capacitor } from '@capacitor/core';

export interface ContactInfo {
    id: string;
    name: string;
    phone: string;
}

function normalizeName(str: string): string {
    return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Check or request contacts permission from the user.
 */
export async function requestContactsPermission(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    try {
        const current = await Contacts.checkPermissions();
        if (current.contacts === 'granted') return true;
        const permission = await Contacts.requestPermissions();
        return permission.contacts === 'granted';
    } catch (e) {
        console.error('[Contacts] Permission request failed', e);
        return false;
    }
}

/**
 * Search for a contact with a valid phone number by name (accent-aware fuzzy match).
 */
export async function findContactByName(searchTerm: string): Promise<ContactInfo | null> {
    const trimmed = (searchTerm || '').trim();
    if (!trimmed) return null;

    try {
        const hasPermission = await requestContactsPermission();
        if (!hasPermission) return null;

        const result = await Contacts.getContacts({
            projection: {
                name: true,
                phones: true,
            }
        });

        // Filter to contacts WITH a non-empty phone number BEFORE name matching
        const contacts = (result.contacts || []).filter(
            c => Array.isArray(c.phones) && c.phones.some(p => (p.number || '').trim().length > 0)
        );
        if (contacts.length === 0) return null;

        const lowerSearch = trimmed.toLowerCase();
        const normalizedSearch = normalizeName(trimmed);

        // 1. Exact display name match
        let match = contacts.find(c => (c.name?.display || '').trim().toLowerCase() === lowerSearch);

        // 2. Starts with match
        if (!match) {
            match = contacts.find(c => (c.name?.display || '').trim().toLowerCase().startsWith(lowerSearch));
        }

        // 3. Includes match
        if (!match) {
            match = contacts.find(c => (c.name?.display || '').trim().toLowerCase().includes(lowerSearch));
        }

        // 4. Accent-normalized fuzzy match (preserves Renée, Zoë, Chloé, etc.; requires >=3 chars for reverse match)
        if (!match && normalizedSearch.length >= 2) {
            match = contacts.find(c => {
                const normName = normalizeName(c.name?.display || '');
                if (normName.length < 2) return false;
                if (normName === normalizedSearch || normName.includes(normalizedSearch)) return true;
                return normName.length >= 3 && normalizedSearch.includes(normName);
            });
        }

        if (match) {
            const firstPhone = match.phones!.find(p => (p.number || '').trim().length > 0)?.number || '';
            return {
                id: match.contactId,
                name: match.name?.display || 'Onbekend',
                phone: firstPhone.trim()
            };
        }

        return null;
    } catch (e) {
        console.error('[Contacts] Search failed', e);
        return null;
    }
}

/**
 * Get all contacts with phone numbers.
 */
export async function getAllContacts(): Promise<ContactInfo[]> {
    try {
        const hasPermission = await requestContactsPermission();
        if (!hasPermission) return [];

        const result = await Contacts.getContacts({
            projection: {
                name: true,
                phones: true,
            }
        });

        return (result.contacts || [])
            .filter(c => Array.isArray(c.phones) && c.phones.some(p => (p.number || '').trim().length > 0))
            .map(c => ({
                id: c.contactId,
                name: c.name?.display || 'Onbekend',
                phone: (c.phones!.find(p => (p.number || '').trim().length > 0)?.number || '').trim()
            }));
    } catch (e) {
        console.error('[Contacts] Get all failed', e);
        return [];
    }
}
