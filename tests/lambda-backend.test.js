const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Set dummy env secret before requiring handler for predictable testing
process.env.RAZORPAY_KEY_SECRET = 'test_secret_12345';
process.env.RAZORPAY_KEY_ID = 'rzp_test_12345';

const { handler } = require('../aws-lambda-backend/index.js');

test('Lambda Backend - OPTIONS preflight request', async () => {
    const event = {
        httpMethod: 'OPTIONS',
        path: '/api/payment/create-order'
    };
    const response = await handler(event);
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.headers['Access-Control-Allow-Origin'], '*');
    const body = JSON.parse(response.body);
    assert.strictEqual(body.message, 'CORS preflight successful');
});

test('Lambda Backend - Unknown route returns 404', async () => {
    const event = {
        httpMethod: 'GET',
        path: '/api/unknown-endpoint'
    };
    const response = await handler(event);
    assert.strictEqual(response.statusCode, 404);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.message, 'Route not found');
});

test('Lambda Backend - Create order rejects amount < 100 paise', async () => {
    const event = {
        httpMethod: 'POST',
        path: '/api/payment/create-order',
        body: JSON.stringify({ amount: 0.5 }) // 50 paise
    };
    const response = await handler(event);
    assert.strictEqual(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.success, false);
    assert.match(body.error, /Amount must be at least ₹1.00/);
});

test('Lambda Backend - Verify payment missing required parameters returns 400', async () => {
    const event = {
        httpMethod: 'POST',
        path: '/api/payment/verify',
        body: JSON.stringify({
            razorpay_order_id: 'order_123'
            // missing payment_id and signature
        })
    };
    const response = await handler(event);
    assert.strictEqual(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.message, 'Missing required fields for verification');
});

test('Lambda Backend - Verify payment with invalid signature returns 400', async () => {
    const event = {
        httpMethod: 'POST',
        path: '/api/payment/verify',
        body: JSON.stringify({
            razorpay_order_id: 'order_123',
            razorpay_payment_id: 'pay_456',
            razorpay_signature: 'invalid_fraudulent_signature'
        })
    };
    const response = await handler(event);
    assert.strictEqual(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.message, 'Invalid signature sent!');
});

test('Lambda Backend - Verify payment with valid HMAC signature succeeds with 200', async () => {
    const orderId = 'order_valid_789';
    const paymentId = 'pay_valid_101';
    const payload = `${orderId}|${paymentId}`;
    const validSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(payload)
        .digest('hex');

    const event = {
        httpMethod: 'POST',
        path: '/api/payment/verify',
        body: JSON.stringify({
            razorpay_order_id: orderId,
            razorpay_payment_id: paymentId,
            razorpay_signature: validSignature
        })
    };
    const response = await handler(event);
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.message, 'Payment verified successfully');
});
