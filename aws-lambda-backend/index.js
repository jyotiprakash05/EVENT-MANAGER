const crypto = require('crypto');

// Lazy-load Razorpay so missing npm module doesn't crash entire Lambda initialization
let razorpayInstance = null;
function getRazorpay() {
    if (!razorpayInstance) {
        try {
            const Razorpay = require('razorpay');
            razorpayInstance = new Razorpay({
                key_id: process.env.RAZORPAY_KEY_ID || 'rzp_live_TqawwTSUz6rvuH',
                key_secret: process.env.RAZORPAY_KEY_SECRET || 'UaISwuAoNfWtfvc3v4YKdGck',
            });
        } catch (e) {
            console.warn('Razorpay package not bundled:', e.message);
            return null;
        }
    }
    return razorpayInstance;
}

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

// Initialize AWS DynamoDB DocumentClient
let ddbDocClient = null;
function getDocClient() {
    if (!ddbDocClient) {
        try {
            const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
            const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
            const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-south-1' });
            ddbDocClient = DynamoDBDocumentClient.from(client, {
                marshallOptions: { removeUndefinedValues: true }
            });
        } catch (e) {
            console.warn('DynamoDB client init notice:', e.message);
            return null;
        }
    }
    return ddbDocClient;
}

async function handleWebhookEvent(webhookPayload, docClient) {
    const { PutCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
    const eventType = webhookPayload.event;
    const payload = webhookPayload.payload || {};
    const now = new Date().toISOString();

    console.log(`Processing Webhook event: ${eventType}`);

    if (eventType === 'payment.captured' || eventType === 'payment.authorized' || eventType === 'payment.failed') {
        const payment = payload.payment ? payload.payment.entity : null;
        if (!payment) return;

        const paymentId = payment.id;
        const orderId = payment.order_id || 'N/A';
        const amount = payment.amount ? payment.amount / 100 : 0;
        const notes = payment.notes || {};
        const ticketId = notes.ticketId || notes.ticket_id;
        const eventId = notes.eventId || notes.event_id;
        const userId = notes.userId || notes.user_id;

        // 1. Record or update payment in EventProPayments
        const paymentRecord = {
            paymentId: paymentId,
            orderId: orderId,
            amount: amount,
            currency: payment.currency || 'INR',
            status: payment.status || (eventType === 'payment.captured' ? 'captured' : 'failed'),
            method: payment.method || 'razorpay',
            email: payment.email || null,
            contact: payment.contact || null,
            ticketId: ticketId || null,
            eventId: eventId || null,
            userId: userId || null,
            eventType: eventType,
            updatedAt: now,
            createdAt: payment.created_at ? new Date(payment.created_at * 1000).toISOString() : now
        };

        try {
            await docClient.send(new PutCommand({
                TableName: 'EventProPayments',
                Item: paymentRecord
            }));
            console.log(`Saved payment record to EventProPayments: ${paymentId}`);
        } catch (pErr) {
            console.error('Error saving to EventProPayments:', pErr.message);
        }

        // 2. If ticketId provided, update EventProTickets
        if (ticketId && payment.status === 'captured') {
            try {
                await docClient.send(new UpdateCommand({
                    TableName: 'EventProTickets',
                    Key: { ticketId: ticketId },
                    UpdateExpression: 'SET paymentStatus = :ps, paymentId = :pid, paymentOrderId = :poid, updatedAt = :u',
                    ExpressionAttributeValues: {
                        ':ps': 'captured',
                        ':pid': paymentId,
                        ':poid': orderId,
                        ':u': now
                    }
                }));
                console.log(`Updated ticket ${ticketId} paymentStatus to captured`);
            } catch (tErr) {
                console.warn(`Could not update ticket ${ticketId}:`, tErr.message);
            }
        }
    } else if (eventType === 'order.paid') {
        const order = payload.order ? payload.order.entity : null;
        const payment = payload.payment ? payload.payment.entity : null;
        const paymentId = payment ? payment.id : (order ? `order_${order.id}` : `pay_${Date.now()}`);
        
        try {
            await docClient.send(new PutCommand({
                TableName: 'EventProPayments',
                Item: {
                    paymentId: paymentId,
                    orderId: order ? order.id : (payment ? payment.order_id : 'N/A'),
                    amount: payment && payment.amount ? payment.amount / 100 : (order && order.amount ? order.amount / 100 : 0),
                    status: 'paid',
                    currency: (order && order.currency) || (payment && payment.currency) || 'INR',
                    method: payment && payment.method ? payment.method : 'razorpay',
                    eventType: eventType,
                    updatedAt: now,
                    createdAt: now
                }
            }));
            console.log(`Recorded order.paid in EventProPayments: ${paymentId}`);
        } catch (oErr) {
            console.error('Error saving order.paid to EventProPayments:', oErr.message);
        }
    } else if (eventType === 'refund.processed' || eventType === 'refund.created') {
        const refund = payload.refund ? payload.refund.entity : null;
        const payment = payload.payment ? payload.payment.entity : null;
        if (!refund) return;

        const refundId = refund.id;
        const paymentId = refund.payment_id || (payment ? payment.id : 'N/A');
        const refundAmount = refund.amount ? refund.amount / 100 : 0;
        const notes = refund.notes || (payment ? payment.notes : {}) || {};
        let ticketId = notes.ticketId || notes.ticket_id;

        // 1. Record refund in EventProPayments
        try {
            await docClient.send(new PutCommand({
                TableName: 'EventProPayments',
                Item: {
                    paymentId: refundId,
                    originalPaymentId: paymentId,
                    amount: refundAmount,
                    status: 'refunded',
                    eventType: eventType,
                    updatedAt: now,
                    createdAt: refund.created_at ? new Date(refund.created_at * 1000).toISOString() : now
                }
            }));
            console.log(`Recorded refund in EventProPayments: ${refundId}`);
        } catch (rfErr) {
            console.error('Error saving refund in EventProPayments:', rfErr.message);
        }

        // 2. Identify and update ticket in EventProTickets
        if (!ticketId && paymentId && paymentId !== 'N/A') {
            try {
                const scanRes = await docClient.send(new ScanCommand({
                    TableName: 'EventProTickets',
                    FilterExpression: 'paymentId = :pid',
                    ExpressionAttributeValues: { ':pid': paymentId },
                    Limit: 1
                }));
                if (scanRes.Items && scanRes.Items.length > 0) {
                    ticketId = scanRes.Items[0].ticketId;
                }
            } catch (scanErr) {
                console.warn('Scan for paymentId failed:', scanErr.message);
            }
        }

        if (ticketId) {
            try {
                await docClient.send(new UpdateCommand({
                    TableName: 'EventProTickets',
                    Key: { ticketId: ticketId },
                    UpdateExpression: 'SET #st = :cancelled, paymentStatus = :ps, refundId = :rid, refundAmount = :ra, refundedAt = :u, updatedAt = :u',
                    ExpressionAttributeNames: {
                        '#st': 'status'
                    },
                    ExpressionAttributeValues: {
                        ':cancelled': 'cancelled',
                        ':ps': 'refunded',
                        ':rid': refundId,
                        ':ra': refundAmount,
                        ':u': now
                    }
                }));
                console.log(`Updated ticket ${ticketId} to cancelled/refunded`);
            } catch (err) {
                console.warn(`Could not update ticket ${ticketId} on refund:`, err.message);
            }
        }
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

function buildTicketEmailHtml({ attendeeName, eventName, date, time, venue, ticketId, quantity, price }) {
    const frontendBase = process.env.FRONTEND_BASE_URL || 'https://eventpro24.online';
    const livePassUrl = `${frontendBase}/Attendee_Dashboard/Your_Booking.html?ticketId=${encodeURIComponent(ticketId)}`;
    const googleCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('Event: ' + eventName)}&details=${encodeURIComponent('Ticket ID: ' + ticketId + '\nYour live entry pass: ' + livePassUrl)}&location=${encodeURIComponent(venue || 'Venue')}`;
    const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue || eventName)}`;

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your EventPro Ticket</title>
</head>
<body style="margin:0; padding:0; background-color:#0b0d14; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#ffffff;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0b0d14; padding:24px 10px;">
        <tr>
            <td align="center">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; background:#121622; border:1px solid #1f2739; border-radius:18px; overflow:hidden; box-shadow:0 16px 40px rgba(0,0,0,0.6);">
                    <!-- Header -->
                    <tr>
                        <td style="padding:28px 32px; background:linear-gradient(135deg, #f84464 0%, #c81d45 100%); text-align:left;">
                            <table width="100%">
                                <tr>
                                    <td>
                                        <div style="font-size:22px; font-weight:800; color:#ffffff; letter-spacing:0.5px;">EVENTPRO</div>
                                        <div style="font-size:13px; color:rgba(255,255,255,0.9); margin-top:3px;">Official Ticket & Booking Confirmation</div>
                                    </td>
                                    <td align="right">
                                        <span style="background:rgba(255,255,255,0.22); color:#fff; font-size:11px; font-weight:700; padding:6px 14px; border-radius:20px; text-transform:uppercase; letter-spacing:1px;">CONFIRMED</span>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding:32px;">
                            <p style="margin:0 0 16px 0; font-size:16px; color:#e2e8f0;">Hi <strong>${attendeeName || 'Attendee'}</strong>,</p>
                            <p style="margin:0 0 24px 0; font-size:14px; line-height:1.6; color:#94a3b8;">
                                Your reservation has been secured! Tap the button below anytime on your phone to display your live entry pass.
                            </p>
                            
                            <!-- Primary Live Pass Action Box -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0d14; border:1px solid #2a354c; border-radius:14px; padding:24px; text-align:center; margin-bottom:26px;">
                                <tr>
                                    <td align="center">
                                        <div style="font-size:11px; color:#38bdf8; letter-spacing:1px; text-transform:uppercase; margin-bottom:12px; font-weight:700;">GATE ADMISSION PASS</div>
                                        <div style="font-family:Courier, monospace; font-size:16px; color:#ffffff; font-weight:700; margin-bottom:18px; letter-spacing:1px;">
                                            ${ticketId}
                                        </div>
                                        <a href="${livePassUrl}" target="_blank" style="display:inline-block; background:linear-gradient(135deg, #f84464 0%, #d81b40 100%); color:#ffffff; font-size:15px; font-weight:700; padding:14px 32px; border-radius:10px; text-decoration:none; box-shadow:0 6px 20px rgba(248,68,100,0.4); letter-spacing:0.3px;">
                                            ⚡ View Live Dynamic Pass
                                        </a>
                                        <div style="font-size:12px; color:#64748b; margin-top:12px;">
                                            Opens your rolling live ticket in the EventPro app
                                        </div>
                                    </td>
                                </tr>
                            </table>

                            <!-- Event Details Card -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#181e2e; border:1px solid #232b3e; border-radius:12px; padding:20px; margin-bottom:24px;">
                                <tr>
                                    <td colspan="2" style="padding-bottom:14px;">
                                        <div style="font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#f84464; font-weight:700; margin-bottom:4px;">EVENT</div>
                                        <div style="font-size:18px; font-weight:700; color:#ffffff; line-height:1.3;">${eventName}</div>
                                    </td>
                                </tr>
                                <tr>
                                    <td width="50%" style="padding:10px 0; border-top:1px solid #232b3e;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase;">📅 Date & Time</div>
                                        <div style="font-size:14px; color:#ffffff; font-weight:600; margin-top:2px;">${date || 'TBD'} ${time ? '• ' + time : ''}</div>
                                    </td>
                                    <td width="50%" style="padding:10px 0; border-top:1px solid #232b3e;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase;">📍 Location</div>
                                        <div style="font-size:14px; color:#ffffff; font-weight:600; margin-top:2px;">${venue || 'TBA'}</div>
                                    </td>
                                </tr>
                                <tr>
                                    <td width="50%" style="padding:10px 0; border-top:1px solid #232b3e;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase;">🎟️ Quantity</div>
                                        <div style="font-size:14px; color:#ffffff; font-weight:600; margin-top:2px;">${quantity || 1} Ticket(s)</div>
                                    </td>
                                    <td width="50%" style="padding:10px 0; border-top:1px solid #232b3e;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase;">💳 Total Paid</div>
                                        <div style="font-size:14px; color:#10b981; font-weight:700; margin-top:2px;">${price ? '₹' + price : 'Free'}</div>
                                    </td>
                                </tr>
                            </table>

                            <!-- Quick Action Buttons (Calendar & Maps) -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
                                <tr>
                                    <td width="48%" align="center">
                                        <a href="${googleCalUrl}" target="_blank" style="display:block; background:#181e2e; border:1px solid #2a354c; color:#cbd5e1; font-size:13px; font-weight:600; padding:11px 14px; border-radius:8px; text-decoration:none; text-align:center;">
                                            📅 Add to Google Calendar
                                        </a>
                                    </td>
                                    <td width="4%"></td>
                                    <td width="48%" align="center">
                                        <a href="${googleMapsUrl}" target="_blank" style="display:block; background:#181e2e; border:1px solid #2a354c; color:#cbd5e1; font-size:13px; font-weight:600; padding:11px 14px; border-radius:8px; text-decoration:none; text-align:center;">
                                            📍 Directions on Maps
                                        </a>
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

function buildWaitlistPromotedHtml({ toName, eventName, ticketId, claimUrl }) {
    const url = claimUrl || 'https://eventpro24.online/Attendee_Dashboard/Your_Booking.html';
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Priority Waitlist Spot Unlocked!</title>
</head>
<body style="margin:0; padding:0; background-color:#0b0d14; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#ffffff;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0b0d14; padding:24px 10px;">
        <tr>
            <td align="center">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; background:#121622; border:1px solid #1f2739; border-radius:18px; overflow:hidden; box-shadow:0 16px 40px rgba(0,0,0,0.6);">
                    <tr>
                        <td style="padding:28px 24px; background:linear-gradient(135deg, #059669 0%, #10b981 100%); text-align:center;">
                            <div style="font-size:32px; margin-bottom:8px;">🎉</div>
                            <h1 style="margin:0; font-size:22px; font-weight:800; color:#ffffff; letter-spacing:-0.5px;">Spot Unlocked from Waitlist!</h1>
                            <p style="margin:6px 0 0; font-size:13px; color:#d1fae5; font-weight:500;">A ticket opened up via cancellation under our 72h policy</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:24px 28px;">
                            <p style="margin:0 0 16px; font-size:15px; color:#cbd5e1; line-height:1.6;">
                                Hi <strong>${toName || 'Event Enthusiast'}</strong>,<br>
                                You were next in line on the priority queue, and a confirmed spot for <strong>${eventName}</strong> has just been reserved for you!
                            </p>
                            <div style="background:#0c0e14; border:1px solid #232b3e; border-radius:12px; padding:18px; margin-bottom:20px;">
                                <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;">Event</div>
                                <div style="font-size:16px; font-weight:700; color:#ffffff; margin-bottom:12px;">${eventName}</div>
                                <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;">Reservation Window</div>
                                <div style="font-size:13px; font-weight:600; color:#34d399;">⏱️ Reserved for 24 Hours (First-come confirmation)</div>
                            </div>
                            <div style="text-align:center; margin:24px 0 16px;">
                                <a href="${url}" target="_blank" style="display:inline-block; background:linear-gradient(135deg, #10b981, #059669); color:#ffffff; text-decoration:none; padding:14px 28px; border-radius:10px; font-weight:700; font-size:14px; box-shadow:0 6px 20px rgba(16,185,129,0.35);">
                                    Claim Your Ticket Now ➔
                                </a>
                            </div>
                            <p style="margin:0; font-size:12px; color:#64748b; text-align:center; line-height:1.5;">
                                If you do not claim this spot within 24 hours, it will automatically roll to the next waitlisted attendee.
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:16px; background:#0b0d14; border-top:1px solid #1f2739; text-align:center; font-size:11px; color:#475569;">
                            © ${new Date().getFullYear()} EventPro Ticketing Platform • eventpro24.online
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

function buildCancellationEmailHtml({ attendeeName, eventName, ticketId, originalPrice, cancellationFee, refundAmount, depositRefunded }) {
    const origPrice = parseFloat(originalPrice) || 0;
    const fee = parseFloat(cancellationFee) || 0;
    const netRefund = parseFloat(refundAmount) || 0;

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Booking Cancellation & Refund Confirmation</title>
</head>
<body style="margin:0; padding:0; background-color:#0b0d14; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#ffffff;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0b0d14; padding:24px 10px;">
        <tr>
            <td align="center">
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; background:#121622; border:1px solid #1f2739; border-radius:18px; overflow:hidden; box-shadow:0 16px 40px rgba(0,0,0,0.6);">
                    <!-- Header -->
                    <tr>
                        <td style="padding:28px 32px; background:linear-gradient(135deg, #ef4444 0%, #b91c1c 100%); text-align:left;">
                            <table width="100%">
                                <tr>
                                    <td>
                                        <div style="font-size:22px; font-weight:800; color:#ffffff; letter-spacing:0.5px;">EVENTPRO</div>
                                        <div style="font-size:13px; color:rgba(255,255,255,0.9); margin-top:3px;">Cancellation & Refund Confirmation</div>
                                    </td>
                                    <td align="right">
                                        <span style="background:rgba(255,255,255,0.22); color:#fff; font-size:11px; font-weight:700; padding:6px 14px; border-radius:20px; text-transform:uppercase; letter-spacing:1px;">CANCELLED</span>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding:32px;">
                            <p style="margin:0 0 16px 0; font-size:16px; color:#e2e8f0;">Hi <strong>${attendeeName || 'Attendee'}</strong>,</p>
                            <p style="margin:0 0 24px 0; font-size:14px; line-height:1.6; color:#94a3b8;">
                                Your reservation for <strong>${eventName}</strong> has been cancelled. Your admission pass and dynamic QR code have been deactivated.
                            </p>
                            
                            <!-- Refund Summary Card with 2% deduction breakdown -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0d14; border:1px solid #2a354c; border-radius:14px; padding:20px; margin-bottom:24px;">
                                <tr>
                                    <td>
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:1px;">TICKET ID</div>
                                        <div style="font-family:Courier, monospace; font-size:15px; color:#ffffff; font-weight:700; margin-top:2px;">${ticketId}</div>
                                    </td>
                                </tr>
                                ${origPrice > 0 ? `
                                <tr>
                                    <td style="padding-top:14px; border-top:1px solid #1f2739;">
                                        <table width="100%" style="font-size:13px; color:#cbd5e1;">
                                            <tr>
                                                <td style="padding:4px 0; color:#94a3b8;">Original Ticket Price:</td>
                                                <td align="right" style="padding:4px 0; font-weight:600; color:#ffffff;">₹${origPrice}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:4px 0; color:#f87171;">Cancellation Deduction (2%):</td>
                                                <td align="right" style="padding:4px 0; font-weight:600; color:#f87171;">-₹${fee}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:8px 0 4px 0; border-top:1px dashed #232b3e; font-weight:700; color:#10b981;">Net Refund Credited:</td>
                                                <td align="right" style="padding:8px 0 4px 0; border-top:1px dashed #232b3e; font-size:18px; font-weight:800; color:#10b981;">₹${netRefund}</td>
                                            </tr>
                                        </table>
                                        <div style="font-size:12px; color:#64748b; margin-top:8px;">
                                            ⏱️ Validated against the 72-hour cancellation rule. Net refund will be credited back to your original payment method in 5-7 business days.
                                        </div>
                                    </td>
                                </tr>
                                ` : `
                                <tr>
                                    <td style="padding-top:14px; border-top:1px solid #1f2739;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:1px;">REFUND STATUS</div>
                                        <div style="font-size:18px; color:#10b981; font-weight:800; margin-top:2px;">Free Reservation • No Charge</div>
                                        <div style="font-size:12px; color:#64748b; margin-top:4px;">No payment was debited for this booking.</div>
                                    </td>
                                </tr>
                                `}
                                ${depositRefunded && depositRefunded > 0 ? `
                                <tr>
                                    <td style="padding-top:14px; border-top:1px solid #1f2739;">
                                        <div style="font-size:11px; color:#94a3b8; text-transform:uppercase; letter-spacing:1px;">ESCROW PLEDGE RELEASED (100%)</div>
                                        <div style="font-size:16px; color:#38bdf8; font-weight:700; margin-top:2px;">₹${depositRefunded}</div>
                                    </td>
                                </tr>
                                ` : ''}
                            </table>

                            <p style="margin:0 0 20px 0; font-size:13px; line-height:1.6; color:#94a3b8;">
                                If you did not request this cancellation or need any assistance, reach out directly to our support desk at <a href="mailto:support@eventpro24.online" style="color:#f84464; text-decoration:none;">support@eventpro24.online</a>.
                            </p>

                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td align="center">
                                        <a href="https://eventpro24.online/Attendee_Dashboard/Event_List.html" target="_blank" style="display:inline-block; background:#181e2e; border:1px solid #2a354c; color:#cbd5e1; font-size:13px; font-weight:600; padding:12px 24px; border-radius:8px; text-decoration:none;">
                                            Explore Upcoming Events
                                        </a>
                                    </td>
                                </tr>
                            </table>
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

exports.handler = async (event) => {
    // Enable CORS for API Gateway
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Razorpay-Signature,x-razorpay-signature",
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
            
            const rzp = getRazorpay();
            if (!rzp) {
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ success: false, error: 'Razorpay SDK is not bundled in Lambda package' })
                };
            }
            const order = await rzp.orders.create(options);
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
                .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || 'BZJrebtT9kXDv3Tckg7Yo6Wg')
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

        // 3. Endpoint to refund a Razorpay payment
        if (path && path.endsWith('/api/payment/refund') && httpMethod === 'POST') {
            const { payment_id, amount, notes } = body;
            
            if (!payment_id) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: true,
                        simulated: true,
                        message: "Free reservation or no payment ID recorded. Refund logged."
                    })
                };
            }

            const rzp = getRazorpay();
            if (!rzp) {
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ success: false, error: 'Razorpay SDK is not bundled in Lambda package' })
                };
            }

            const refundPayload = {
                notes: notes || {}
            };
            if (amount && amount > 0) {
                refundPayload.amount = Math.round(amount * 100); // in paise
            }

            try {
                const refund = await rzp.payments.refund(payment_id, refundPayload);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: true,
                        message: "Refund processed successfully via Razorpay",
                        refundId: refund.id,
                        amount: (refund.amount || 0) / 100,
                        status: refund.status
                    })
                };
            } catch (rzpErr) {
                console.error("Razorpay refund notice:", rzpErr);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: true,
                        warning: rzpErr.message,
                        message: "Refund recorded in EventPro ledger. Gateway notice: " + (rzpErr.error ? rzpErr.error.description : rzpErr.message)
                    })
                };
            }
        }

        // 4. Endpoint to send transactional emails via AWS SES
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
                deposit_refunded,
                original_price,
                cancellation_fee,
                refund_amount,
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
            } else if (type === 'cancellation') {
                emailSubject = emailSubject || `⚠️ Cancellation & Refund Confirmation: ${event_title || 'Your Event'}`;
                htmlContent = htmlContent || buildCancellationEmailHtml({
                    attendeeName: to_name,
                    eventName: event_title || 'Event',
                    ticketId: ticket_id || 'TKT-N/A',
                    originalPrice: original_price !== undefined ? original_price : (price || 0),
                    cancellationFee: cancellation_fee || 0,
                    refundAmount: refund_amount !== undefined ? refund_amount : (price || 0),
                    depositRefunded: deposit_refunded || 0
                });
            } else if (type === 'waitlist_promoted') {
                emailSubject = emailSubject || `🎉 Spot Unlocked! Claim your ticket for ${event_title || 'Event'}`;
                htmlContent = htmlContent || buildWaitlistPromotedHtml({
                    toName: to_name,
                    eventName: event_title || 'Event',
                    ticketId: ticket_id || 'WTL-PASS',
                    claimUrl: body.claim_url || 'https://eventpro24.online/Attendee_Dashboard/Your_Booking.html'
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

        // 5. Endpoint for Razorpay Webhook notifications
        if (path && path.endsWith('/api/payment/webhook') && httpMethod === 'POST') {
            const reqHeaders = event.headers || {};
            const webhookSignature = reqHeaders['x-razorpay-signature'] || reqHeaders['X-Razorpay-Signature'];
            const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || 'BZJrebtT9kXDv3Tckg7Yo6Wg';
            
            const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf-8') : (event.body || '');
            
            if (webhookSignature) {
                const expectedSignature = crypto
                    .createHmac('sha256', webhookSecret)
                    .update(rawBody)
                    .digest('hex');
                if (webhookSignature !== expectedSignature) {
                    console.error('Webhook signature validation failed. Expected:', expectedSignature, 'Got:', webhookSignature);
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({ success: false, message: 'Invalid webhook signature' })
                    };
                }
            } else {
                console.warn('Webhook received without signature header; continuing execution');
            }

            let webhookPayload = {};
            try {
                webhookPayload = typeof body === 'object' && Object.keys(body).length > 0 ? body : JSON.parse(rawBody || '{}');
            } catch (pErr) {
                webhookPayload = {};
            }

            const eventName = webhookPayload.event || 'unknown';
            console.log(`Razorpay Webhook event received: ${eventName}`);

            const docClient = getDocClient();
            if (docClient) {
                try {
                    await handleWebhookEvent(webhookPayload, docClient);
                } catch (webhookErr) {
                    console.error('Error handling webhook in DynamoDB:', webhookErr);
                }
            } else {
                console.warn('DynamoDB DocumentClient not available for webhook processing');
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    status: 'ok',
                    event: eventName,
                    received: true,
                    timestamp: new Date().toISOString()
                })
            };
        }

        // 6. Fallback for undefined routes
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
