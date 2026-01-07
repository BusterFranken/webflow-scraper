import fs from "fs";
import path from "path";

const OUT = path.resolve("offline");
const PORT = 8000; // Default port, can be changed
const OUTPUT_FILE = path.join(OUT, "_localhost-links.txt");

function findHtmlFiles(dir, basePath = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const htmlFiles = [];
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name);
    
    if (entry.isDirectory()) {
      // Skip hidden directories like _assets, _api_data
      if (entry.name.startsWith('_')) {
        continue;
      }
      htmlFiles.push(...findHtmlFiles(fullPath, relativePath));
    } else if (entry.name === 'index.html') {
      // Convert to URL path (use forward slashes, remove 'index.html')
      const urlPath = relativePath.replace(/\\/g, '/').replace(/\/index\.html$/, '');
      htmlFiles.push(urlPath || '/');
    }
  }
  
  return htmlFiles;
}

const htmlFiles = findHtmlFiles(OUT);
const links = htmlFiles.map(filePath => {
  if (filePath === '/') {
    return `http://localhost:${PORT}/index/index.html`;
  }
  return `http://localhost:${PORT}/${filePath}/index.html`;
});

// Sort links for easier navigation
links.sort();

// Create the output file
const content = `Localhost Links for Offline Website
==========================================
Port: ${PORT}
Total Pages: ${links.length}

To use these links:
1. Start a local server in the offline directory:
   cd offline && python3 -m http.server ${PORT}

2. Open any of the links below in your browser:

${links.join('\n')}

Note: You can change the port by editing this file or modifying PORT in generate-links.mjs
`;

fs.writeFileSync(OUTPUT_FILE, content, 'utf-8');
console.log(`✅ Generated ${links.length} localhost links in ${OUTPUT_FILE}`);
console.log(`\nFirst few links:`);
links.slice(0, 10).forEach(link => console.log(`  ${link}`));
if (links.length > 10) {
  console.log(`  ... and ${links.length - 10} more`);
}

