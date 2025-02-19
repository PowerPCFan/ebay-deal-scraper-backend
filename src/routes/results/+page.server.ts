import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';

// Token management
interface TokenInfo {
    token: string;
    expiresAt: number;
}

let tokenCache: TokenInfo | null = null;
let authRetries = 0;
const MAX_AUTH_RETRIES = 3;
const TOKEN_REFRESH_INTERVAL = 6969; // seconds

function getTimestamp(): string {
    const date = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    return `[${date.toLocaleString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: timezone
    })} (${timezone})]`;
}

function logDebug(message: string, data?: any) {
    const timestamp = getTimestamp();
    console.log(`${timestamp} [Server] Debug: ${message}`, data || '');
}

async function getValidToken(): Promise<string | null> {
    const now = Math.floor(Date.now() / 1000);

    if (tokenCache && now < tokenCache.expiresAt) {
        logDebug('🔑 Using cached token', { 
            expiresIn: tokenCache.expiresAt - now,
            preview: `${tokenCache.token.substring(0, 5)}...`
        });
        return tokenCache.token;
    }

    try {
        if (!env.EBAY_APP_ID || !env.EBAY_CERT_ID) {
            logDebug('❌ Missing eBay credentials');
            return null;
        }

        const credentials = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64');
        const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${credentials}`
            },
            body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
        });

        if (!response.ok) {
            logDebug('❌ Token request failed', {
                status: response.status,
                statusText: response.statusText
            });
            return null;
        }

        const data = await response.json();
        tokenCache = {
            token: data.access_token,
            expiresAt: now + TOKEN_REFRESH_INTERVAL
        };

        logDebug('🔑 New token generated', {
            expiresIn: TOKEN_REFRESH_INTERVAL,
            preview: `${data.access_token.substring(0, 5)}...`
        });

        return data.access_token;
    } catch (err) {
        logDebug('❌ Token generation error', err);
        return null;
    }
}

interface EbayItem {
    title: string;
    price: { value: string };
    shippingOptions: Array<{ shippingCost: { value: string } }>;
    buyingOptions: string[];
    itemEndDate: string;
    itemWebUrl: string;
    image: { imageUrl: string }; // Add this line
}

export const load: PageServerLoad = async ({ url }) => {
    logDebug('🔍 Search initiated with URL params:', url.searchParams.toString());

    const searchQuery = url.searchParams.get('search');
    const filterType = url.searchParams.get('filter') || 'all';
    const sortBy = url.searchParams.get('sort') || 'best-match';
    const page = parseInt(url.searchParams.get('page') || '1', 10); // Get page number from query params
    const minPrice = url.searchParams.get('minPrice') || '';
    const maxPrice = url.searchParams.get('maxPrice') || '';
    const entriesPerPage = 20; // Number of results per page

    const offset = (page - 1) * entriesPerPage; // Calculate offset

    logDebug('🎯 Parsed parameters:', {
        searchQuery,
        filterType,
        sortBy,
        page,
        minPrice,
        maxPrice,
        rawUrl: url.toString()
    });

    if (!searchQuery) {
        logDebug('⚠️ No search query provided, returning empty results');
        return { results: [] };
    }

    function getEbaySortOrder(sortBy: string): string {
        switch (sortBy) {
            case 'price':
                return 'price';
            case 'end-time':
                return 'endTime';
            case 'best-match':
                return 'bestMatch';
            default:
                return 'bestMatch';
        }
    }

    try {
        const endpoint = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
        const params = new URLSearchParams({
            q: searchQuery,
            filter: filterType === 'all' ? '' : `buyingOptions:{${filterType.toUpperCase()}}`,
            sort: getEbaySortOrder(sortBy),
            limit: entriesPerPage.toString(), // Add limit parameter
            offset: offset.toString(), // Add offset parameter
            ...(minPrice && { priceMin: minPrice }),
            ...(maxPrice && { priceMax: maxPrice })
        });

        const requestUrl = `${endpoint}?${params}`;
        logDebug('🌐 Full API request URL:', requestUrl);

        while (authRetries < MAX_AUTH_RETRIES) {
            const token = await getValidToken();

            if (!token) {
                authRetries++;
                logDebug(`🔄 Auth retry ${authRetries}/${MAX_AUTH_RETRIES}`);
                if (authRetries === MAX_AUTH_RETRIES) {
                    throw error(401, 'Failed to authenticate with eBay after maximum retries');
                }
                continue;
            }

            const response = await fetch(requestUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            logDebug('📡 API Response:', {
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries())
            });

            if (response.status === 401 || response.status === 403) {
                tokenCache = null; // Clear invalid token
                authRetries++;
                continue;
            }

            if (!response.ok) {
                const errorText = await response.text();
                logDebug('❌ API Error Details:', {
                    status: response.status,
                    statusText: response.statusText,
                    error: errorText
                });
                throw error(response.status, `Failed to fetch from eBay API: ${response.statusText}`);
            }

            const data = await response.json();
            authRetries = 0; // Reset counter on success

            logDebug('📦 API Response structure:', {
                hasData: !!data,
                keys: Object.keys(data),
                total: data.total,
                itemCount: data.itemSummaries?.length || 0,
                firstItem: data.itemSummaries?.[0] ? Object.keys(data.itemSummaries[0]) : 'no items'
            });

            if (!data.itemSummaries) {
                logDebug('⚠️ No items found in response data structure');
                return { results: [] };
            }

            const results = data.itemSummaries.map((item: EbayItem) => {
                const shippingCost = item.shippingOptions?.[0]?.shippingCost?.value;
                const shippingText = shippingCost === '0.00' || shippingCost === undefined ? 'Free Shipping' : `+$${shippingCost} Shipping`;

                const processed = {
                    title: item.title,
                    price: item.price?.value || 'N/A',
                    shipping: shippingText,
                    type: item.buyingOptions?.[0] === 'FIXED_PRICE' ? 'Buy It Now' : item.buyingOptions?.[0] || 'Unknown',
                    timeRemaining: item.itemEndDate,
                    link: item.itemWebUrl,
                    thumbnail: item.image?.imageUrl || ''
                };
                return processed;
            });

            logDebug('✅ Final results:', {
                count: results.length,
                sample: results[0],
                searchParams: url.searchParams.toString()
            });

            return { results };
        }

        throw error(500, 'Maximum authentication retries reached');
    } catch (err) {
        logDebug('💥 Error details:', {
            error: err,
            message: err instanceof Error ? err.message : 'Unknown error',
            stack: err instanceof Error ? err.stack : 'No stack trace',
            params: url.searchParams.toString()
        });
        throw error(500, 'Failed to fetch results from eBay');
    }
};