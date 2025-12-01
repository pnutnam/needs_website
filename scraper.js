const { chromium } = require('playwright');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');

const MAX_RESULTS = 10;

// Helper to extract city from query (assumes "Topic in City" format)
function extractCity(query) {
    const parts = query.split(' in ');
    if (parts.length > 1) return parts[parts.length - 1];
    return query; // Fallback
}

function extractTopic(query) {
    const parts = query.split(' in ');
    if (parts.length > 1) return parts[0];
    return query;
}

function log(socket, message) {
    console.log(message);
    if (socket) socket.emit('log', message);
}

async function verifyNoWebsite(name, address, context, socket) {
    const page = await context.newPage();
    try {
        const query = `${name} ${address}`;
        log(socket, `Verifying website for: ${query}`);
        await page.goto('https://www.google.com/search?q=' + encodeURIComponent(query));

        // Check for common directories to ignore
        const ignoreDomains = [
            'yelp.com', 'yellowpages.com', 'facebook.com', 'instagram.com',
            'linkedin.com', 'mapquest.com', 'tripadvisor.com', 'angieslist.com',
            'bbb.org', 'thumbtack.com', 'porch.com', 'nextdoor.com'
        ];

        // Get first few organic results
        const results = await page.$$('div.g a');
        for (const result of results) {
            const href = await result.getAttribute('href');
            if (!href) continue;

            let isDirectory = false;
            for (const domain of ignoreDomains) {
                if (href.includes(domain)) {
                    isDirectory = true;
                    break;
                }
            }

            if (!isDirectory && !href.includes('google.com')) {
                log(socket, `Found potential website: ${href}`);
                return true; // Found a likely official website
            }
        }

        log(socket, 'No official website found in top results.');
        return false; // No official website found
    } catch (e) {
        console.error('Error verifying website:', e);
        return false;
    } finally {
        await page.close();
    }
}

async function getNearbyCities(city, context, socket) {
    const page = await context.newPage();
    let nearbyCities = [];

    // Strategy: Scrape citiesnear.com
    try {
        // Format city for URL: "Frisco, TX" -> "Frisco-TX"
        // Remove spaces, commas, etc.
        const formattedCity = city.replace(/,\s*/g, '-').replace(/\s+/g, '-');
        const url = `https://citiesnear.com/${formattedCity}`;

        log(socket, `Finding cities near: ${city} (via citiesnear.com)`);
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        // Selector found: a[href*="trippy.com/destination/"]
        // Also look for simple links in the main content area if that fails

        const links = await page.$$('a[href*="trippy.com/destination/"]');
        for (const link of links) {
            const text = await link.textContent();
            if (text) {
                // Clean up text (e.g. "Arlington (Texas)" -> "Arlington")
                // But keeping state is good.
                const clean = text.trim();
                if (!nearbyCities.includes(clean)) nearbyCities.push(clean);
            }
        }

        // Fallback: Try to find links that look like cities in the main list
        if (nearbyCities.length === 0) {
            // Look for links that are just city names
            const allLinks = await page.$$('a');
            for (const link of allLinks) {
                const href = await link.getAttribute('href');
                const text = await link.textContent();
                if (href && href.includes('distance') && text && text.match(/^[A-Z][a-zA-Z\s]+$/)) {
                    if (!nearbyCities.includes(text)) nearbyCities.push(text);
                }
            }
        }

    } catch (e) {
        log(socket, `citiesnear.com search failed: ${e.message}`);
    }

    await page.close();

    // Filter out the original city and duplicates
    const unique = [...new Set(nearbyCities)];
    return unique.filter(c => c.toLowerCase() !== city.toLowerCase());
}

async function scrapeGoogleMaps(query, context, csvWriter, socket) {
    const page = await context.newPage();
    let verifiedInThisBatch = 0;

    try {
        log(socket, `Scraping Maps for: ${query}`);
        await page.goto('https://www.google.com/maps');

        try { await page.click('button[aria-label="Accept all"]', { timeout: 3000 }); } catch (e) { }

        await page.fill('#searchboxinput', query);
        await page.keyboard.press('Enter');

        // Wait for results
        try {
            await page.waitForSelector('div[role="feed"]', { timeout: 10000 });
        } catch (e) {
            log(socket, 'No results found for this query.');
            return 0;
        }

        // Scroll to load ALL results
        const feedSelector = 'div[role="feed"]';
        let previousHeight = 0;
        let noChangeCount = 0;

        while (true) {
            const currentHeight = await page.evaluate((selector) => {
                const feed = document.querySelector(selector);
                if (feed) {
                    feed.scrollTo(0, feed.scrollHeight);
                    return feed.scrollHeight;
                }
                return 0;
            }, feedSelector);

            await page.waitForTimeout(2000);

            if (currentHeight === previousHeight) {
                noChangeCount++;
                if (noChangeCount >= 3) break;
            } else {
                noChangeCount = 0;
            }
            previousHeight = currentHeight;
        }

        const listings = await page.$$('a[href*="/maps/place/"]');
        const urls = [];
        for (const listing of listings) {
            const href = await listing.getAttribute('href');
            if (href && !urls.includes(href)) urls.push(href);
        }

        log(socket, `Found ${urls.length} listings in ${query}. Processing all...`);

        for (const url of urls) {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded' });
                const data = { url, name: '', address: '', website: '', phone: '', status: '' };

                try { data.name = await page.textContent('h1'); } catch (e) { }

                const buttons = await page.$$('button[data-item-id]');
                for (const btn of buttons) {
                    const text = await btn.textContent();
                    const aria = await btn.getAttribute('aria-label');
                    const id = await btn.getAttribute('data-item-id');
                    if (id.includes('address')) data.address = aria || text;
                    if (id.includes('phone')) data.phone = aria || text;
                }

                // Check for email in buttons (rare but possible) or text
                // Also check for website
                const websiteLink = await page.$('a[data-item-id="authority"]');
                if (websiteLink) data.website = await websiteLink.getAttribute('href');

                // Helper to check if a URL is just a platform/directory
                const isPlatformUrl = (url) => {
                    if (!url) return false;
                    const platforms = [
                        'facebook.com', 'yelp.com', 'instagram.com', 'linkedin.com',
                        'yellowpages.com', 'angieslist.com', 'thumbtack.com', 'nextdoor.com',
                        'porch.com', 'bbb.org', 'mapquest.com', 'tripadvisor.com', 'twitter.com'
                    ];
                    return platforms.some(p => url.toLowerCase().includes(p));
                };

                // Email Extraction Logic
                // 1. Try to find email on the Maps page (rare)
                // 2. If website exists and is not a platform, visit it to find email
                if (data.website && !isPlatformUrl(data.website)) {
                    try {
                        log(socket, `Visiting website to find email: ${data.website}`);
                        const page2 = await context.newPage();
                        await page2.goto(data.website, { timeout: 15000, waitUntil: 'domcontentloaded' });

                        const content = await page2.content();
                        const emailRegex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+/gi;
                        const emails = content.match(emailRegex);

                        if (emails) {
                            const uniqueEmails = [...new Set(emails)].filter(email => {
                                const lower = email.toLowerCase();
                                return !lower.match(/\.(png|jpg|jpeg|gif|css|js|webp|svg)$/) &&
                                    !lower.includes('sentry') &&
                                    !lower.includes('wix') &&
                                    !lower.includes('node_modules') &&
                                    !lower.includes('example.com') &&
                                    !lower.includes('domain.com');
                            });
                            if (uniqueEmails.length > 0) {
                                data.email = uniqueEmails[0]; // Take the first one
                                log(socket, `Found email: ${data.email}`);
                            }
                        }
                        await page2.close();
                    } catch (e) {
                        log(socket, `Could not extract email from website: ${e.message}`);
                    }
                }

                // Logic: If NO website on maps OR it's just a platform link, verify with Google Search
                if (!data.website || isPlatformUrl(data.website)) {
                    const hasWebsite = await verifyNoWebsite(data.name, data.address, context, socket);
                    if (!hasWebsite) {
                        // Confirmed NO website
                        verifiedInThisBatch++;
                        if (data.website) {
                            data.status = 'Platform Only';
                            log(socket, `[KEPT] ${data.name} - Has platform website only: ${data.website}`);
                        } else {
                            data.status = 'No Website';
                            log(socket, `[KEPT] ${data.name} - No website found.`);
                        }
                    } else {
                        // Found website via search
                        data.status = 'Found via Search';
                        log(socket, `[LOGGED] ${data.name} - Found official website via Google Search.`);
                    }
                } else {
                    // Has official Maps website
                    data.status = 'Official Website';
                    log(socket, `[LOGGED] ${data.name} - Has official Maps website: ${data.website}`);
                }

                // Always write to CSV
                if (csvWriter) await csvWriter.writeRecords([data]);
                if (socket) socket.emit('new-result', data);

            } catch (e) {
                console.error(`Error scraping listing ${url}:`, e);
            }
        }

    } catch (e) {
        console.error(`Error scraping maps for ${query}:`, e);
    } finally {
        await page.close();
    }

    return verifiedInThisBatch;
}

module.exports = async function runScraper(initialQuery, socket) {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();

    const finalResults = [];
    const visitedCities = new Set();
    const cityQueue = [extractCity(initialQuery)];
    const topic = extractTopic(initialQuery);

    // Generate filename from query
    const safeFilename = initialQuery
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') + '.csv';

    log(socket, `Saving results to: ${safeFilename}`);

    if (!fs.existsSync(safeFilename)) {
        const header = 'Name,Address,Phone,Website,Email,Maps URL,Status\n';
        fs.writeFileSync(safeFilename, header);
    }

    // Writer for appending
    const csvWriter = createCsvWriter({
        path: safeFilename,
        header: [
            { id: 'name', title: 'Name' },
            { id: 'address', title: 'Address' },
            { id: 'phone', title: 'Phone' },
            { id: 'website', title: 'Website' },
            { id: 'email', title: 'Email' },
            { id: 'url', title: 'Maps URL' },
            { id: 'status', title: 'Status' }
        ],
        append: true
    });

    let verifiedCount = 0;

    try {
        while (verifiedCount < MAX_RESULTS && cityQueue.length > 0) {
            const currentCity = cityQueue.shift();
            if (visitedCities.has(currentCity)) continue;
            visitedCities.add(currentCity);

            const query = `${topic} in ${currentCity}`;
            log(socket, `\n--- Processing: ${query} ---`);

            // Pass csvWriter and verifiedCount updater to scrapeGoogleMaps
            // We need to know how many verified results were found in this batch to update the global counter
            const newVerifiedCount = await scrapeGoogleMaps(query, context, csvWriter, socket);
            verifiedCount += newVerifiedCount;

            log(socket, `Total verified "no website" results so far: ${verifiedCount}`);
            if (socket) socket.emit('progress', { verified: verifiedCount, target: MAX_RESULTS });

            if (verifiedCount < MAX_RESULTS) {
                log(socket, `Need more results. Finding cities near ${currentCity}...`);
                const neighbors = await getNearbyCities(currentCity, context, socket);
                for (const neighbor of neighbors) {
                    if (!visitedCities.has(neighbor) && !cityQueue.includes(neighbor)) {
                        cityQueue.push(neighbor);
                    }
                }
                if (cityQueue.length === 0) {
                    log(socket, "No more cities to search.");
                    break;
                }
            }
        }
    } catch (error) {
        console.error('Fatal error:', error);
        log(socket, `Error: ${error.message}`);
    } finally {
        await browser.close();
        if (socket) socket.emit('scrape-complete', { filename: safeFilename });
    }

    return safeFilename;
};
