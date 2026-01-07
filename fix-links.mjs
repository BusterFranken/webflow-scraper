import fs from "fs";
import path from "path";

const OUT = path.resolve("offline");

function safeFileName(urlPath) {
  let p = urlPath.split("?")[0].split("#")[0];
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (p === "") return "index";
  return p.replace(/^\/+/, "");
}

function normalizeOrigin(origin) {
  const url = new URL(origin);
  url.hostname = url.hostname.replace(/^www\./, '');
  return url.origin;
}

function rewriteInternalLinks(html, filePath) {
  const BASE = "https://www.fruitpunch.ai";
  const baseUrlObj = new URL(BASE);
  const pageDir = path.dirname(filePath);
  
  // Rewrite internal links
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
          // External link - keep as is
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
      // For relative paths, we'd need the page URL which we don't have
      // So we'll skip them for now
      return match;
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

function processDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_')) continue; // Skip _assets, etc.
      processDirectory(fullPath);
    } else if (entry.name === 'index.html') {
      try {
        const html = fs.readFileSync(fullPath, 'utf-8');
        const fixed = rewriteInternalLinks(html, fullPath);
        if (fixed !== html) {
          fs.writeFileSync(fullPath, fixed, 'utf-8');
          console.log(`✅ Fixed links in ${path.relative(OUT, fullPath)}`);
        }
      } catch (e) {
        console.log(`⚠️  Error processing ${fullPath}: ${e.message}`);
      }
    }
  }
}

console.log('🔧 Fixing internal links in all HTML files...\n');
processDirectory(OUT);
console.log('\n✅ Done fixing links!');

