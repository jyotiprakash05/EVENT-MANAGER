const crypto = require('crypto');
const { handler } = require('../aws-lambda-backend/index.js');

async function testWebhookHandler() {
    console.log('--- 1. Testing Webhook with Invalid Signature ---');
    const badSecretEvent = {
        path: '/api/payment/webhook',
        httpMethod: 'POST',
        headers: {
            'x-razorpay-signature': 'bad_hex_signature'
        },
        body: JSON.stringify({
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_test_bad' } } }
        })
    };
    const badRes = await handler(badSecretEvent);
    console.log('Bad signature response:', badRes.statusCode, badRes.body);
    if (badRes.statusCode !== 400) throw new Error('Expected 400 on bad signature');

    console.log('\n--- 2. Testing Webhook with Valid Signature (payment.captured) ---');
    const secret = process.env.RAZORPAY_KEY_SECRET || 'BZJrebtT9kXDv3Tckg7Yo6Wg';
    const payloadObj = {
        event: 'payment.captured',
        payload: {
            payment: {
                entity: {
                    id: 'pay_mock_' + Date.now(),
                    order_id: 'order_mock_test',
                    amount: 49900,
                    currency: 'INR',
                    status: 'captured',
                    method: 'upi',
                    email: 'test@eventpro.test',
                    contact: '+919876543210',
                    notes: {
                        ticketId: 'TKT-TEST-WEBHOOK'
                    },
                    created_at: Math.floor(Date.now() / 1000)
                }
            }
        }
    };
    const rawBody = JSON.stringify(payloadObj);
    const validSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const validEvent = {
        path: '/api/payment/webhook',
        httpMethod: 'POST',
        headers: {
            'x-razorpay-signature': validSignature
        },
        body: rawBody
    };

    const validRes = await handler(validEvent);
    console.log('Valid signature response:', validRes.statusCode, validRes.body);
    if (validRes.statusCode !== 200) throw new Error('Expected 200 on valid signature');

    console.log('\nAll local webhook tests passed successfully!');
}

testWebhookHandler().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
