const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy_key_id',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_test_dummy_key_secret',
});

// Endpoint to create an order
app.post('/api/payment/create-order', async (req, res) => {
    try {
        const { amount, currency = 'INR', receipt } = req.body;

        const amountInPaise = amount * 100;
        if (amountInPaise < 100) {
            return res.status(400).json({ success: false, error: 'Amount must be at least ₹1.00 (100 paise)' });
        }

        const options = {
            amount: amountInPaise,
            currency,
            receipt: receipt || `receipt_${Date.now()}`
        };

        const order = await razorpay.orders.create(options);
        res.json({ success: true, order });
    } catch (error) {
        console.error("Error creating Razorpay order:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint to verify payment signature
app.post('/api/payment/verify', (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: "Missing required fields for verification" });
        }

        const sign = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || 'rzp_test_dummy_key_secret')
            .update(sign.toString())
            .digest("hex");

        if (razorpay_signature === expectedSign) {
            // Signature is valid
            res.json({ success: true, message: "Payment verified successfully" });
        } else {
            res.status(400).json({ success: false, message: "Invalid signature sent!" });
        }
    } catch (error) {
        console.error("Error verifying payment:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
