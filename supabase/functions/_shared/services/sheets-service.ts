
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
    console.log('[SheetsService] Refreshing token...');
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
 * List user's spreadsheets from Google Drive.
 */
export async function listSpreadsheets(userId: string, limit: number = 10) {
    try {
        const token = await getAccessToken(userId);

        const url = `https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.spreadsheet'&pageSize=${limit}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,webViewLink)`;

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
        console.error('[SheetsService] Error listing spreadsheets:', e);
        return [];
    }
}

/**
 * Get data from a specific spreadsheet range.
 */
export async function getSpreadsheetData(userId: string, spreadsheetId: string, range: string = 'Sheet1') {
    try {
        const token = await getAccessToken(userId);

        const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;

        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        return {
            range: data.range,
            values: data.values || []
        };
    } catch (e: any) {
        console.error('[SheetsService] Error getting spreadsheet data:', e);
        throw e;
    }
}

/**
 * Update data in a specific spreadsheet range.
 */
export async function updateSpreadsheetData(userId: string, spreadsheetId: string, range: string, values: any[][]) {
    const token = await getAccessToken(userId);

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            range,
            values
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return data;
}

/**
 * Append data to a spreadsheet.
 */
export async function appendSpreadsheetData(userId: string, spreadsheetId: string, range: string, values: any[][]) {
    const token = await getAccessToken(userId);

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            range,
            values
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return data;
}

/**
 * Create a new spreadsheet.
 */
export async function createSpreadsheet(userId: string, title: string) {
    const token = await getAccessToken(userId);

    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            properties: {
                title
            }
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return {
        id: data.spreadsheetId,
        title: data.properties.title,
        url: data.spreadsheetUrl
    };
}

/**
 * Get spreadsheet metadata (title, sheets, etc.)
 */
export async function getSpreadsheetInfo(userId: string, spreadsheetId: string) {
    const token = await getAccessToken(userId);

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties`;

    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    return {
        title: data.properties.title,
        sheets: data.sheets?.map((s: any) => ({
            id: s.properties.sheetId,
            title: s.properties.title,
            rowCount: s.properties.gridProperties?.rowCount,
            columnCount: s.properties.gridProperties?.columnCount
        })) || []
    };
}

/**
 * Execute batch update requests on a spreadsheet.
 */
export async function batchUpdate(userId: string, spreadsheetId: string, requests: any[]) {
    const token = await getAccessToken(userId);

    const response = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ requests })
        }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data;
}

/**
 * Create a chart in a spreadsheet.
 * @param chartType: 'pie', 'bar', 'line', 'column', 'area'
 */
export async function createChart(
    userId: string,
    spreadsheetId: string,
    sheetId: number = 0,
    chartType: 'pie' | 'bar' | 'line' | 'column' | 'area' = 'bar',
    title: string,
    dataRange: { startRow: number; endRow: number; startCol: number; endCol: number },
    anchorCell: { row: number; col: number } = { row: 0, col: 4 }
) {
    const chartSpec: any = {
        title,
        basicChart: {
            chartType: chartType.toUpperCase(),
            legendPosition: 'BOTTOM_LEGEND',
            axis: [
                { position: 'BOTTOM_AXIS', title: '' },
                { position: 'LEFT_AXIS', title: '' }
            ],
            domains: [{
                domain: {
                    sourceRange: {
                        sources: [{
                            sheetId,
                            startRowIndex: dataRange.startRow,
                            endRowIndex: dataRange.endRow,
                            startColumnIndex: dataRange.startCol,
                            endColumnIndex: dataRange.startCol + 1
                        }]
                    }
                }
            }],
            series: [{
                series: {
                    sourceRange: {
                        sources: [{
                            sheetId,
                            startRowIndex: dataRange.startRow,
                            endRowIndex: dataRange.endRow,
                            startColumnIndex: dataRange.endCol - 1,
                            endColumnIndex: dataRange.endCol
                        }]
                    }
                },
                targetAxis: 'LEFT_AXIS'
            }]
        }
    };

    // Use pie chart spec for pie charts
    if (chartType === 'pie') {
        chartSpec.pieChart = {
            legendPosition: 'LABELED_LEGEND',
            domain: {
                sourceRange: {
                    sources: [{
                        sheetId,
                        startRowIndex: dataRange.startRow,
                        endRowIndex: dataRange.endRow,
                        startColumnIndex: dataRange.startCol,
                        endColumnIndex: dataRange.startCol + 1
                    }]
                }
            },
            series: {
                sourceRange: {
                    sources: [{
                        sheetId,
                        startRowIndex: dataRange.startRow,
                        endRowIndex: dataRange.endRow,
                        startColumnIndex: dataRange.endCol - 1,
                        endColumnIndex: dataRange.endCol
                    }]
                }
            }
        };
        delete chartSpec.basicChart;
    }

    const request = {
        addChart: {
            chart: {
                spec: chartSpec,
                position: {
                    overlayPosition: {
                        anchorCell: {
                            sheetId,
                            rowIndex: anchorCell.row,
                            columnIndex: anchorCell.col
                        }
                    }
                }
            }
        }
    };

    return await batchUpdate(userId, spreadsheetId, [request]);
}

/**
 * Format cells (bold, colors, alignment, etc.)
 */
export async function formatCells(
    userId: string,
    spreadsheetId: string,
    sheetId: number = 0,
    range: { startRow: number; endRow: number; startCol: number; endCol: number },
    format: {
        bold?: boolean;
        italic?: boolean;
        fontSize?: number;
        textColor?: { red?: number; green?: number; blue?: number };
        backgroundColor?: { red?: number; green?: number; blue?: number };
        horizontalAlignment?: 'LEFT' | 'CENTER' | 'RIGHT';
        numberFormat?: { type: string; pattern?: string };
    }
) {
    const cellFormat: any = {};
    const fields: string[] = [];

    if (format.bold !== undefined || format.italic !== undefined || format.fontSize) {
        cellFormat.textFormat = {};
        if (format.bold !== undefined) {
            cellFormat.textFormat.bold = format.bold;
            fields.push('userEnteredFormat.textFormat.bold');
        }
        if (format.italic !== undefined) {
            cellFormat.textFormat.italic = format.italic;
            fields.push('userEnteredFormat.textFormat.italic');
        }
        if (format.fontSize) {
            cellFormat.textFormat.fontSize = format.fontSize;
            fields.push('userEnteredFormat.textFormat.fontSize');
        }
    }

    if (format.textColor) {
        cellFormat.textFormat = cellFormat.textFormat || {};
        cellFormat.textFormat.foregroundColor = format.textColor;
        fields.push('userEnteredFormat.textFormat.foregroundColor');
    }

    if (format.backgroundColor) {
        cellFormat.backgroundColor = format.backgroundColor;
        fields.push('userEnteredFormat.backgroundColor');
    }

    if (format.horizontalAlignment) {
        cellFormat.horizontalAlignment = format.horizontalAlignment;
        fields.push('userEnteredFormat.horizontalAlignment');
    }

    if (format.numberFormat) {
        cellFormat.numberFormat = format.numberFormat;
        fields.push('userEnteredFormat.numberFormat');
    }

    const request = {
        repeatCell: {
            range: {
                sheetId,
                startRowIndex: range.startRow,
                endRowIndex: range.endRow,
                startColumnIndex: range.startCol,
                endColumnIndex: range.endCol
            },
            cell: { userEnteredFormat: cellFormat },
            fields: fields.join(',')
        }
    };

    return await batchUpdate(userId, spreadsheetId, [request]);
}

/**
 * Auto-resize columns to fit content.
 */
export async function autoResizeColumns(userId: string, spreadsheetId: string, sheetId: number = 0, startCol: number, endCol: number) {
    const request = {
        autoResizeDimensions: {
            dimensions: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: startCol,
                endIndex: endCol
            }
        }
    };

    return await batchUpdate(userId, spreadsheetId, [request]);
}

/**
 * Add a new sheet/tab to an existing spreadsheet.
 */
export async function addSheet(userId: string, spreadsheetId: string, sheetTitle: string) {
    const request = {
        addSheet: {
            properties: {
                title: sheetTitle
            }
        }
    };

    const result = await batchUpdate(userId, spreadsheetId, [request]);
    return result.replies?.[0]?.addSheet?.properties;
}

/**
 * Delete a sheet/tab from a spreadsheet.
 */
export async function deleteSheet(userId: string, spreadsheetId: string, sheetId: number) {
    return await batchUpdate(userId, spreadsheetId, [{
        deleteSheet: { sheetId }
    }]);
}

/**
 * Merge cells in a range.
 */
export async function mergeCells(
    userId: string,
    spreadsheetId: string,
    sheetId: number,
    range: { startRow: number; endRow: number; startCol: number; endCol: number },
    mergeType: 'MERGE_ALL' | 'MERGE_COLUMNS' | 'MERGE_ROWS' = 'MERGE_ALL'
) {
    return await batchUpdate(userId, spreadsheetId, [{
        mergeCells: {
            range: {
                sheetId,
                startRowIndex: range.startRow,
                endRowIndex: range.endRow,
                startColumnIndex: range.startCol,
                endColumnIndex: range.endCol
            },
            mergeType
        }
    }]);
}

/**
 * Add borders to cells.
 */
export async function addBorders(
    userId: string,
    spreadsheetId: string,
    sheetId: number,
    range: { startRow: number; endRow: number; startCol: number; endCol: number },
    style: 'SOLID' | 'DOTTED' | 'DASHED' | 'DOUBLE' = 'SOLID',
    color: { red?: number; green?: number; blue?: number } = { red: 0, green: 0, blue: 0 }
) {
    const border = { style, color };

    return await batchUpdate(userId, spreadsheetId, [{
        updateBorders: {
            range: {
                sheetId,
                startRowIndex: range.startRow,
                endRowIndex: range.endRow,
                startColumnIndex: range.startCol,
                endColumnIndex: range.endCol
            },
            top: border,
            bottom: border,
            left: border,
            right: border,
            innerHorizontal: border,
            innerVertical: border
        }
    }]);
}

/**
 * Set column width.
 */
export async function setColumnWidth(userId: string, spreadsheetId: string, sheetId: number, startCol: number, endCol: number, width: number) {
    return await batchUpdate(userId, spreadsheetId, [{
        updateDimensionProperties: {
            range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: startCol,
                endIndex: endCol
            },
            properties: { pixelSize: width },
            fields: 'pixelSize'
        }
    }]);
}

/**
 * Freeze rows or columns (for headers).
 */
export async function freezeRowsOrColumns(userId: string, spreadsheetId: string, sheetId: number, frozenRows?: number, frozenCols?: number) {
    const properties: any = {};
    const fields: string[] = [];

    if (frozenRows !== undefined) {
        properties.frozenRowCount = frozenRows;
        fields.push('gridProperties.frozenRowCount');
    }
    if (frozenCols !== undefined) {
        properties.frozenColumnCount = frozenCols;
        fields.push('gridProperties.frozenColumnCount');
    }

    return await batchUpdate(userId, spreadsheetId, [{
        updateSheetProperties: {
            properties: { sheetId, gridProperties: properties },
            fields: fields.join(',')
        }
    }]);
}
