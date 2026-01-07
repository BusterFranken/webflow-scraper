import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import pLimit from "p-limit";

const BASE = "https://www.fruitpunch.ai";
const OUT = path.resolve("offline");
const ASSETS_DIR = path.join(OUT, "_assets");
const API_DATA_DIR = path.join(OUT, "_api_data"); // Store intercepted API responses
const CONCURRENCY = 1; // Keep at 1 for headful mode to handle Cloudflare

// Import necessary functions from scrape.mjs by duplicating them
// (We could refactor to share code, but keeping it simple for now)

function safeFileName(urlPath) {
  let p = urlPath.split("?")[0].split("#")[0];
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (p === "") return "index";
  return p.replace(/^\/+/, "");
}

// Reverse of safeFileName: convert file path back to URL path
function filePathToUrlPath(filePath) {
  // Remove OUT directory and /index.html
  const relativePath = path.relative(OUT, filePath);
  const dirPath = path.dirname(relativePath);
  
  // Handle root/index page
  if (dirPath === "." || dirPath === "index" || relativePath === "index/index.html") {
    return "/";
  }
  
  // Convert back to URL path
  // "about/index.html" -> "/about/"
  // "blog/post/index.html" -> "/blog/post/"
  return "/" + dirPath + "/";
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeOrigin(origin) {
  const url = new URL(origin);
  url.hostname = url.hostname.replace(/^www\./, '');
  return url.origin;
}

// Find all blank HTML files
function findBlankPages() {
  const blankPages = [];
  
  function scanDirectory(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (entry.name.startsWith('_')) continue; // Skip _assets, etc.
        scanDirectory(fullPath);
      } else if (entry.name === 'index.html') {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lineCount = content.split('\n').length;
          
          // Consider a page blank if:
          // 1. Less than 50 lines, OR
          // 2. No body content (just head and closing tags), OR
          // 3. Contains Cloudflare error message
          const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          const hasBodyContent = bodyMatch && bodyMatch[1] && bodyMatch[1].trim().length > 200;
          const hasCloudflareError = content.includes('The content of the page cannot be displayed') ||
                                    content.includes('Just a moment') ||
                                    content.includes('Checking your browser');
          
          if (lineCount < 50 || !hasBodyContent || hasCloudflareError) {
            const urlPath = filePathToUrlPath(fullPath);
            const fullUrl = new URL(urlPath, BASE).href;
            blankPages.push({ filePath: fullPath, url: fullUrl, urlPath });
            console.log(`📄 Found blank page: ${urlPath} (${lineCount} lines)`);
          }
        } catch (e) {
          console.log(`⚠️  Error reading ${fullPath}: ${e.message}`);
        }
      }
    }
  }
  
  scanDirectory(OUT);
  return blankPages;
}

// Copy the necessary scraping functions from scrape.mjs
const downloadedAssets = new Map();
const apiResponses = new Map();

function getAssetPath(pathname) {
  try {
    const urlObj = new URL(pathname, 'http://example.com');
    const ext = path.extname(urlObj.pathname) || '.html';
    const basename = path.basename(urlObj.pathname, ext) || 'index';
    const dir = path.dirname(urlObj.pathname).replace(/^\//, '').replace(/\//g, '_');
    const filename = dir ? `${dir}_${basename}${ext}` : `${basename}${ext}`;
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  } catch {
    return 'asset_' + pathname.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  }
}

async function downloadAsset(url, pageUrl) {
  try {
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return null;
    }

    let absoluteUrl;
    try {
      absoluteUrl = new URL(url, pageUrl).href;
    } catch {
      return null;
    }

    if (downloadedAssets.has(absoluteUrl)) {
      return downloadedAssets.get(absoluteUrl);
    }

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
  const importMatches = cssContent.matchAll(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?/gi);
  for (const match of importMatches) {
    assets.add(match[1]);
  }
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
  const assetUrls = new Set();

  html.replace(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi, (match, href) => {
    if (!href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
      assetUrls.add(href);
    }
  });

  html.replace(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      assetUrls.add(src);
    }
  });

  html.replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      assetUrls.add(src);
    }
  });

  html.replace(/srcset=["']([^"']+)["']/gi, (match, srcset) => {
    srcset.split(',').forEach(part => {
      const url = part.trim().split(/\s+/)[0];
      if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
        assetUrls.add(url);
      }
    });
  });

  const assetMap = new Map();
  const cssFiles = new Map();
  
  const downloadPromises = Array.from(assetUrls).map(async (url) => {
    const localPath = await downloadAsset(url, pageUrl);
    if (localPath) {
      assetMap.set(url, localPath);
      
      if (url.endsWith('.css') || url.includes('.css?') || localPath.endsWith('.css')) {
        try {
          const cssPath = path.join(OUT, localPath);
          if (fs.existsSync(cssPath)) {
            const cssContent = fs.readFileSync(cssPath, 'utf-8');
            cssFiles.set(localPath, { content: cssContent, url });
            
            const cssAssets = await extractAssetsFromCss(cssContent, url);
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
  
  for (const [cssLocalPath, { content: cssContent, url: cssUrl }] of cssFiles) {
    let updatedCss = cssContent;
    
    updatedCss = updatedCss.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, assetUrl) => {
      const trimmedUrl = assetUrl.trim();
      if (trimmedUrl.startsWith('data:') || trimmedUrl.startsWith('#')) {
        return match;
      }
      
      const localAssetPath = assetMap.get(trimmedUrl) || assetMap.get(new URL(trimmedUrl, cssUrl).href);
      if (localAssetPath) {
        const cssDir = path.dirname(path.join(OUT, cssLocalPath));
        const relativePath = path.relative(cssDir, path.join(OUT, localAssetPath)).replace(/\\/g, '/');
        return `url("${relativePath}")`;
      }
      return match;
    });
    
    if (updatedCss !== cssContent) {
      fs.writeFileSync(path.join(OUT, cssLocalPath), updatedCss, 'utf-8');
    }
  }

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
  const baseUrlObj = new URL(BASE);
  
  html = html.replace(/href=["']([^"']+)["']/gi, (match, href) => {
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || 
        href.startsWith('javascript:') || href.startsWith('data:') || href === '#' || href === '') {
      return match;
    }
    
    let targetPath = null;
    
    if (href.startsWith('http://') || href.startsWith('https://')) {
      try {
        const hrefUrl = new URL(href);
        if (normalizeOrigin(hrefUrl.origin) === normalizeOrigin(baseUrlObj.origin)) {
          targetPath = hrefUrl.pathname;
        } else {
          return match;
        }
      } catch {
        return match;
      }
    } else if (href.startsWith('/')) {
      targetPath = href;
    } else if (!href.startsWith('//')) {
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
    
    if (targetPath) {
      const localPath = safeFileName(targetPath);
      const targetFile = path.join(OUT, localPath, 'index.html');
      
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
          return new Response(data.response.body, {
            status: data.response.status,
            statusText: data.response.statusText,
            headers: data.response.headers
          });
        })
        .catch(() => {
          return originalFetch.apply(this, args);
        });
    }
    
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
          Object.defineProperty(this, 'status', { value: data.response.status, writable: false });
          Object.defineProperty(this, 'statusText', { value: data.response.statusText, writable: false });
          Object.defineProperty(this, 'responseText', { value: data.response.body, writable: false });
          Object.defineProperty(this, 'readyState', { value: 4, writable: false });
          
          if (this.onload) this.onload();
          if (this.onreadystatechange) this.onreadystatechange();
        })
        .catch(() => {
          return originalXHRSend.apply(this, args);
        });
      
      return;
    }
    
    return originalXHRSend.apply(this, args);
  };
})();
</script>`;
  
  if (html.includes('</head>')) {
    html = html.replace('</head>', apiInterceptorScript + '</head>');
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', apiInterceptorScript + '</body>');
  }
  
  return html;
}

function removeExternalDependencies(html) {
  // Safely remove tracking scripts by matching complete script tags only
  // Use a more specific approach: match script tags with specific src attributes
  html = html.replace(/<script[^>]*src=["'][^"']*google-analytics[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Tracking script removed for offline -->');
  html = html.replace(/<script[^>]*src=["'][^"']*googletagmanager[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Tracking script removed for offline -->');
  html = html.replace(/<script[^>]*src=["'][^"']*clarity\.ms[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Tracking script removed for offline -->');
  html = html.replace(/<script[^>]*src=["'][^"']*mailchimp[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Tracking script removed for offline -->');
  html = html.replace(/<script[^>]*src=["'][^"']*snap\.licdn[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '<!-- Tracking script removed for offline -->');
  
  // For inline scripts, be very careful - only match small inline scripts
  // Match inline scripts that are ONLY tracking code (under 2000 chars to be safe)
  html = html.replace(/<script[^>]*>([^<]{0,2000}?(gtag|google-analytics|clarity|_linkedin_partner_id)[^<]{0,2000}?)<\/script>/gi, '<!-- Tracking script removed for offline -->');
  
  // Remove noscript tracking pixels (these are usually small)
  html = html.replace(/<noscript[^>]*>[\s\S]{0,500}?linkedin[\s\S]{0,500}?<\/noscript>/gi, '<!-- LinkedIn tracking pixel removed -->');
  
  // Remove iframe tracking (iframes should be self-contained)
  html = html.replace(/<iframe[^>]*src=["'][^"']*googletagmanager[^"']*["'][^>]*>[\s\S]*?<\/iframe>/gi, '<!-- Tracking iframe removed for offline -->');
  
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
  
  return html;
}

async function rescrapeUrl(fullUrl, browser, timeout = 120000) {
  const u = new URL(fullUrl);
  const pageAssets = new Set();
  
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  
  const page = await context.newPage();
  
  try {
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
    
    // Intercept network requests to capture assets and API responses
    await page.route('**/*', async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const url = request.url();
      
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
      
      if (['stylesheet', 'script', 'image', 'font', 'document'].includes(resourceType)) {
        pageAssets.add(url);
      }
      
      route.continue();
    });
    
    console.log(`  🌐 Navigating to ${fullUrl}...`);
    await page.goto(fullUrl, { waitUntil: "networkidle", timeout });
    
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
    
    // Wait for Cloudflare challenge if present
    await page.waitForTimeout(5000);
    
    const finalUrl = page.url();
    const pageTitle = await page.title().catch(() => '');
    const pageContent = await page.content();
    
    // Check for Cloudflare challenge
    if (finalUrl.includes('challenge') || finalUrl.includes('cf-browser-verification') || 
        pageTitle.includes('Just a moment') || pageTitle.includes('Checking your browser') ||
        pageContent.includes('The content of the page cannot be displayed') ||
        pageContent.includes('Just a moment') ||
        pageContent.includes('Checking your browser')) {
      console.log(`  ⏳ Cloudflare challenge detected, waiting up to 60 seconds...`);
      
      try {
        await page.waitForFunction(
          () => {
            const title = document.title || '';
            const bodyText = document.body?.innerText || '';
            return !title.includes('Just a moment') && 
                   !title.includes('Checking') &&
                   !bodyText.includes('The content of the page cannot be displayed');
          },
          { timeout: 60000 }
        );
        await page.waitForTimeout(5000);
        console.log(`  ✅ Cloudflare challenge passed`);
      } catch (e) {
        console.log(`  ⚠️  Cloudflare challenge may still be active, continuing anyway...`);
      }
    }
    
    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    
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
    } else {
      // Wait for any lazy-loaded content (only if not a CMS page)
      await page.waitForTimeout(2000);
      await page.evaluate(() => {
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
        hasMainContent
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
    if (html.includes('The content of the page cannot be displayed') || html.length < 1000) {
      console.log(`  🔄 Retrying ${fullUrl} after potential Cloudflare block...`);
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
    console.log(`  📦 Processing ${pageAssets.size} assets...`);
    const assetPromises = Array.from(pageAssets).map(url => downloadAsset(url, fullUrl));
    await Promise.all(assetPromises);
    
    // Rewrite HTML and links
    html = await rewriteHtml(html, fullUrl, dir);
    html = rewriteInternalLinks(html, fullUrl, dir);
    html = injectApiInterceptor(html, fullUrl, dir);
    html = removeExternalDependencies(html);
    
    fs.writeFileSync(path.join(dir, "index.html"), html, "utf-8");
    await page.screenshot({ path: path.join(dir, "screenshot.png"), fullPage: true });
    
    console.log(`  ✅ Re-scraped ${fullUrl}`);
    return { url: fullUrl, ok: true };
  } catch (e) {
    console.log(`  ❌ Failed to re-scrape ${fullUrl}: ${e.message}`);
    return { url: fullUrl, ok: false, reason: e.message };
  } finally {
    await page.close();
    await context.close();
  }
}

async function main() {
  ensureDir(OUT);
  ensureDir(ASSETS_DIR);
  ensureDir(API_DATA_DIR);
  
  console.log('🔍 Finding blank pages...\n');
  const blankPages = findBlankPages();
  
  if (blankPages.length === 0) {
    console.log('✅ No blank pages found! All pages have content.');
    return;
  }
  
  console.log(`\n📋 Found ${blankPages.length} blank page(s) to re-scrape:\n`);
  blankPages.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.url}`);
  });
  
  console.log(`\n🚀 Starting re-scraping in headful mode (browser will be visible)...\n`);
  console.log('💡 Tip: If Cloudflare challenges appear, you may need to complete them manually.\n');
  
  const browser = await chromium.launch({ 
    headless: false,
    slowMo: 100 // Slow down operations slightly to appear more human-like
  });
  const limit = pLimit(CONCURRENCY);
  
  const results = await Promise.all(
    blankPages.map((page) =>
      limit(async () => {
        return await rescrapeUrl(page.url, browser);
      })
    )
  );
  
  await browser.close();
  
  const successful = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  
  console.log(`\n📊 Re-scraping complete:`);
  console.log(`   ✅ Successfully re-scraped: ${successful}/${blankPages.length}`);
  if (failed.length > 0) {
    console.log(`   ❌ Failed:`);
    failed.forEach(f => console.log(`      - ${f.url}: ${f.reason}`));
  }
  
  // Fix links again after re-scraping
  console.log(`\n🔧 Fixing links in re-scraped pages...`);
  const { execSync } = await import('child_process');
  execSync('node fix-links.mjs', { stdio: 'inherit' });
  
  console.log(`\n✅ Done!`);
}

main().catch(console.error);

