import { Contacts } from '@capacitor-community/contacts';
/**
 * Request contacts permission from the user.
 */
export async function requestContactsPermission() {
    try {
        const permission = await Contacts.requestPermissions();
        return permission.contacts === 'granted';
    }
    catch (e) {
        console.error('[Contacts] Permission request failed', e);
        return false;
    }
}
/**
 * Search for a contact by name (fuzzy match).
 * Returns the best match find or null.
 */
export async function findContactByName(searchTerm) {
    console.log(`[Contacts] Searching for: "${searchTerm}"`);
    try {
        const hasPermission = await requestContactsPermission();
        if (!hasPermission) {
            console.warn('[Contacts] ❌ Permission denied');
            return null;
        }
        const result = await Contacts.getContacts({
            projection: {
                name: true,
                phones: true,
            }
        });
        const contacts = result.contacts;
        const lowerSearch = searchTerm.toLowerCase();
        console.log(`[Contacts] Total contacts loaded: ${contacts.length}`);
        // Debug: Show contacts that might match (first 5 that include any part of search term)
        const possibleMatches = contacts
            .filter(c => {
            const name = (c.name?.display || '').toLowerCase();
            // Check if any part matches
            return lowerSearch.split(' ').some(part => name.includes(part)) ||
                name.split(' ').some(part => lowerSearch.includes(part));
        })
            .slice(0, 5);
        if (possibleMatches.length > 0) {
            console.log(`[Contacts] Possible matches:`, possibleMatches.map(c => ({
                name: c.name?.display,
                hasPhone: c.phones && c.phones.length > 0
            })));
        }
        // 1. Exact match
        let match = contacts.find(c => (c.name?.display || '').toLowerCase() === lowerSearch);
        // 2. Starts with match
        if (!match) {
            match = contacts.find(c => (c.name?.display || '').toLowerCase().startsWith(lowerSearch));
        }
        // 3. Includes match
        if (!match) {
            match = contacts.find(c => (c.name?.display || '').toLowerCase().includes(lowerSearch));
        }
        // 4. Reverse includes - search term contains contact name
        if (!match) {
            match = contacts.find(c => {
                const name = (c.name?.display || '').toLowerCase();
                return name && lowerSearch.includes(name);
            });
        }
        // 5. Fuzzy match - normalize by removing spaces, emojis, and special chars
        //    This allows "SchatjeL" to match "Schatje L ❤"
        if (!match) {
            // Extract only letters (a-z) from the search term
            const normalizedSearch = lowerSearch.replace(/[^a-z]/gi, '');
            if (normalizedSearch.length > 0) { // Only proceed if there are letters
                match = contacts.find(c => {
                    const normalizedName = (c.name?.display || '').toLowerCase().replace(/[^a-z]/gi, '');
                    // Only match if the contact name has letters (prevents matching number-only contacts)
                    if (normalizedName.length === 0)
                        return false;
                    return normalizedName === normalizedSearch ||
                        normalizedName.includes(normalizedSearch) ||
                        normalizedSearch.includes(normalizedName);
                });
            }
        }
        if (match) {
            console.log(`[Contacts] ✅ Found match: "${match.name?.display}", phones: ${match.phones?.length || 0}`);
            if (match.phones && match.phones.length > 0) {
                return {
                    id: match.contactId,
                    name: match.name?.display || 'Unknown',
                    phone: match.phones[0].number || ''
                };
            }
            else {
                console.warn(`[Contacts] ⚠️ Contact found but has no phone number`);
            }
        }
        else {
            console.warn(`[Contacts] ❌ No match found for "${searchTerm}"`);
        }
        return null;
    }
    catch (e) {
        console.error('[Contacts] Search failed', e);
        return null;
    }
}
/**
 * Get all contacts (for initialization or syncing if needed).
 */
export async function getAllContacts() {
    try {
        const result = await Contacts.getContacts({
            projection: {
                name: true,
                phones: true,
            }
        });
        return result.contacts
            .filter(c => c.phones && c.phones.length > 0)
            .map(c => ({
            id: c.contactId,
            name: c.name?.display || 'Unknown',
            phone: c.phones[0].number || ''
        }));
    }
    catch (e) {
        console.error('[Contacts] Get all failed', e);
        return [];
    }
}
