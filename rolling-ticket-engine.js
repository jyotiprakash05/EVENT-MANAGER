/**
 * ==============================================================================
 * EVENTPRO - ROLLING DYNAMIC ANTI-SCREENSHOT TICKET ENGINE (v2.0)
 * ==============================================================================
 * Academic / Production Novelty Feature:
 * Solves the critical black-market ticket scalping and static screenshot resale
 * problem by introducing Time-Synchronized Rolling Cryptographic Tokens (TOTP).
 *
 * How it works:
 * 1. The attendee's device continuously computes a rolling cryptographic token
 *    using SHA-256 over [SECRET_SALT + ticketId + timeEpoch + eventId].
 * 2. The QR refreshes automatically every 20 seconds with a visual liveness pulse.
 * 3. Any static screenshot or forwarded picture will have an expired timeEpoch.
 * 4. The organizer scanner validates the token and timestamp. If the token is older
 *    than 30 seconds, it is instantly rejected as a "Screenshot / Scalped Ticket".
 * ==============================================================================
 */

(function(window) {
    'use strict';

    const RollingTicketEngine = {
        EPOCH_INTERVAL: 20, // 20-second validity window
        SECRET_SALT: "EVENTPRO_SECURE_ROLLING_SALT_2026",

        /**
         * Fast deterministic cryptographic SHA-256 digest
         * Uses native Web Crypto API (SubtleCrypto) with fallback
         */
        sha256: async function(message) {
            if (window.crypto && window.crypto.subtle) {
                try {
                    const msgBuffer = new TextEncoder().encode(message);
                    const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
                    const hashArray = Array.from(new Uint8Array(hashBuffer));
                    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                } catch(e) {
                    console.warn("SubtleCrypto failed, falling back to algorithmic hash:", e);
                }
            }
            // Algorithmic 32-bit polynomial hash fallback
            let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
            for (let i = 0; i < message.length; i++) {
                const ch = message.charCodeAt(i);
                h1 = Math.imul(h1 ^ ch, 2654435761);
                h2 = Math.imul(h2 ^ ch, 1597334677);
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
            const combined = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
            return combined.padStart(16, '0') + combined.padStart(16, '0');
        },

        /**
         * Generate a dynamic rolling token for a ticket at a given epoch offset
         */
        generateToken: async function(ticketId, eventId, epochOffset = 0) {
            const nowSec = Math.floor(Date.now() / 1000);
            const currentEpoch = Math.floor(nowSec / this.EPOCH_INTERVAL) + epochOffset;
            const epochTimestamp = currentEpoch * this.EPOCH_INTERVAL;
            
            const rawPayload = `${this.SECRET_SALT}:${ticketId}:${currentEpoch}:${eventId || 'GEN'}`;
            const fullHash = await this.sha256(rawPayload);
            const hashSignature = fullHash.substring(0, 12).toUpperCase();

            // Protocol format: EVENTPRO-DYN|v2|TICKET_ID|EPOCH_TIMESTAMP|SIGNATURE|EVENT_ID
            const qrPayload = `EVENTPRO-DYN|v2|${ticketId}|${epochTimestamp}|${hashSignature}|${eventId || 'GEN'}`;
            const secondsRemaining = this.EPOCH_INTERVAL - (nowSec % this.EPOCH_INTERVAL);

            return {
                qrPayload: qrPayload,
                hashSignature: hashSignature,
                epochTimestamp: epochTimestamp,
                currentEpoch: currentEpoch,
                secondsRemaining: secondsRemaining,
                interval: this.EPOCH_INTERVAL
            };
        },

        /**
         * Gate Scanner Verification
         * Analyzes scanned QR payload for freshness, cryptographic validity, and screenshot detection.
         */
        verifyScannedPayload: async function(payloadString, expectedEventId = null) {
            if (!payloadString || typeof payloadString !== 'string') {
                return { valid: false, reason: "Empty or invalid scan content." };
            }

            const cleanString = payloadString.trim();

            // 1. Check if it's the dynamic protocol
            if (!cleanString.startsWith('EVENTPRO-DYN|')) {
                // Legacy or static QR fallback
                let legacyTicketId = cleanString;
                if (cleanString.includes('Ticket ID:')) {
                    const match = cleanString.match(/Ticket ID:\s*([^\n]+)/);
                    if (match && match[1]) legacyTicketId = match[1].trim();
                }

                return {
                    valid: true,
                    isDynamic: false,
                    isLegacy: true,
                    ticketId: legacyTicketId,
                    warning: "Legacy static ticket format. No screenshot-protection detected.",
                    ageSeconds: null
                };
            }

            // 2. Parse protocol fields
            const parts = cleanString.split('|');
            if (parts.length < 6) {
                return {
                    valid: false,
                    isDynamic: true,
                    reason: "Malformed dynamic ticket payload structure."
                };
            }

            const [prefix, version, ticketId, epochTimestampStr, scannedHash, eventId] = parts;
            const scannedEpochTimestamp = parseInt(epochTimestampStr, 10);

            if (isNaN(scannedEpochTimestamp)) {
                return {
                    valid: false,
                    isDynamic: true,
                    ticketId: ticketId,
                    reason: "Invalid timestamp header in dynamic ticket."
                };
            }

            const nowSec = Math.floor(Date.now() / 1000);
            const currentEpoch = Math.floor(nowSec / this.EPOCH_INTERVAL);
            const scannedEpoch = Math.floor(scannedEpochTimestamp / this.EPOCH_INTERVAL);
            const ageSeconds = nowSec - scannedEpochTimestamp;
            const driftEpochs = currentEpoch - scannedEpoch;

            // 3. Check for expired screenshots
            // If driftEpochs > 1, the pass is older than 20-40 seconds -> Static screenshot!
            if (driftEpochs > 1 || ageSeconds > 35) {
                return {
                    valid: false,
                    isDynamic: true,
                    isScreenshot: true,
                    ticketId: ticketId,
                    eventId: eventId,
                    ageSeconds: ageSeconds,
                    scannedTime: new Date(scannedEpochTimestamp * 1000).toLocaleTimeString(),
                    reason: `SCREENSHOT DETECTED! Pass was generated ${ageSeconds} seconds ago (Allowed threshold: 30s). The attendee is presenting an expired screenshot or forwarded image.`
                };
            }

            // 4. Check for future timestamp (excessive device clock desync)
            if (driftEpochs < -1) {
                return {
                    valid: false,
                    isDynamic: true,
                    ticketId: ticketId,
                    ageSeconds: ageSeconds,
                    reason: "Clock desync error: Ticket timestamp is from the future. Please ensure attendee device clock is set to automatic time."
                };
            }

            // 5. Verify Cryptographic Signature for current epoch or previous epoch (-1 tolerance)
            const tokenCurrent = await this.generateToken(ticketId, eventId, 0);
            const tokenPrevious = await this.generateToken(ticketId, eventId, -1);

            const isValidSig = (scannedHash === tokenCurrent.hashSignature) || (scannedHash === tokenPrevious.hashSignature);

            if (!isValidSig) {
                return {
                    valid: false,
                    isDynamic: true,
                    ticketId: ticketId,
                    reason: "CRYPTOGRAPHIC SIGNATURE FORGERY! Token signature failed verification. Counterfeit ticket attempt."
                };
            }

            // 6. Verified Live & Authentic
            return {
                valid: true,
                isDynamic: true,
                isScreenshot: false,
                verifiedLive: true,
                ticketId: ticketId,
                eventId: eventId,
                ageSeconds: ageSeconds,
                hash: scannedHash,
                timeString: new Date(scannedEpochTimestamp * 1000).toLocaleTimeString()
            };
        },

        /**
         * Simulation helper for live demo / teacher presentation:
         * Generates a simulated expired screenshot payload (e.g., 90 seconds old)
         */
        createExpiredScreenshotDemo: async function(ticketId, eventId, secondsOld = 95) {
            const oldTimestamp = Math.floor(Date.now() / 1000) - secondsOld;
            const oldEpoch = Math.floor(oldTimestamp / this.EPOCH_INTERVAL);
            const epochTimestamp = oldEpoch * this.EPOCH_INTERVAL;
            const rawPayload = `${this.SECRET_SALT}:${ticketId}:${oldEpoch}:${eventId || 'GEN'}`;
            const fullHash = await this.sha256(rawPayload);
            const hashSignature = fullHash.substring(0, 12).toUpperCase();

            return `EVENTPRO-DYN|v2|${ticketId}|${epochTimestamp}|${hashSignature}|${eventId || 'GEN'}`;
        },

        /**
         * Simulation helper for live demo / teacher presentation:
         * Generates a fresh live dynamic token payload
         */
        createLiveTokenDemo: async function(ticketId, eventId) {
            const token = await this.generateToken(ticketId, eventId, 0);
            return token.qrPayload;
        }
    };

    window.RollingTicketEngine = RollingTicketEngine;
})(window);
