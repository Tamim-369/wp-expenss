#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const authPath = path.join(__dirname, '..', '.wwebjs_auth');

function deleteDirectory(dirPath) {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log('✅ WhatsApp session cleared successfully!');
        console.log('📱 You will need to scan the QR code again on next startup.');
    } else {
        console.log('ℹ️ No session found to clear.');
    }
}

console.log('🔄 Clearing WhatsApp session...');
deleteDirectory(authPath);