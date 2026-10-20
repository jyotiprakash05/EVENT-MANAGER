const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy_key_id',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_test_dummy_key_secret',
});

// Initialize AWS SES (Supports both AWS SDK v3 in Node 18/20 and v2 in Node 16)
let sesClient = null;
let useV3 = false;
try {
    const { SESClient } = require('@aws-sdk/client-ses');
    sesClient = new SESClient({ region: process.env.AWS_REGION || 'ap-south-1' });
    useV3 = true;
} catch (e) {
    try {
        const AWS = require('aws-sdk');
        sesClient = new AWS.SES({ region: process.env.AWS_REGION || 'ap-south-1' });
        useV3 = false;
    } catch (err) {
        console.warn('SES SDK initialization notice:', err.message);
    }
}

async function sendSESEmail({ fromEmail, toEmail, replyTo, subject, htmlBody, textBody }) {
    const from = fromEmail || process.env.SES_SENDER_EMAIL || '"EventPro" <no-reply@eventpro24.online>';
    const destinations = Array.isArray(toEmail) ? toEmail : [toEmail];
    const replyToList = replyTo ? (Array.isArray(replyTo) ? replyTo : [replyTo]) : ['support@eventpro24.online'];

    if (useV3) {
        const { SendEmailCommand } = require('@aws-sdk/client-ses');
        const params = {
            Source: from,
            Destination: { ToAddresses: destinations },
            ReplyToAddresses: replyToList,
            Message: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: {
                    Html: htmlBody ? { Data: htmlBody, Charset: 'UTF-8' } : undefined,
                    Text: textBody ? { Data: textBody, Charset: 'UTF-8' } : undefined
                }
            }
        };
        return sesClient.send(new SendEmailCommand(params));
    } else if (sesClient && sesClient.sendEmail) {
        const params = {
            Source: from,
            Destination: { ToAddresses: destinations },
            ReplyToAddresses: replyToList,
            Message: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: {
                    Html: htmlBody ? { Data: htmlBody, Charset: 'UTF-8' } : undefined,
                    Text: textBody ? { Data: textBody, Charset: 'UTF-8' } : undefined
                }
            }
        };
        return sesClient.sendEmail(params).promise();
    } else {
        throw new Error('AWS SES Client is not available in the current runtime environment.');
    }
}

function buildTicketEmailHtml({ attendeeName, eventName, date, time, venue, ticketId, quantity, price, qrUrl }) {
    const qrImage = qrUrl || `https://quickchart.io/qr?text=${encodeURIComponent('Ticket ID: ' + ticketId + '\nEvent: ' + eventName + '\nAttendee: ' + attendeeName)}&size=220`;
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your EventPro Ticket</title>
</head>
<body style="margin:0; padding:0; background-color:#0b0d14; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#ffffff;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0b0d14; padding:20px 10px;">
        <tr>
            <td align="center">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; background:#121622; border:1px solid #1f2739; border-radius:16px; overflow:hidden; box-shadow:0 12px 36px rgba(0,0,0,0.5);">
                    <!-- Header -->
                    <tr>
                        <td style="padding:28px 30px; background:linear-gradient(135deg, #f84464 0%, #c81d45 100%); text-align:left;">
                            <table width="100%">
                                <tr>
                                    <td>
                                        <div style="font-size:22px; font-weight:800; color:#ffffff; letter-spacing:0.5px;">EVENTPRO</div>
                                        <div style="font-size:13px; color:rgba(255,255,255,0.85); margin-top:3px;">Official Ticket & Booking Confirmation</div>
                                    </td>
                                    <td align="right">
                                        <span style="background:rgba(255,255,255,0.2); color:#fff; font-size:11px; font-weight:700; padding:6px 12px; border-radius:20px; text-transform:uppercase; letter-spacing:1px;">CONFIRMED</span>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding:30px;">
                            <p style="margin:0 0 16px 0; font-size:16px; color:#e2e8f0;">Hi <strong>${attendeeName || 'Attendee'}</strong>,</p>
                            <p style="margin:0 0 24px 0; font-size:14px; line-height:1.6; color:#94a3b8;">
                                Your reservation has been secured! Present this digital pass or QR code at the entrance for express check-in.
                            </p>
                            
                            <!-- Event Details Card -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#181e2e; border:1px solid #232b3e; border-radius:12px; padding:20px; margin-bottom:24px;">
                                <tr>
                                    <td colspan="2" style="padding-bottom:14px;">
                                        <div style="font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#f84464; font-weight:700; margin-bottom:4px;">EVENT</div>
                                        <div style="font-size:18px; font-weight:700; color:#ffffff; line-height:1.3;">${eventName}</div>
                                    </td>
                                </tr>
                                <tr>
                                    <td width="50%" style="padding:8px 0; border-top:1px solid #232b3e;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase;">📅 Date & Time</div>
                                        <div style="font-size:14px; color:#ffffff; font-weight:600; margin-top:2px;">${date || 'TBD'} ${time ? '• ' + time : ''}</div>
                                    </td>
                                    <td width="50%" style="padding:8px 0; border-top:1px solid #232b3e;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase;">📍 Location</div>
                                        <div style="font-size:14px; color:#ffffff; font-weight:600; margin-top:2px;">${venue || 'TBA'}</div>
                                    </td>
                                </tr>
                                <tr>
                                    <td width="50%" style="padding:8px 0; border-top:1px solid #232b3e;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase;">🎟️ Quantity</div>
                                        <div style="font-size:14px; color:#ffffff; font-weight:600; margin-top:2px;">${quantity || 1} Ticket(s)</div>
                                    </td>
                                    <td width="50%" style="padding:8px 0; border-top:1px solid #232b3e;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase;">💳 Total Paid</div>
                                        <div style="font-size:14px; color:#10b981; font-weight:700; margin-top:2px;">${price ? '₹' + price : 'Free'}</div>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- QR Code Card -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0d14; border:1px dashed #334155; border-radius:12px; padding:20px; text-align:center; margin-bottom:24px;">
                                <tr>
                                    <td align="center">
                                        <div style="font-size:11px; color:#94a3b8; letter-spacing:1px; text-transform:uppercase; margin-bottom:12px; font-weight:600;">GATE ADMISSION PASS</div>
                                        <div style="display:inline-block; padding:10px; background:#ffffff; border-radius:10px;">
                                            <img src="${qrImage}" alt="Ticket QR" width="180" height="180" style="display:block; border:0;" />
                                        </div>
                                        <div style="font-family:Courier, monospace; font-size:13px; color:#38bdf8; font-weight:700; margin-top:12px; letter-spacing:1px;">
                                            ${ticketId}
                                        </div>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Footer notes -->
                            <p style="margin:0; font-size:12px; color:#64748b; text-align:center; line-height:1.5;">
                                Questions or need assistance? Reply directly to this email or reach us at <a href="mailto:support@eventpro24.online" style="color:#f84464; text-decoration:none;">support@eventpro24.online</a>.
                            </p>
                        </td>
                    </tr>
                    
                    <tr>
                        <td style="padding:16px; background:#0b0d14; border-top:1px solid #1f2739; text-align:center; font-size:11px; color:#475569;">
                            © ${new Date().getFullYear()} EventPro. All rights reserved. • eventpro24.online
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `;
}

function buildAlertEmailHtml({ toName, eventName, alertTitle, alertMessage, priority }) {
    const isUrgent = priority === 'high' || priority === 'urgent';
    return `
<!DOCTYPE html>
<html>
<body style="margin:0; padding:20px; background:#0b0d14; font-family:sans-serif; color:#fff;">
    <div style="max-width:540px; margin:auto; background:#121622; border:1px solid #232b3e; border-radius:14px; padding:24px;">
        <div style="display:inline-block; padding:4px 10px; border-radius:6px; font-size:11px; font-weight:bold; text-transform:uppercase; background:${isUrgent ? '#ef4444' : '#f59e0b'}; color:#fff;">
            ${isUrgent ? 'URGENT NOTIFICATION' : 'EVENT UPDATE'}
        </div>
        <h2 style="margin:12px 0 6px 0; color:#fff;">${alertTitle}</h2>
        <div style="font-size:13px; color:#94a3b8; margin-bottom:16px;">Regarding: <strong>${eventName}</strong></div>
        <div style="background:#181e2e; border-left:4px solid ${isUrgent ? '#ef4444' : '#38bdf8'}; padding:16px; border-radius:6px; font-size:14px; line-height:1.6; color:#e2e8f0; margin-bottom:20px;">
            ${alertMessage}
        </div>
        <p style="font-size:12px; color:#64748b; text-align:center; margin:0;">
            Sent via EventPro broadcast system. Contact <a href="mailto:support@eventpro24.online" style="color:#f84464;">support@eventpro24.online</a> for inquiries.
        </p>
    </div>
</body>
</html>
    `;
}

exports.handler = async (event) => {
    // Enable CORS for API Gateway
    const headers = {
        "Access-Control-Allow-Origin": "*",
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

        // 1. Endpoint to create a Razorpay order
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

        // 2. Endpoint to verify Razorpay payment signature
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

        // 3. Endpoint to send transactional emails via AWS SES
        if (path && path.endsWith('/api/send-email') && httpMethod === 'POST') {
            const {
                type = 'ticket',
                to_email,
                to_name,
                subject,
                event_title,
                event_date,
                event_time,
                event_venue,
                ticket_id,
                quantity,
                price,
                qr_url,
                alert_title,
                alert_message,
                priority,
                custom_html
            } = body;

            if (!to_email) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ success: false, error: 'Recipient email (to_email) is required' })
                };
            }

            let emailSubject = subject;
            let htmlContent = custom_html;

            if (type === 'ticket') {
                emailSubject = emailSubject || `🎟️ Ticket Confirmed: ${event_title || 'Your Event'}`;
                htmlContent = htmlContent || buildTicketEmailHtml({
                    attendeeName: to_name,
                    eventName: event_title || 'Event',
                    date: event_date,
                    time: event_time,
                    venue: event_venue,
                    ticketId: ticket_id || `TKT-${Date.now()}`,
                    quantity: quantity || 1,
                    price: price,
                    qrUrl: qr_url
                });
            } else if (type === 'alert') {
                emailSubject = emailSubject || `🔔 Alert: ${alert_title || 'Event Update'}`;
                htmlContent = htmlContent || buildAlertEmailHtml({
                    toName: to_name,
                    eventName: event_title || 'Event',
                    alertTitle: alert_title || 'Notice',
                    alertMessage: alert_message || '',
                    priority: priority || 'normal'
                });
            } else if (!htmlContent) {
                htmlContent = `<p>${body.message || 'Notification from EventPro'}</p>`;
            }

            const sendResult = await sendSESEmail({
                fromEmail: '"EventPro Tickets" <no-reply@eventpro24.online>',
                toEmail: to_email,
                replyTo: 'support@eventpro24.online',
                subject: emailSubject,
                htmlBody: htmlContent,
                textBody: `EventPro Confirmation: ${emailSubject}`
            });

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    message: 'Email delivered successfully via Amazon SES',
                    messageId: sendResult.MessageId
                })
            };
        }

        // 4. Fallback for undefined routes
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
