import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";

const BASE = "https://www.fruitpunch.ai";
const OUT = path.resolve("offline");
const ASSETS_DIR = path.join(OUT, "_assets");
const API_DATA_DIR = path.join(OUT, "_api_data"); // Store intercepted API responses
const CONCURRENCY = 1; // Reduced to 1 for headful mode to handle Cloudflare challenges

const parser = new XMLParser({ ignoreAttributes: false });

// Track downloaded assets to avoid duplicates
const downloadedAssets = new Map();

// Track intercepted API responses
const apiResponses = new Map();

function safeFileName(urlPath) {
  // "/" -> "index", "/about/" -> "about/index", "/a/b" -> "a/b"
  let p = urlPath.split("?")[0].split("#")[0];
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (p === "") return "index";
  return p.replace(/^\/+/, "");
}

async function fetchText(url, browser = null) {
  // If browser is provided, use Playwright (better for Cloudflare protection)
  if (browser) {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    const page = await context.newPage();
    try {
      console.log(`  📥 Fetching ${url}...`);
      // Navigate and wait for Cloudflare challenge if present
      const response = await page.goto(url, { 
        waitUntil: "networkidle", 
        timeout: 60000 
      });
      
      // Wait a bit for any Cloudflare checks
      await page.waitForTimeout(5000);
      
      // Check if we got blocked or redirected
      const finalUrl = page.url();
      const pageTitle = await page.title().catch(() => '');
      
      if (finalUrl.includes('challenge') || finalUrl.includes('cf-browser-verification') || 
          pageTitle.includes('Just a moment') || pageTitle.includes('Checking your browser')) {
        console.log(`  ⏳ Cloudflare challenge detected, waiting up to 30 seconds...`);
        // Wait for the challenge to complete
        try {
          await page.waitForFunction(
            () => {
              const title = document.title || '';
              return !title.includes('Just a moment') && !title.includes('Checking');
            },
            { timeout: 30000 }
          );
          await page.waitForTimeout(5000); // Extra wait after challenge
          console.log(`  ✅ Cloudflare challenge passed`);
        } catch (e) {
          console.log(`  ⚠️  Cloudflare challenge may still be active, continuing anyway...`);
        }
      }
      
      // Get the content - for XML, try to get raw response text
      let text;
      if (url.includes('sitemap') || url.endsWith('.xml')) {
        // For XML, try to get the response text directly
        try {
          if (response) {
            text = await response.text().catch(() => null);
            if (text && (text.includes('<?xml') || text.includes('<urlset') || text.includes('<sitemapindex'))) {
              await context.close();
              return text;
            }
          }
        } catch (e) {
          // Fall through to page content
        }
        
        // Fallback: try to get XML from page
        try {
          text = await page.evaluate(() => {
            // Look for XML in pre tag (common for XML served as HTML)
            const pre = document.querySelector('pre');
            if (pre && (pre.textContent.includes('<?xml') || pre.textContent.includes('<urlset'))) {
              return pre.textContent;
            }
            // Try body text
            const bodyText = document.body?.innerText || document.body?.textContent || '';
            if (bodyText.includes('<?xml') || bodyText.includes('<urlset')) {
              return bodyText;
            }
            // Fallback to full HTML
            return document.documentElement.outerHTML;
          });
        } catch (e) {
          text = await page.content();
        }
      } else {
        text = await page.content();
      }
      
      await context.close();
      return text;
    } catch (e) {
      await context.close();
      // Better error message
      if (e.message.includes('net::ERR') || e.message.includes('Navigation') || e.message.includes('timeout')) {
        throw new Error(`Failed to load ${url}: ${e.message}. This might be due to Cloudflare protection. Try running the script again.`);
      }
      throw e;
    }
  }
  
  // Fallback to native fetch with better headers
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1"
    }
  });
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`);
  return await res.text();
}

async function getUrlsFromSitemap(browser = null) {
  // Check if we have a cached sitemap
  const cachedSitemapPath = path.join(OUT, '_sitemap.xml');
  if (fs.existsSync(cachedSitemapPath)) {
    console.log(`  📁 Using cached sitemap from ${cachedSitemapPath}`);
    const xml = fs.readFileSync(cachedSitemapPath, 'utf-8');
    const data = parser.parse(xml);
    // Process the cached sitemap
    if (data.sitemapindex?.sitemap) {
      const sitemaps = Array.isArray(data.sitemapindex.sitemap) ? data.sitemapindex.sitemap : [data.sitemapindex.sitemap];
      const urls = [];
      for (const sm of sitemaps) {
        const smUrl = sm.loc || sm['@_loc'] || sm;
        if (typeof smUrl === 'string') {
          const smXml = await fetchText(smUrl, browser);
          const smData = parser.parse(smXml);
          const entries = smData.urlset?.url ?? [];
          const list = Array.isArray(entries) ? entries : [entries];
          for (const u of list) {
            const url = u.loc || u['@_loc'] || u;
            if (typeof url === 'string') urls.push(url);
          }
        }
      }
      return [...new Set(urls)];
    }
    const entries = data.urlset?.url ?? [];
    const list = Array.isArray(entries) ? entries : [entries];
    return [...new Set(list.map((u) => u.loc || u['@_loc'] || u).filter(Boolean))];
  }
  
  const sitemapUrl = `${BASE}/sitemap.xml`;
  const xml = await fetchText(sitemapUrl, browser);
  
  // Save sitemap for future use
  if (xml && xml.length > 100 && (xml.includes('<?xml') || xml.includes('<urlset') || xml.includes('<sitemapindex'))) {
    ensureDir(OUT);
    fs.writeFileSync(cachedSitemapPath, xml, 'utf-8');
    console.log(`  💾 Saved sitemap to ${cachedSitemapPath} for future use`);
  }
  
  // Debug: check if we got valid XML
  if (!xml || xml.length < 100) {
    console.error(`⚠️  Received very short response (${xml?.length || 0} chars). Content preview:`, xml?.substring(0, 200));
    throw new Error(`Invalid sitemap response from ${sitemapUrl}`);
  }
  
  // Check if it's actually XML
  if (!xml.includes('<?xml') && !xml.includes('<urlset') && !xml.includes('<sitemapindex')) {
    console.error(`⚠️  Response doesn't look like XML. First 500 chars:`, xml.substring(0, 500));
    // Save for debugging
    fs.writeFileSync(path.join(OUT, '_sitemap_debug.html'), xml);
    console.error(`  💾 Saved response to offline/_sitemap_debug.html for inspection`);
    throw new Error(`Sitemap response doesn't appear to be XML. Might be a Cloudflare challenge page.`);
  }
  
  // Clean up XML if it's wrapped in HTML
  let cleanXml = xml;
  if (xml.includes('<html') || xml.includes('<!DOCTYPE')) {
    // Extract XML from HTML
    const xmlMatch = xml.match(/<(?:\?xml|urlset|sitemapindex)[\s\S]*?<\/urlset>|<\/sitemapindex>/i);
    if (xmlMatch) {
      cleanXml = xmlMatch[0];
      console.log(`  🔧 Extracted XML from HTML wrapper`);
    }
  }
  
  const data = parser.parse(cleanXml);

  // sitemapindex or urlset
  if (data.sitemapindex?.sitemap) {
    const sitemaps = Array.isArray(data.sitemapindex.sitemap)
      ? data.sitemapindex.sitemap
      : [data.sitemapindex.sitemap];

    console.log(`  Found sitemap index with ${sitemaps.length} sitemap(s)`);
    const urls = [];
    for (const sm of sitemaps) {
      const smUrl = sm.loc || sm['@_loc'] || sm;
      if (typeof smUrl === 'string') {
        console.log(`  Fetching sitemap: ${smUrl}`);
        const smXml = await fetchText(smUrl, browser);
      const smData = parser.parse(smXml);
      const entries = smData.urlset?.url ?? [];
      const list = Array.isArray(entries) ? entries : [entries];
        for (const u of list) {
          const url = u.loc || u['@_loc'] || u;
          if (typeof url === 'string') {
            urls.push(url);
          }
        }
      }
    }
    const uniqueUrls = [...new Set(urls)];
    console.log(`  Found ${uniqueUrls.length} unique URLs from sitemap index`);
    return uniqueUrls;
  }

  // Direct urlset
  const entries = data.urlset?.url ?? [];
  const list = Array.isArray(entries) ? entries : [entries];
  const urls = list.map((u) => u.loc || u['@_loc'] || u).filter(Boolean);
  const uniqueUrls = [...new Set(urls)];
  console.log(`  Found ${uniqueUrls.length} unique URLs from sitemap`);
  return uniqueUrls;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function normalizeOrigin(origin) {
  // Remove www. prefix from hostname for comparison (www.fruitpunch.ai and fruitpunch.ai are the same)
  const url = new URL(origin);
  url.hostname = url.hostname.replace(/^www\./, '');
  return url.origin;
}

function getUrlsFromExistingScrape() {
  const urls = new Set();
  
  // Read from report if it exists
  const reportPath = path.join(OUT, "_report.json");
  if (fs.existsSync(reportPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
      // We don't have URLs in report, but we can reconstruct from directory structure
    } catch (e) {
      // Ignore
    }
  }
  
  // Reconstruct URLs from directory structure
  function scanDirectory(dir, basePath = '') {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('_')) continue; // Skip _assets, _report, etc.
        
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const newBase = basePath ? `${basePath}/${entry.name}` : entry.name;
          scanDirectory(fullPath, newBase);
        } else if (entry.name === 'index.html') {
          // Reconstruct URL from path
          let urlPath = basePath || '/';
          if (urlPath !== '/') {
            urlPath = '/' + urlPath;
          }
          urls.add(`${BASE}${urlPath}`);
        }
      }
    } catch (e) {
      // Ignore errors
    }
  }
  
  if (fs.existsSync(OUT)) {
    scanDirectory(OUT);
  }
  
  return Array.from(urls);
}

function getAssetPath(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const ext = path.extname(pathname) || '.html';
    const basename = path.basename(pathname, ext) || 'index';
    const dir = path.dirname(pathname).replace(/^\//, '').replace(/\//g, '_');
    const filename = dir ? `${dir}_${basename}${ext}` : `${basename}${ext}`;
    // Sanitize filename
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  } catch {
    return 'asset_' + url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  }
}

async function downloadAsset(url, pageUrl) {
  try {
    // Skip data URLs and blob URLs
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return null;
    }

    // Resolve relative URLs
    let absoluteUrl;
    try {
      absoluteUrl = new URL(url, pageUrl).href;
    } catch {
      return null;
    }

    // Skip if already downloaded
    if (downloadedAssets.has(absoluteUrl)) {
      return downloadedAssets.get(absoluteUrl);
    }

    // Only download assets from the same origin or common CDNs
    const urlObj = new URL(absoluteUrl);
    const baseOrigin = new URL(BASE).origin;
    const isSameOrigin = normalizeOrigin(urlObj.origin) === normalizeOrigin(baseOrigin);
    const isCommonCDN = urlObj.hostname.includes('cdn.prod.website-files.com') ||
                       urlObj.hostname.includes('fonts.googleapis.com') ||
                       urlObj.hostname.includes('fonts.gstatic.com') ||
                       urlObj.hostname.includes('cdn.jsdelivr.net') ||
                       urlObj.hostname.includes('unpkg.com') ||
                       urlObj.hostname.includes('ajax.googleapis.com') ||
                       urlObj.hostname.includes('downloads.mailchimp.com') ||
                       urlObj.hostname.includes('chimpstatic.com');

    if (!isSameOrigin && !isCommonCDN) {
      return null;
    }

    const res = await fetch(absoluteUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!res.ok) {
      return null;
    }

    const contentType = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());
    
    // Determine file extension from content type or URL
    let ext = path.extname(urlObj.pathname);
    if (!ext || ext === '') {
      if (contentType.includes('css')) ext = '.css';
      else if (contentType.includes('javascript')) ext = '.js';
      else if (contentType.includes('image')) {
        if (contentType.includes('png')) ext = '.png';
        else if (contentType.includes('jpg') || contentType.includes('jpeg')) ext = '.jpg';
        else if (contentType.includes('svg')) ext = '.svg';
        else if (contentType.includes('gif')) ext = '.gif';
        else if (contentType.includes('webp')) ext = '.webp';
      } else if (contentType.includes('font') || contentType.includes('woff')) {
        if (contentType.includes('woff2')) ext = '.woff2';
        else if (contentType.includes('woff')) ext = '.woff';
        else if (contentType.includes('ttf')) ext = '.ttf';
        else if (contentType.includes('otf')) ext = '.otf';
      }
    }

    const filename = getAssetPath(urlObj.pathname) + ext;
    const filepath = path.join(ASSETS_DIR, filename);

    ensureDir(ASSETS_DIR);
    fs.writeFileSync(filepath, buffer);

    const relativePath = path.relative(OUT, filepath).replace(/\\/g, '/');
    downloadedAssets.set(absoluteUrl, relativePath);
    
    return relativePath;
  } catch (e) {
    console.log(`  ⚠️  Failed to download asset ${url}: ${e.message}`);
    return null;
  }
}

async function extractAssetsFromCss(cssContent, cssUrl) {
  const assets = new Set();
  
  // Extract @import URLs
  const importMatches = cssContent.matchAll(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?/gi);
  for (const match of importMatches) {
    assets.add(match[1]);
  }
  
  // Extract url() references
  const urlMatches = cssContent.matchAll(/url\(["']?([^"')]+)["']?\)/gi);
  for (const match of urlMatches) {
    const url = match[1].trim();
    if (!url.startsWith('data:') && !url.startsWith('#')) {
      assets.add(url);
    }
  }
  
  return assets;
}

async function rewriteHtml(html, pageUrl, pageDir) {
  // Collect all asset URLs first
  const assetUrls = new Set();

  // Find CSS links
  html.replace(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi, (match, href) => {
    if (!href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
      assetUrls.add(href);
    }
  });

  // Find script sources
  html.replace(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      assetUrls.add(src);
    }
  });

  // Find image sources
  html.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      assetUrls.add(src);
    }
  });

  // Find srcset URLs
  html.replace(/srcset=["']([^"']+)["']/gi, (match, srcset) => {
    srcset.split(',').forEach(part => {
      const url = part.trim().split(/\s+/)[0];
      if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
        assetUrls.add(url);
      }
    });
  });

  // Download all assets in parallel
  const assetMap = new Map();
  const cssFiles = new Map(); // Track CSS files to rewrite later
  
  const downloadPromises = Array.from(assetUrls).map(async (url) => {
    const localPath = await downloadAsset(url, pageUrl);
    if (localPath) {
      assetMap.set(url, localPath);
      
      // If it's a CSS file, extract and download assets from it
      if (url.endsWith('.css') || url.includes('.css?') || localPath.endsWith('.css')) {
        try {
          const cssPath = path.join(OUT, localPath);
          if (fs.existsSync(cssPath)) {
            const cssContent = fs.readFileSync(cssPath, 'utf-8');
            cssFiles.set(localPath, { content: cssContent, url });
            
            const cssAssets = await extractAssetsFromCss(cssContent, url);
            
            // Download CSS assets
            for (const cssAssetUrl of cssAssets) {
              const cssAssetPath = await downloadAsset(cssAssetUrl, url);
              if (cssAssetPath) {
                assetMap.set(cssAssetUrl, cssAssetPath);
              }
            }
          }
        } catch (e) {
          // Ignore CSS parsing errors
        }
      }
    }
  });

  await Promise.all(downloadPromises);
  
  // Rewrite CSS files to use local asset paths
  for (const [cssLocalPath, { content: cssContent, url: cssUrl }] of cssFiles) {
    let updatedCss = cssContent;
    
    // Rewrite url() references
    updatedCss = updatedCss.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, assetUrl) => {
      const trimmedUrl = assetUrl.trim();
      if (trimmedUrl.startsWith('data:') || trimmedUrl.startsWith('#')) {
        return match;
      }
      
      const localAssetPath = assetMap.get(trimmedUrl) || assetMap.get(new URL(trimmedUrl, cssUrl).href);
      if (localAssetPath) {
        const cssDir = path.dirname(path.join(OUT, cssLocalPath));
        const assetDir = path.dirname(path.join(OUT, localAssetPath));
        const relativePath = path.relative(cssDir, path.join(OUT, localAssetPath)).replace(/\\/g, '/');
        return `url("${relativePath}")`;
      }
      return match;
    });
    
    // Save updated CSS
    if (updatedCss !== cssContent) {
      fs.writeFileSync(path.join(OUT, cssLocalPath), updatedCss, 'utf-8');
    }
  }

  // Rewrite CSS links
  html = html.replace(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi, (match, href) => {
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return match;
    }
    const localPath = assetMap.get(href);
    if (localPath) {
      const relativePath = path.relative(pageDir, path.join(OUT, localPath)).replace(/\\/g, '/');
      return match.replace(href, relativePath);
    }
    return match;
  });

  // Rewrite script sources
  html = html.replace(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    if (src.startsWith('data:') || src.startsWith('blob:')) {
      return match;
    }
    const localPath = assetMap.get(src);
    if (localPath) {
      const relativePath = path.relative(pageDir, path.join(OUT, localPath)).replace(/\\/g, '/');
      return match.replace(src, relativePath);
    }
    return match;
  });

  // Rewrite image sources
  html = html.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    if (src.startsWith('data:') || src.startsWith('blob:')) {
      return match;
    }
    const localPath = assetMap.get(src);
    if (localPath) {
      const relativePath = path.relative(pageDir, path.join(OUT, localPath)).replace(/\\/g, '/');
      return match.replace(src, relativePath);
    }
    return match;
  });

  // Rewrite image srcset
  html = html.replace(/srcset=["']([^"']+)["']/gi, (match, srcset) => {
    const newSrcset = srcset.split(',').map(part => {
      const [url, ...rest] = part.trim().split(/\s+/);
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return part.trim();
      }
      const localPath = assetMap.get(url);
      if (localPath) {
        const relativePath = path.relative(pageDir, path.join(OUT, localPath)).replace(/\\/g, '/');
        return [relativePath, ...rest].join(' ');
      }
      return part.trim();
    }).join(', ');
    return `srcset="${newSrcset}"`;
  });

  return html;
}

function rewriteInternalLinks(html, pageUrl, pageDir) {
  const pageUrlObj = new URL(pageUrl);
  const baseUrlObj = new URL(BASE);
  
  // Helper to check if a path exists locally
  function localPathExists(urlPath) {
    const targetPath = safeFileName(urlPath);
    const targetFile = path.join(OUT, targetPath, 'index.html');
    return fs.existsSync(targetFile);
  }
  
  // Rewrite internal links (same origin, relative paths)
  html = html.replace(/href=["']([^"']+)["']/gi, (match, href) => {
    // Skip anchors, mailto, tel, javascript, data URLs
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || 
        href.startsWith('javascript:') || href.startsWith('data:') || href === '#' || href === '') {
      return match;
    }
    
    let targetPath = null;
    
    // Handle absolute URLs (http/https)
    if (href.startsWith('http://') || href.startsWith('https://')) {
      try {
        const hrefUrl = new URL(href);
        // Check if it's the same origin
        if (normalizeOrigin(hrefUrl.origin) === normalizeOrigin(baseUrlObj.origin)) {
          targetPath = hrefUrl.pathname;
        } else {
          // External link - keep as is (won't work offline but that's expected)
          return match;
        }
      } catch {
        return match;
      }
    }
    // Handle absolute paths (starting with /)
    else if (href.startsWith('/')) {
      targetPath = href;
    }
    // Handle relative paths
    else if (!href.startsWith('//')) {
      try {
        const resolvedUrl = new URL(href, pageUrl);
        if (normalizeOrigin(resolvedUrl.origin) === normalizeOrigin(baseUrlObj.origin)) {
          targetPath = resolvedUrl.pathname;
        } else {
          return match;
        }
      } catch {
        return match;
      }
    } else {
      return match;
    }
    
    // Convert to local file path
    if (targetPath) {
      const localPath = safeFileName(targetPath);
      const targetFile = path.join(OUT, localPath, 'index.html');
      
      // Only rewrite if the file exists locally
      if (fs.existsSync(targetFile)) {
        const relativePath = path.relative(pageDir, targetFile).replace(/\\/g, '/');
        return match.replace(href, relativePath);
      }
    }
    
    return match;
  });
  
  return html;
}

function injectApiInterceptor(html, pageUrl, pageDir) {
  // Inject a script that intercepts API calls and serves cached responses offline
  const apiInterceptorScript = `
<script>
(function() {
  // API response cache
  const apiCache = {};
  
  // Load API responses for this page
  async function loadApiResponses() {
    try {
      const apiDataDir = '../_api_data/';
      // We'll need to know which API files belong to this page
      // For now, we'll try to intercept at runtime
    } catch (e) {
      console.log('Failed to load API responses:', e);
    }
  }
  
  // Intercept fetch calls
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0];
    
    // Check if this is a Webflow API call
    if (typeof url === 'string' && (url.includes('api.webflow.com') || url.includes('webflow.com/api'))) {
      // Try to load from cache
      const cacheKey = btoa(url).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);
      const apiPath = '../_api_data/' + cacheKey + '.json';
      
      return fetch(apiPath)
        .then(response => response.json())
        .then(data => {
          // Return a Response-like object
          return new Response(data.response.body, {
            status: data.response.status,
            statusText: data.response.statusText,
            headers: data.response.headers
          });
        })
        .catch(() => {
          // If cache miss, try original fetch (will fail offline, but that's expected)
          return originalFetch.apply(this, args);
        });
    }
    
    // For non-API calls, use original fetch
    return originalFetch.apply(this, args);
  };
  
  // Intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };
  
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._url && (this._url.includes('api.webflow.com') || this._url.includes('webflow.com/api'))) {
      const cacheKey = btoa(this._url).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);
      const apiPath = '../_api_data/' + cacheKey + '.json';
      
      fetch(apiPath)
        .then(response => response.json())
        .then(data => {
          // Simulate XHR response
          Object.defineProperty(this, 'status', { value: data.response.status, writable: false });
          Object.defineProperty(this, 'statusText', { value: data.response.statusText, writable: false });
          Object.defineProperty(this, 'responseText', { value: data.response.body, writable: false });
          Object.defineProperty(this, 'readyState', { value: 4, writable: false });
          
          if (this.onload) this.onload();
          if (this.onreadystatechange) this.onreadystatechange();
        })
        .catch(() => {
          // If cache miss, try original send (will fail offline)
          return originalXHRSend.apply(this, args);
        });
      
      return;
    }
    
    return originalXHRSend.apply(this, args);
  };
  
  // Load API responses on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadApiResponses);
  } else {
    loadApiResponses();
  }
})();
</script>`;
  
  // Inject before closing </head> tag
  if (html.includes('</head>')) {
    html = html.replace('</head>', apiInterceptorScript + '</head>');
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', apiInterceptorScript + '</body>');
  }
  
  return html;
}

function removeExternalDependencies(html) {
  // Safely remove tracking scripts by matching script tags with specific src attributes
  html = html.replace(/<script[^>]*src=["']https?:\/\/[^"']*googletagmanager[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Tracking script removed for offline -->');
  html = html.replace(/<script[^>]*src=["']https?:\/\/[^"']*clarity\.ms[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Tracking script removed for offline -->');
  html = html.replace(/<script[^>]*src=["']https?:\/\/[^"']*snap\.licdn[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Tracking script removed for offline -->');
  html = html.replace(/<script[^>]*src=["']https?:\/\/[^"']*chimpstatic[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Tracking script removed for offline -->');
  html = html.replace(/<script[^>]*src=["']https?:\/\/[^"']*mailchimp[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Mailchimp script removed -->');
  
  // For inline scripts, be very careful - only match small inline scripts (under 2000 chars)
  html = html.replace(/<script[^>]*>([^<]{0,2000}?(gtag|google-analytics|clarity|_linkedin_partner_id|dataLayer\.push)[^<]{0,2000}?)<\/script>/gi, '<!-- Tracking script removed for offline -->');
  
  // Remove Mailchimp script by id
  html = html.replace(/<script[^>]*id=["']mcjs["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Mailchimp script removed -->');
  
  // DON'T try to remove popup HTML with regex - it's too dangerous and can strip page content
  // Instead, just hide popups with CSS (much safer)
  const hidePopupCSS = `<style>
    .mc-modal, .mc-modal-bg, .mc-banner, #PopupSignupForm_0, [id^="PopupSignupForm"],
    [class*="mc-modal"], [class*="mc-banner"], [class*="popup-overlay"] { 
      display: none !important; 
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
  </style>`;
  if (html.includes('</head>')) {
    html = html.replace('</head>', hidePopupCSS + '</head>');
  }
  
  // Remove external font preconnect (fonts are downloaded)
  html = html.replace(/<link[^>]*rel=["']preconnect["'][^>]*href=["']https?:\/\/fonts\.(googleapis|gstatic)\.com[^"']*["'][^>]*>/gi, '<!-- Font preconnect removed -->');
  
  // Remove external script tags that load dynamically (limit to small scripts under 3000 chars)
  html = html.replace(/<script[^>]*>([^<]{0,3000}?\.src\s*=\s*["']https?:\/\/[^"']+["'][^<]{0,3000}?)<\/script>/gi, (match, content) => {
    // Only remove if it's a tracking/analytics script
    if (content.match(/(googletagmanager|clarity|analytics|tracking|mailchimp|chimpstatic|linkedin|insight\.min\.js)/i)) {
      return '<!-- Dynamic tracking script removed -->';
    }
    return match;
  });
  
  // Remove LinkedIn tracking pixel
  html = html.replace(/<img[^>]*src=["']https?:\/\/[^"']*linkedin[^"']*["'][^>]*>/gi, '<!-- LinkedIn tracking pixel removed -->');
  
  // Remove external stylesheets that weren't downloaded (protocol-relative URLs)
  html = html.replace(/<link[^>]*href=["']\/\/[^"']*["'][^>]*>/gi, (match) => {
    if (match.includes('mailchimp') || match.includes('downloads.mailchimp')) {
      return '<!-- External Mailchimp stylesheet removed -->';
    }
    return match;
  });
  
  // Disable WebFont.load for Google Fonts (fonts should be downloaded)
  html = html.replace(/WebFont\.load\s*\(\s*\{[^}]*google[^}]*\}/gi, '/* WebFont.load disabled for offline */');
  
  // Remove any remaining external script src attributes
  html = html.replace(/<script([^>]*)\ssrc=["']https?:\/\/(?!cdn\.prod\.website-files\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|ajax\.googleapis\.com)[^"']+["']([^>]*)>/gi, (match, before, after) => {
    // Check if it's a tracking script
    if (match.match(/(googletagmanager|clarity|analytics|tracking|mailchimp|chimpstatic|linkedin|insight)/i)) {
      return `<!-- External script removed: ${match} -->`;
    }
    return match;
  });
  
  return html;
}

async function scrapeUrls(urlsToScrape, timeout = 60000) {
  ensureDir(OUT);
  ensureDir(ASSETS_DIR);
  ensureDir(API_DATA_DIR);

  console.log(`Scraping ${urlsToScrape.length} URL(s)`);
  console.log(`Assets will be saved to: ${ASSETS_DIR}\n`);
  console.log(`🌐 Browser will open in visible mode. If you see Cloudflare challenges, please complete them manually.\n`);

  // Use headful mode to help with Cloudflare challenges
  const browser = await chromium.launch({ 
    headless: false,
    slowMo: 100 // Slow down operations slightly to appear more human-like
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  const limit = pLimit(CONCURRENCY);

  const results = await Promise.all(
    urlsToScrape.map((fullUrl) =>
      limit(async () => {
        const u = new URL(fullUrl);
        // Normalize origins to handle www vs non-www
        if (normalizeOrigin(u.origin) !== normalizeOrigin(BASE)) {
          return { url: fullUrl, ok: false, reason: "Different origin" };
        }

        const page = await context.newPage();
        const pageAssets = new Set(); // Track assets for this page
        
        // Also listen to all requests to catch API calls that might be missed
        page.on('request', (request) => {
          const url = request.url();
          if (url.includes('webflow.com') && (url.includes('api') || url.includes('collection') || url.includes('item'))) {
            console.log(`  📡 Detected Webflow request: ${url.substring(0, 100)}...`);
          }
        });
        
        page.on('response', async (response) => {
          const url = response.url();
          if (url.includes('webflow.com') && (url.includes('api') || url.includes('collection') || url.includes('item'))) {
            try {
              const contentType = response.headers()['content-type'] || '';
              if (contentType.includes('json') || contentType.includes('application/json')) {
                console.log(`  📥 Received Webflow API response: ${url.substring(0, 100)}...`);
              }
            } catch (e) {
              // Ignore errors
            }
          }
        });
        
        // Intercept network requests to capture all assets and API responses
        await page.route('**/*', async (route) => {
          const request = route.request();
          const url = request.url();
          const resourceType = request.resourceType();
          
          // Intercept Webflow CMS API calls - be more aggressive in detection
          const isWebflowApi = url.includes('api.webflow.com') || 
                              url.includes('webflow.com/api') || 
                              url.includes('/v1/collections/') || 
                              url.includes('/v1/items/') ||
                              url.includes('/collections/') ||
                              url.includes('/items/') ||
                              (url.includes('webflow.com') && url.includes('json')) ||
                              (request.method() === 'GET' && url.includes('webflow') && resourceType === 'xhr');
          
          if (isWebflowApi) {
            try {
              console.log(`  🔍 Detected potential API call: ${url.substring(0, 100)}...`);
              const response = await route.fetch();
              const responseBody = await response.text();
              
              // Only save if it looks like JSON data
              if (responseBody && (responseBody.trim().startsWith('{') || responseBody.trim().startsWith('['))) {
                // Save API response
                const apiKey = Buffer.from(url).toString('base64').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);
                const apiFilePath = path.join(API_DATA_DIR, `${apiKey}.json`);
                ensureDir(API_DATA_DIR);
                
                const apiData = {
                  url: url,
                  method: request.method(),
                  headers: request.headers(),
                  body: request.postData() || null,
                  response: {
                    status: response.status(),
                    statusText: response.statusText(),
                    headers: Object.fromEntries(response.headers()),
                    body: responseBody
                  },
                  timestamp: new Date().toISOString()
                };
                
                fs.writeFileSync(apiFilePath, JSON.stringify(apiData, null, 2), 'utf-8');
                apiResponses.set(url, apiFilePath);
                
                console.log(`  💾 Intercepted and saved API call: ${url.substring(0, 80)}...`);
              }
              
              // Fulfill with the response
              await route.fulfill({
                status: response.status(),
                headers: response.headers(),
                body: responseBody
              });
              return;
            } catch (e) {
              console.log(`  ⚠️  Failed to intercept API call ${url}: ${e.message}`);
              // Continue normally if interception fails
              await route.continue();
              return;
            }
          }
          
          // Only intercept stylesheets, scripts, images, fonts, and documents
          if (['stylesheet', 'script', 'image', 'font', 'document'].includes(resourceType)) {
            // Skip data URLs and blob URLs
            if (!url.startsWith('data:') && !url.startsWith('blob:')) {
              pageAssets.add(url);
            }
          }
          
          // Continue with the request
          await route.continue();
        });
        
        try {
          // Webflow sometimes needs a moment after networkidle
          // Use longer timeout for slow pages
          const response = await page.goto(fullUrl, { waitUntil: "networkidle", timeout });
          
          // Close any newsletter/popup overlays that might block content
          await page.evaluate(() => {
            // Hide Mailchimp popup elements
            const mcModal = document.querySelector('.mc-modal');
            const mcModalBg = document.querySelector('.mc-modal-bg');
            const mcBanner = document.querySelector('.mc-banner');
            const popupForm = document.getElementById('PopupSignupForm_0');
            
            if (mcModal) mcModal.style.display = 'none';
            if (mcModalBg) mcModalBg.style.display = 'none';
            if (mcBanner) mcBanner.style.display = 'none';
            if (popupForm) popupForm.style.display = 'none';
            
            // Try clicking close button if exists
            const closeBtn = document.querySelector('.mc-closeModal');
            if (closeBtn) closeBtn.click();
            
            // Also try removing common popup/overlay elements
            const overlays = document.querySelectorAll('[class*="popup"], [class*="modal"], [class*="overlay"]');
            overlays.forEach(el => {
              if (el.classList.contains('mc-') || el.id.includes('Popup') || el.id.includes('popup')) {
                el.style.display = 'none';
              }
            });
          }).catch(() => {});
          
          await page.waitForTimeout(500); // Brief pause after closing popup
          
          // Wait a bit for any Cloudflare checks
          await page.waitForTimeout(5000);
          
          // Check if we got a Cloudflare challenge page
          const pageTitle = await page.title().catch(() => '');
          const pageUrl = page.url();
          const pageContent = await page.content();
          
          if (pageContent.includes('The content of the page cannot be displayed') ||
              pageContent.includes('Just a moment') ||
              pageContent.includes('Checking your browser') ||
              pageTitle.includes('Just a moment') ||
              pageTitle.includes('Checking') ||
              pageUrl.includes('challenge') ||
              pageUrl.includes('cf-browser-verification')) {
            console.log(`  ⏳ Cloudflare challenge detected for ${fullUrl}`);
            console.log(`  👀 Please complete the Cloudflare challenge in the browser window...`);
            
            // Wait for Cloudflare challenge to complete
            try {
              await page.waitForFunction(
                () => {
                  const title = document.title || '';
                  const body = document.body?.innerText || '';
                  return !title.includes('Just a moment') && 
                         !title.includes('Checking') &&
                         !body.includes('The content of the page cannot be displayed') &&
                         body.length > 500; // Make sure we have actual content
                },
                { timeout: 60000 } // Give user 60 seconds to complete challenge
              );
              await page.waitForTimeout(3000); // Extra wait after challenge
              console.log(`  ✅ Cloudflare challenge passed for ${fullUrl}`);
            } catch (e) {
              console.log(`  ⚠️  Cloudflare challenge timeout for ${fullUrl} - continuing anyway`);
              // Check one more time if content is available
              html = await page.content();
              if (html.includes('The content of the page cannot be displayed')) {
                throw new Error('Cloudflare challenge not completed - page still blocked');
              }
            }
          }

          // Wait for CMS content to load (for Webflow CMS pages)
          // Check if page has CMS attributes or is a known CMS page
          const hasCmsCollection = await page.evaluate(() => {
            return document.querySelector('[data-wf-collection]') !== null ||
                   document.querySelector('[data-wf-item]') !== null ||
                   document.querySelector('.w-dyn-list') !== null ||
                   document.querySelector('.w-dyn-item') !== null ||
                   document.documentElement.hasAttribute('data-wf-collection') ||
                   document.documentElement.hasAttribute('data-wf-item-slug') ||
                   window.location.pathname.includes('/blog/') ||
                   window.location.pathname.includes('/publications') ||
                   window.location.pathname.includes('/labs/');
          }).catch(() => false);
          
          if (hasCmsCollection) {
            console.log(`  ⏳ Detected CMS page, waiting for content to load...`);
            
            // Wait for network to be idle first
            try {
              await page.waitForLoadState('networkidle', { timeout: 15000 });
            } catch (e) {
              console.log(`  ⚠️  Network idle timeout, continuing...`);
            }
            
            // Wait a bit for JavaScript to execute
            await page.waitForTimeout(3000);
            
            try {
              // More flexible wait - check for any meaningful content
              await page.waitForFunction(
                () => {
                  const body = document.body;
                  if (!body) return false;
                  
                  // Check for various CMS indicators
                  const dynList = document.querySelector('.w-dyn-list');
                  const dynItems = document.querySelectorAll('.w-dyn-item');
                  const cmsItems = document.querySelectorAll('[data-wf-item]');
                  const bodyText = body.innerText || body.textContent || '';
                  
                  // Check if we have meaningful content (not just scripts/head content)
                  const hasContent = (dynList && dynList.children.length > 0) ||
                                    dynItems.length > 0 ||
                                    cmsItems.length > 0 ||
                                    bodyText.length > 500; // Lower threshold
                  
                  // Also check for common CMS content patterns
                  const hasArticleContent = body.querySelector('article') !== null ||
                                           body.querySelector('.blog-post') !== null ||
                                           body.querySelector('.post-content') !== null ||
                                           body.querySelector('[class*="blog"]') !== null ||
                                           body.querySelector('[class*="post"]') !== null;
                  
                  return hasContent || hasArticleContent;
                },
                { timeout: 45000 } // Longer timeout
              );
              
              // Additional wait for any animations/transitions
              await page.waitForTimeout(3000);
              
              // Scroll to trigger lazy loading
              await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight / 2);
              });
              await page.waitForTimeout(1000);
              await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
              });
              await page.waitForTimeout(1000);
              await page.evaluate(() => {
                window.scrollTo(0, 0);
              });
              await page.waitForTimeout(2000);
              
              console.log(`  ✅ CMS content loaded`);
            } catch (e) {
              console.log(`  ⚠️  CMS content wait timeout: ${e.message}`);
              console.log(`  📄 Continuing with current page state...`);
              
              // Try one more scroll and wait
              await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
              });
              await page.waitForTimeout(2000);
            }
          }
          
          // Wait for any lazy-loaded content (only if not a CMS page)
          if (!hasCmsCollection) {
            await page.waitForTimeout(2000);
            await page.evaluate(() => {
              // Scroll to trigger lazy loading
              window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(1000);
            await page.evaluate(() => {
              window.scrollTo(0, 0);
            });
            await page.waitForTimeout(1000);
          }
          
          // Get the fully rendered HTML from the DOM (not the original page source)
          // This ensures we get dynamically loaded content
          let html = await page.evaluate(() => {
            // Clone the document to avoid modifying the live page
            return document.documentElement.outerHTML;
          });
          
          // Check the body content specifically
          const bodyCheck = await page.evaluate(() => {
            const body = document.body;
            if (!body) return { hasBody: false, textLength: 0 };
            const text = body.innerText || body.textContent || '';
            const hasPageWrapper = body.querySelector('.page-wrapper') !== null;
            const hasMainContent = body.querySelector('main') !== null || 
                                  body.querySelector('[class*="content"]') !== null ||
                                  body.querySelector('article') !== null;
            return { 
              hasBody: true, 
              textLength: text.length,
              hasPageWrapper,
              hasMainContent,
              bodyHTML: body.innerHTML.substring(0, 500) // First 500 chars for debugging
            };
          });
          
          console.log(`  📄 Body check: text=${bodyCheck.textLength}chars, wrapper=${bodyCheck.hasPageWrapper}, content=${bodyCheck.hasMainContent}`);
          
          // If the body is essentially empty but the page should have content, wait and retry
          if (bodyCheck.textLength < 200 && hasCmsCollection) {
            console.log(`  ⚠️  Body content seems empty, waiting longer...`);
            await page.waitForTimeout(5000);
            
            // Try to get the HTML again
            html = await page.evaluate(() => document.documentElement.outerHTML);
            
            const retryCheck = await page.evaluate(() => {
              const text = document.body?.innerText || '';
              return text.length;
            });
            console.log(`  📄 After retry: text=${retryCheck}chars`);
          }
          
          // Double-check we got real content
          if (html.includes('The content of the page cannot be displayed') || 
              html.length < 1000) {
            // Retry once with longer wait
            console.log(`  🔄 Retrying ${fullUrl} after Cloudflare block...`);
            await page.waitForTimeout(10000);
            await page.reload({ waitUntil: "networkidle", timeout });
            await page.waitForTimeout(5000);
            html = await page.evaluate(() => document.documentElement.outerHTML);
            
            if (html.includes('The content of the page cannot be displayed') || html.length < 1000) {
              throw new Error('Cloudflare blocked the request - page content not available after retry');
            }
          }

          const rel = safeFileName(u.pathname);
          const dir = path.join(OUT, rel);
          ensureDir(dir);

          // Download all captured assets
          console.log(`📦 Processing ${pageAssets.size} assets for ${fullUrl}...`);
          const assetPromises = Array.from(pageAssets).map(url => downloadAsset(url, fullUrl));
          await Promise.all(assetPromises);
          
          // Download assets from HTML and rewrite HTML
          html = await rewriteHtml(html, fullUrl, dir);
          
          // Rewrite internal links to point to local files
          html = rewriteInternalLinks(html, fullUrl, dir);
          
          // Inject API interceptor for offline API calls
          html = injectApiInterceptor(html, fullUrl, dir);
          
          // Remove external dependencies (tracking scripts, etc.)
          html = removeExternalDependencies(html);

          fs.writeFileSync(path.join(dir, "index.html"), html, "utf-8");
          await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: true });

          console.log(`✅ Saved ${fullUrl} -> ${path.join("offline", rel, "index.html")}`);
          return { url: fullUrl, ok: true };
        } catch (e) {
          console.log(`❌ Failed ${fullUrl}: ${e.message}`);
          return { url: fullUrl, ok: false, reason: e.message };
        } finally {
          await page.close();
        }
      })
    )
  );

  await browser.close();

  return results;
}

(async () => {
  // Check if specific URLs are provided via command line arguments
  const specificUrls = process.argv.slice(2).filter(arg => arg.startsWith('http'));
  
  let urls;
  let timeout = 60000; // Default timeout

  if (specificUrls.length > 0) {
    // Scrape only the specified URLs
    urls = specificUrls;
    timeout = 120000; // Use longer timeout (2 minutes) for manual retries
    console.log(`🎯 Scraping specific URLs: ${urls.join(', ')}\n`);
  } else {
    // Scrape all URLs from sitemap
    // Use Playwright browser for sitemap fetching to handle Cloudflare protection
    let browser = await chromium.launch({ headless: false }); // Use headful mode for Cloudflare
    try {
      urls = await getUrlsFromSitemap(browser);
      if (!urls.length) {
        console.log("⚠️  Could not fetch sitemap. Trying to use existing scraped pages...");
        // Fallback: read URLs from existing offline directory
        urls = getUrlsFromExistingScrape();
        if (urls.length > 0) {
          console.log(`📁 Found ${urls.length} URLs from existing scraped pages`);
        } else {
          console.error("No URLs found. Check if sitemap.xml exists and is public.");
          await browser.close();
          process.exit(1);
        }
      } else {
        console.log(`Found ${urls.length} URLs in sitemap.xml`);
      }
    } catch (e) {
      console.log(`⚠️  Error fetching sitemap: ${e.message}`);
      console.log("📁 Trying to use existing scraped pages as fallback...");
      urls = getUrlsFromExistingScrape();
      if (urls.length > 0) {
        console.log(`📁 Found ${urls.length} URLs from existing scraped pages`);
      } else {
        await browser.close();
        throw new Error(`Could not fetch sitemap and no existing pages found. Error: ${e.message}`);
      }
    }
    await browser.close();
  }

  const results = await scrapeUrls(urls, timeout);

  const failed = results.filter((r) => !r.ok);
  
  // Update report
  let report = { total: urls.length, failed, assetsDownloaded: downloadedAssets.size };
  const reportPath = path.join(OUT, "_report.json");
  
  // If report exists, merge with existing data
  if (fs.existsSync(reportPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
      // Merge failed URLs (avoid duplicates)
      const existingFailedUrls = new Set(existing.failed?.map(f => f.url) || []);
      const newFailed = failed.filter(f => !existingFailedUrls.has(f.url));
      if (newFailed.length > 0) {
        existing.failed = [...(existing.failed || []), ...newFailed];
        existing.total = Math.max(existing.total || 0, urls.length);
        existing.assetsDownloaded = downloadedAssets.size;
        report = existing;
      } else {
        // Remove successfully scraped URLs from failed list
        const successUrls = new Set(results.filter(r => r.ok).map(r => r.url));
        if (successUrls.size > 0 && existing.failed) {
          existing.failed = existing.failed.filter(f => !successUrls.has(f.url));
          existing.assetsDownloaded = downloadedAssets.size;
          report = existing;
        }
      }
    } catch (e) {
      // If report is invalid, use new one
    }
  }
  
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n✅ Done. Offline archive in: ${OUT}`);
  console.log(`📦 Downloaded ${downloadedAssets.size} assets to: ${ASSETS_DIR}`);
  console.log(`📊 Report: ${reportPath}`);
  
  // Verify no external dependencies remain
  console.log(`\n🔍 Verifying offline compatibility...`);
  let externalCount = 0;
  const allowedDomains = [
    'cdn.prod.website-files.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'ajax.googleapis.com'
  ];
  
  function checkFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const externalMatches = content.match(/https?:\/\/(?!localhost|127\.0\.0\.1)([^\/\s"'>]+)/gi);
      if (externalMatches) {
        const unique = [...new Set(externalMatches)];
        const problematic = unique.filter(url => {
          try {
            const hostname = new URL(url).hostname;
            return !allowedDomains.some(domain => hostname.includes(domain)) &&
                   !hostname.includes('fruitpunch.ai') &&
                   !hostname.includes('app.fruitpunch.ai'); // Allow app links
          } catch {
            return true;
          }
        });
        if (problematic.length > 0) {
          externalCount += problematic.length;
          console.log(`  ⚠️  ${filePath}: ${problematic.length} external URL(s) found`);
        }
      }
    } catch (e) {
      // Ignore errors
    }
  }
  
  // Check a few sample HTML files
  const sampleFiles = [
    path.join(OUT, 'index', 'index.html'),
    path.join(OUT, 'about', 'index.html'),
    path.join(OUT, 'challenges', 'ai-for-turtles', 'index.html')
  ];
  
  for (const file of sampleFiles) {
    if (fs.existsSync(file)) {
      checkFile(file);
    }
  }
  
  if (externalCount === 0) {
    console.log(`  ✅ No external dependencies found in sample files`);
  } else {
    console.log(`  ⚠️  Found ${externalCount} external URL(s) - these may require internet connection`);
    console.log(`  💡 Re-run the scraper to ensure all assets are downloaded`);
  }
  
  if (failed.length > 0) {
    console.log(`\n⚠️  ${failed.length} page(s) failed. To retry specific URLs, run:`);
    console.log(`   node scrape.mjs ${failed.map(f => f.url).join(' ')}`);
  }
})();