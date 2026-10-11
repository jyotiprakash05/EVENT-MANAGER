const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

test('Static Assets - Core HTML entry points exist', () => {
    const entryPoints = [
        'HOME.html',
        'SIGNIN.html',
        'SIGNUP.html',
        'Admin_Dashboard/admin.html',
        'Attendee_Dashboard/Event_List.html',
        'Organizer_Dashboard/Event_list_organizer.html'
    ];

    entryPoints.forEach(file => {
        const fullPath = path.join(rootDir, file);
        assert.ok(fs.existsSync(fullPath), `Expected core HTML file to exist: ${file}`);
    });
});

test('Static Assets - Script tags point to existing local files', () => {
    const filesToCheck = [
        'HOME.html',
        'SIGNIN.html',
        'SIGNUP.html'
    ];

    filesToCheck.forEach(htmlFile => {
        const filePath = path.join(rootDir, htmlFile);
        if (!fs.existsSync(filePath)) return;

        const content = fs.readFileSync(filePath, 'utf8');
        // Match local scripts like src="auth.js" or src="./auth.js" (ignore http/https/cdn)
        const scriptMatches = [...content.matchAll(/<script[^>]+src=["'](?!https?:\/\/|\/\/)([^"']+)["']/gi)];

        scriptMatches.forEach(match => {
            const scriptSrc = match[1];
            const resolvedPath = path.resolve(path.dirname(filePath), scriptSrc);
            assert.ok(fs.existsSync(resolvedPath), `Broken script reference in ${htmlFile}: ${scriptSrc}`);
        });
    });
});
