const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist_cloudflare');

function copyDirRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (let entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.github' || entry.name === '.vscode' || entry.name === 'dist_cloudflare' || entry.name === 'aws-lambda-backend' || entry.name === 'scratch' || entry.name.endsWith('.zip')) {
            continue;
        }
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

copyDirRecursive(root, dist);
console.log('Successfully synced all frontend files to dist_cloudflare');

