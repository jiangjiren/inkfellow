const fs = require('fs');
const path = require('path');

const targets = ['vault', 'src-tauri', '.git'];
const bases = ['.next/standalone/', '../.next/standalone/'];

targets.forEach(dir => {
  bases.forEach(base => {
    const p = path.resolve(base, dir);
    if (fs.existsSync(p)) {
      try {
        console.log(`Cleaning up standalone directory: ${p}`);
        fs.rmSync(p, { recursive: true, force: true });
      } catch (err) {
        console.error(`Failed to clean ${p}:`, err.message);
      }
    }
  });
});
