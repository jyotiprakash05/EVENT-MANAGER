const crypto = require('crypto');
const https = require('https');

async function sendRequest(headers, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 's3eg7kdaja.execute-api.ap-south-1.amazonaws.com',
            path: '/prod/api/payment/webhook',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...headers
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function verifyLiveWebhook() {
    console.log('--- 1. Testing Live Webhook: Bad Signature ---');
    const badBody = JSON.stringify({ event: 'payment.captured' });
    const badRes = await sendRequest({ 'x-razorpay-signature': 'bad_sig' }, badBody);
    console.log('Live bad signature response:', badRes.statusCode, badRes.body);

    console.log('\n--- 2. Testing Live Webhook: Valid Signature ---');
    const secret = process.env.RAZORPAY_KEY_SECRET || 'BZJrebtT9kXDv3Tckg7Yo6Wg';
    const mockPaymentId = 'pay_live_test_' + Date.now();
    const payload = {
        event: 'payment.captured',
        payload: {
            payment: {
                entity: {
                    id: mockPaymentId,
                    order_id: 'order_live_webhook_test',
                    amount: 75000,
                    currency: 'INR',
                    status: 'captured',
                    method: 'card',
                    email: 'live-test@eventpro.online',
                    contact: '+919123456789',
                    notes: {
                        ticketId: 'TKT-LIVE-TEST-123'
                    },
                    created_at: Math.floor(Date.now() / 1000)
                }
            }
        }
    };

    const goodBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', secret).update(goodBody).digest('hex');
    const goodRes = await sendRequest({ 'x-razorpay-signature': signature }, goodBody);
    console.log('Live valid signature response:', goodRes.statusCode, goodRes.body);

    if (goodRes.statusCode === 200) {
        console.log(`\nVerified live webhook! Payment ${mockPaymentId} accepted.`);
    } else {
        throw new Error('Unexpected status: ' + goodRes.statusCode);
    }
}

verifyLiveWebhook().catch(err => {
    console.error('Live webhook test failed:', err);
    process.exit(1);
});
