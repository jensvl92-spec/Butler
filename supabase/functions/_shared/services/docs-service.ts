
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Set app-level user context for RLS enforcement.
 */
async function setAppUserContext(userId: string): Promise<void> {
    await supabaseAdmin.rpc('set_app_user', { p_user_id: userId });
}

interface GoogleToken {
    access_token: string;
    refresh_token: string;
    expires_at: string;
}

/**
 * Get a valid access token for the user.
 */
async function getAccessToken(userId: string): Promise<string> {
    // Set RLS context for defense-in-depth
    await setAppUserContext(userId);

    const { data: tokenData, error } = await supabaseAdmin
        .from('user_tokens')
        .select('*')
        .eq('user_id', userId)
        .eq('provider', 'google')
        .single();

    if (error || !tokenData) {
        throw new Error('Google account not connected.');
    }

    const token = tokenData as GoogleToken;
    const expiresAt = new Date(token.expires_at).getTime();
    const now = Date.now();

    if (expiresAt > now + 5 * 60 * 1000) {
        return token.access_token;
    }

    // Refresh Token
    console.log('[DocsService] Refreshing token...');
    const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: token.refresh_token,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET
        })
    });

    const newData = await refreshResponse.json();

    if (newData.error) {
        throw new Error(`Failed to refresh Google token: ${newData.error_description || newData.error}`);
    }

    const newExpiresAt = new Date(Date.now() + newData.expires_in * 1000).toISOString();

    await supabaseAdmin
        .from('user_tokens')
        .update({
            access_token: newData.access_token,
            expires_at: newExpiresAt,
            updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('provider', 'google');

    return newData.access_token;
}



/**
 * List user's Google Docs from Drive.
 */
export async function listDocuments(userId: string, limit: number = 10) {
    try {
        const token = await getAccessToken(userId);

        const url = `https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.document'&pageSize=${limit}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,webViewLink)`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        return data.files?.map((file: any) => ({
            id: file.id,
            name: file.name,
            modifiedTime: file.modifiedTime,
            url: file.webViewLink
        })) || [];
    } catch (e: any) {
        console.error('[DocsService] Error listing documents:', e);
        return [];
    }
}

/**
 * Get a Google Doc's content as plain text.
 */
export async function getDocument(userId: string, documentId: string) {
    try {
        const token = await getAccessToken(userId);

        const url = `https://docs.googleapis.com/v1/documents/${documentId}`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        // Extract plain text from document content
        const content = extractDocumentText(data.body?.content || []);

        return {
            id: data.documentId,
            title: data.title,
            content,
            url: `https://docs.google.com/document/d/${documentId}/edit`
        };
    } catch (e: any) {
        console.error('[DocsService] Error getting document:', e);
        throw e;
    }
}

/**
 * Extract plain text from Google Docs content structure.
 */
function extractDocumentText(content: any[]): string {
    let text = '';

    for (const element of content) {
        if (element.paragraph) {
            for (const el of element.paragraph.elements || []) {
                if (el.textRun?.content) {
                    text += el.textRun.content;
                }
            }
        } else if (element.table) {
            // Handle tables
            for (const row of element.table.tableRows || []) {
                for (const cell of row.tableCells || []) {
                    text += extractDocumentText(cell.content || []);
                    text += '\t';
                }
                text += '\n';
            }
        }
    }

    return text.trim();
}

/**
 * Create a new Google Doc.
 */
export async function createDocument(userId: string, title: string, initialContent?: string) {
    const token = await getAccessToken(userId);

    const response = await fetch('https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            title
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const documentId = data.documentId;

    // If initial content is provided, insert it immediately
    if (initialContent && initialContent.trim().length > 0) {
        try {
            const insertResponse = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    requests: [
                        {
                            insertText: {
                                location: {
                                    index: 1
                                },
                                text: initialContent
                            }
                        }
                    ]
                })
            });
            const insertData = await insertResponse.json();
            if (insertData.error) {
                console.error('[DocsService] BatchUpdate Error:', JSON.stringify(insertData.error));
                throw new Error(insertData.error.message);
            }
            console.log(`[DocsService] Inserted ${initialContent.length} chars into new doc: ${documentId}`);

        } catch (e: any) {
            console.error('[DocsService] Failed to insert initial content:', e);
            // Throw so the user knows it failed
            throw new Error(`Document created but content failed: ${e.message}`);
        }
    }

    return {
        id: documentId,
        title: data.title,
        url: `https://docs.google.com/document/d/${documentId}/edit`
    };
}

/**
 * Append text to the end of a Google Doc.
 */
export async function appendToDocument(userId: string, documentId: string, text: string) {
    const token = await getAccessToken(userId);

    // First get the document to find the end index
    const docResponse = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    const doc = await docResponse.json();
    if (doc.error) throw new Error(doc.error.message);

    // Find the end of the document
    // Empty doc has body.content containing 1 element (SectionBreak) with endIndex=2.
    // We want to insert at endIndex - 1.
    const lastElement = doc.body?.content?.[doc.body.content.length - 1];
    const endIndex = lastElement?.endIndex || 1;

    // Check if doc is basically empty (endIndex <= 2)
    // If so, we don't need leading newline
    const isNewDoc = endIndex <= 2;
    const textToInsert = isNewDoc ? text : '\n' + text;

    // Append text
    const response = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            requests: [
                {
                    insertText: {
                        location: {
                            index: endIndex - 1
                        },
                        text: textToInsert
                    }
                }
            ]
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return {
        id: documentId,
        appended: textToInsert.length,
        url: `https://docs.google.com/document/d/${documentId}/edit`
    };
}

/**
 * Get document metadata only (without full content).
 */
export async function getDocumentInfo(userId: string, documentId: string) {
    const token = await getAccessToken(userId);

    const url = `https://docs.googleapis.com/v1/documents/${documentId}?fields=documentId,title`;

    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return {
        id: data.documentId,
        title: data.title,
        url: `https://docs.google.com/document/d/${documentId}/edit`
    };
}
