const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy_key_id',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_test_dummy_key_secret',
});

exports.handler = async (event) => {
    // Enable CORS for API Gateway
    const headers = {
        "Access-Control-Allow-Origin": "*", // Or your specific domain
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
    };

    // Support both REST API (v1) and HTTP API (v2) payload formats
    const path = event.path || event.rawPath;
    const httpMethod = event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method);

    // Handle preflight OPTIONS request
    if (httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ message: 'CORS preflight successful' })
        };
    }

    try {
        let body = {};
        if (event.body) {
            const bodyStr = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
            body = JSON.parse(bodyStr);
        }

        // 1. Endpoint to create an order
        if (path && path.endsWith('/api/payment/create-order') && httpMethod === 'POST') {
            const { amount, currency = 'INR', receipt } = body;
            
            const amountInPaise = amount * 100;
            if (amountInPaise < 100) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ success: false, error: 'Amount must be at least ₹1.00 (100 paise)' })
                };
            }
            
            const options = {
                amount: amountInPaise,
                currency,
                receipt: receipt || `receipt_${Date.now()}`
            };
            
            const order = await razorpay.orders.create(options);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, order })
            };
        }

        // 2. Endpoint to verify payment signature
        if (path && path.endsWith('/api/payment/verify') && httpMethod === 'POST') {
            const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
            
            if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ success: false, message: "Missing required fields for verification" })
                };
            }
            
            const sign = razorpay_order_id + "|" + razorpay_payment_id;
            const expectedSign = crypto
                .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || 'rzp_test_dummy_key_secret')
                .update(sign.toString())
                .digest("hex");
            
            if (razorpay_signature === expectedSign) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: true, message: "Payment verified successfully" })
                };
            } else {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ success: false, message: "Invalid signature sent!" })
                };
            }
        }

        // 3. Fallback for undefined routes
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ success: false, message: "Route not found" })
        };

    } catch (error) {
        console.error("Lambda execution error:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};
