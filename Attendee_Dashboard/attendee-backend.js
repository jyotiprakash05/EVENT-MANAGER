(function () {
    const config = window.EVENTPRO_AWS_CONFIG;
    const sdk = window.AmazonCognitoIdentity;

    if (!config || !sdk) return;

    const pool = new sdk.CognitoUserPool({
        UserPoolId: config.userPoolId,
        ClientId: config.clientId
    });
    
    let docClient = null;
    let currentUserSub = null;
    let currentUserEmail = null;
    
    function initAWS(callback) {
        const user = pool.getCurrentUser();
        if (docClient && (!user || currentUserSub)) {
            callback(null);
            return;
        }

        if (!user) {
            // Unauthenticated guest access (e.g. paying split links)
            AWS.config.region = config.region;
            AWS.config.credentials = new AWS.CognitoIdentityCredentials({
                IdentityPoolId: config.identityPoolId
            });

            AWS.config.credentials.get(function(err) {
                if (err) {
                    callback(err);
                    return;
                }
                docClient = new AWS.DynamoDB.DocumentClient();
                callback(null);
            });
            return;
        }

        user.getSession(function (error, session) {
            if (error) {
                callback(error);
                return;
            }

            const idToken = session.getIdToken().getJwtToken();
            currentUserSub = session.getIdToken().payload.sub;
            currentUserEmail = session.getIdToken().payload.email || null;
            
            const logins = {};
            logins[`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`] = idToken;
            
            AWS.config.region = config.region;
            AWS.config.credentials = new AWS.CognitoIdentityCredentials({
                IdentityPoolId: config.identityPoolId,
                Logins: logins
            });

            AWS.config.credentials.get(function(err) {
                if (err) {
                    callback(err);
                    return;
                }
                docClient = new AWS.DynamoDB.DocumentClient();
                callback(null);
            });
        });
    }

    function parseDeadline(dlString) {
        return getEventStartDateTime(dlString);
    }

    function getEventStartDateTime(dateStr, timeStr) {
        if (!dateStr || typeof dateStr !== 'string') return null;
        let cleanDate = dateStr.trim();
        if (!cleanDate || cleanDate.toUpperCase() === 'TBD' || cleanDate.toUpperCase() === 'TBA') return null;
        let cleanTime = (timeStr && typeof timeStr === 'string') ? timeStr.trim() : '';
        if (cleanTime.toUpperCase() === 'TBD' || cleanTime.toUpperCase() === 'TBA') cleanTime = '';

        // Case 1: ISO timestamp with 'T' (e.g. "2026-10-14T12:00" or "2027-06-10T05:15:00Z")
        if (cleanDate.includes('T')) {
            const isoMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?/);
            if (isoMatch) {
                const y = parseInt(isoMatch[1], 10);
                const m = parseInt(isoMatch[2], 10) - 1;
                const d = parseInt(isoMatch[3], 10);
                const h = parseInt(isoMatch[4], 10);
                const min = parseInt(isoMatch[5], 10);
                const s = isoMatch[6] ? parseInt(isoMatch[6], 10) : 0;
                return new Date(y, m, d, h, min, s);
            }
            const isoParsed = new Date(cleanDate);
            if (!isNaN(isoParsed.getTime())) return isoParsed;
        }

        // Case 2: Embedded time in date string (e.g. "2026-12-01 12:00 PM")
        const embeddedTimeMatch = cleanDate.match(/\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?|\d{1,2}\s*[AaPp][Mm])$/);
        if (embeddedTimeMatch) {
            if (!cleanTime) {
                cleanTime = embeddedTimeMatch[1].trim();
            }
            cleanDate = cleanDate.replace(embeddedTimeMatch[0], '').trim();
        }

        // Case 3: Start time from range (e.g. "10:00 AM - 01:00 PM" or "10:00 to 13:00")
        if (cleanTime) {
            const rangeSplit = cleanTime.split(/\s*(?:-|–|—|to)\s*/i);
            if (rangeSplit.length > 0) {
                cleanTime = rangeSplit[0].trim();
            }
        }

        let hours = 0;
        let minutes = 0;
        let seconds = 0;
        let hasExplicitTime = false;

        if (cleanTime) {
            // Matches "8:00 PM", "08:00 AM", "8:30pm", "8pm", "8 PM", "14:30", "09:00", "12:45"
            const tMatch = cleanTime.match(/(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp][Mm])?/i);
            if (tMatch) {
                hasExplicitTime = true;
                hours = parseInt(tMatch[1], 10);
                minutes = tMatch[2] ? parseInt(tMatch[2], 10) : 0;
                seconds = tMatch[3] ? parseInt(tMatch[3], 10) : 0;
                const ampm = tMatch[4] ? tMatch[4].toUpperCase() : null;

                if (ampm === 'PM' && hours < 12) hours += 12;
                if (ampm === 'AM' && hours === 12) hours = 0;
            }
        }

        // Format A: YYYY-MM-DD or YYYY/MM/DD
        const ymd = cleanDate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
        if (ymd) {
            return new Date(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10), hours, minutes, seconds);
        }

        // Format B: DD-MM-YYYY or DD/MM/YYYY
        const dmy = cleanDate.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
        if (dmy) {
            const p1 = parseInt(dmy[1], 10);
            const p2 = parseInt(dmy[2], 10);
            const y = parseInt(dmy[3], 10);
            let day = p1 > 12 ? p1 : (p2 > 12 ? p2 : p1);
            let month = (p1 > 12 ? p2 : (p2 > 12 ? p1 : p2)) - 1;
            return new Date(y, month, day, hours, minutes, seconds);
        }

        // Format C: Text dates like "Oct 25, 2026", "25 October 2026", "Dec 25 2026", "25th Oct 2026"
        const deOrdinal = cleanDate.replace(/(\d+)(?:st|nd|rd|th)/i, '$1');
        const combinedStr = hasExplicitTime ? `${deOrdinal} ${hours}:${minutes}:${seconds}` : deOrdinal;
        const parsedText = new Date(combinedStr);
        if (!isNaN(parsedText.getTime())) return parsedText;

        const fallbackDate = new Date(cleanDate);
        if (!isNaN(fallbackDate.getTime())) {
            if (hasExplicitTime) fallbackDate.setHours(hours, minutes, seconds, 0);
            return fallbackDate;
        }

        return null;
    }

    function getCancellationInfo(ticket, event) {
        const originalPrice = parseFloat(ticket && (ticket.perPersonAmount || ticket.price)) || 0;
        const dateStr = (ticket && ticket.date && ticket.date !== 'TBD' && ticket.date !== 'TBA') 
            ? ticket.date 
            : (event && event.date ? event.date : (ticket && ticket.date));
        const timeStr = (ticket && ticket.time && ticket.time !== 'TBD' && ticket.time !== 'TBA') 
            ? ticket.time 
            : (event && event.time ? event.time : (ticket && ticket.time));
        const eventDate = getEventStartDateTime(dateStr, timeStr);

        let eligible = true;
        let isPast = false;
        let isWithin72h = false;
        let diffHours = Infinity;
        let hoursLeft = 0;
        let reason = "";

        if (ticket && (ticket.status === 'Cancelled' || ticket.status === 'Used')) {
            eligible = false;
            reason = ticket.status === 'Cancelled' ? 'Ticket already cancelled' : 'Ticket already scanned/used';
        } else if (eventDate) {
            const diffMs = eventDate.getTime() - Date.now();
            diffHours = diffMs / (1000 * 60 * 60);
            hoursLeft = Math.max(0, Math.floor(diffHours));

            if (diffHours < 0) {
                eligible = false;
                isPast = true;
                const hoursAgo = Math.abs(Math.floor(diffHours));
                reason = `Event has already ended (${hoursAgo}h ago)`;
            } else if (diffHours < 72) {
                eligible = false;
                isWithin72h = true;
                reason = `Cancellation closed (<72h before event, ${hoursLeft}h remaining)`;
            } else {
                reason = `Eligible for cancellation (${hoursLeft}h until event, 2% deduction applies)`;
            }
        }

        const feePercent = 2;
        const cancellationFee = originalPrice > 0 ? Math.round(originalPrice * 0.02 * 100) / 100 : 0;
        const netRefund = Math.max(0, Math.round((originalPrice - cancellationFee) * 100) / 100);
        const depositAmount = ticket && ticket.hasDeposit ? (parseFloat(ticket.depositAmount) || 0) : 0;

        return {
            eligible: eligible,
            isPast: isPast,
            isWithin72h: isWithin72h,
            diffHours: diffHours,
            hoursLeft: hoursLeft,
            reason: reason,
            originalPrice: originalPrice,
            cancellationFee: cancellationFee,
            feePercent: feePercent,
            netRefund: netRefund,
            depositAmount: depositAmount,
            eventDate: eventDate
        };
    }

    function isEventSalesClosed(event) {
        if (!event) return false;
        const status = (event.status || '').toLowerCase().trim();
        if (['closed', 'ended', 'inactive', 'draft', 'cancelled', 'unlisted'].includes(status)) {
            return true;
        }

        if (event.isUnlisted === true || event.isUnlisted === 'true' || event.unlisted === true) {
            return true;
        }

        let dl = event.salesDeadline || '';
        if (!dl && event.salesDeadlineDate) {
            dl = event.salesDeadlineDate + (event.salesDeadlineTime ? ' ' + event.salesDeadlineTime : '');
        }

        if (dl) {
            const deadline = getEventStartDateTime(dl);
            if (deadline && new Date() > deadline) {
                return true; // Sales deadline has passed
            }
        }

        // Also check if event date/time has already passed
        if (event.date) {
            const evStart = getEventStartDateTime(event.date, event.time);
            if (evStart && new Date() > evStart) {
                return true; // Event already started/concluded
            }
        }

        return false;
    }

    window.AttendeeBackend = {
        isEventSalesClosed: isEventSalesClosed,
        getEventStartDateTime: getEventStartDateTime,
        getCancellationInfo: getCancellationInfo,
        getAllEvents: function(callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.eventsTableName
                };
                
                docClient.scan(params, function(err, data) {
                    if (err) callback(err);
                    else {
                        // Keep events in DynamoDB intact, but hide events from attendees once sales are closed
                        const activeEvents = (data.Items || []).filter(e => !isEventSalesClosed(e));
                        callback(null, activeEvents);
                    }
                });
            });
        },
        
        bookTicket: function(event, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const ticketId = 'TKT-' + Date.now() + '-' + Math.floor(1000 + Math.random() * 9000);
                const hasDeposit = !!(event.hasDeposit || event.hasDepositBond || (parseFloat(event.refundableDeposit) > 0) || (parseFloat(event.depositAmount) > 0));
                const qty = event.quantity || 1;
                const depositPerTicket = parseFloat(event.refundableDeposit || 0);
                const totalDeposit = event.depositAmount !== undefined ? parseFloat(event.depositAmount) : (hasDeposit ? (depositPerTicket * qty) : 0);

                const isGroupSplit = !!event.isGroupSplit;
                const totalSplit = isGroupSplit ? (event.totalSplitMembers || qty || 2) : 1;
                const perPersonAmt = isGroupSplit ? (event.perPersonAmount || Math.round((event.price || 0) / totalSplit)) : (event.price || 0);

                let initialSplitMembers = null;
                if (isGroupSplit) {
                    initialSplitMembers = event.splitMembers && event.splitMembers.length > 0 ? event.splitMembers : [
                        { name: "You (Organizer)", amount: perPersonAmt, status: "Paid", paidAt: new Date().toISOString() }
                    ];
                    while (initialSplitMembers.length < totalSplit) {
                        const idx = initialSplitMembers.length + 1;
                        initialSplitMembers.push({
                            name: `Friend #${idx}`,
                            amount: perPersonAmt,
                            status: "Pending",
                            inviteLink: `${window.location.origin}/Attendee_Dashboard/Pay_Split.html?ticketId=${ticketId}&m=${idx}`
                        });
                    }
                }
                
                const ticketParams = {
                    TableName: config.ticketsTableName,
                    Item: {
                        ticketId: ticketId,
                        eventId: event.eventId,
                        eventName: event.eventName || "Unnamed Event",
                        attendeeId: currentUserSub,
                        status: isGroupSplit ? "Pending Split" : "Valid",
                        date: event.date || "TBD",
                        time: event.time || "TBD",
                        location: event.location || "TBA",
                        quantity: qty,
                        price: event.price || 0,
                        paymentId: event.paymentId || null,
                        orderId: event.orderId || null,
                        attendeeEmail: currentUserEmail || event.attendeeEmail || null,
                        attendeeName: event.attendeeName || null,
                        purchasedAt: new Date().toISOString(),
                        // Proof-of-Presence Escrow Fields
                        hasDeposit: hasDeposit,
                        depositAmount: totalDeposit,
                        depositStatus: hasDeposit ? "Held in Escrow" : "None",
                        // Group Split Booking Fields
                        isGroupSplit: isGroupSplit,
                        totalSplitMembers: totalSplit,
                        paidMembers: 1,
                        perPersonAmount: perPersonAmt,
                        splitStatus: isGroupSplit ? "Pending Friends" : "None",
                        splitMembers: initialSplitMembers,
                        splitExpiresAt: isGroupSplit ? new Date(Date.now() + 15 * 60000).toISOString() : null
                    }
                };
                
                docClient.put(ticketParams, function(putErr) {
                    if (putErr) {
                        console.error("Failed to save ticket", putErr);
                        callback(putErr);
                        return;
                    }
                    
                    const updateEventParams = {
                        TableName: config.eventsTableName,
                        Key: { eventId: event.eventId },
                        UpdateExpression: "set ticketsSold = if_not_exists(ticketsSold, :start) + :inc, revenue = if_not_exists(revenue, :startRev) + :price",
                        ConditionExpression: "attribute_exists(eventId)",
                        ExpressionAttributeValues: {
                            ":inc": qty,
                            ":start": 0,
                            ":price": event.price || 0,
                            ":startRev": 0
                        }
                    };
                    
                    docClient.update(updateEventParams, function(updateErr) {
                        if (updateErr) {
                            console.error("Could not update ticketsSold for event", updateErr);
                            if (updateErr.code === 'ConditionalCheckFailedException') {
                                // Event was deleted, but ticket was already saved.
                                // We'll still return the ticket to not break the UI.
                            }
                        }
                        
                        // Dispatch ticket confirmation email via AWS SES (with EmailJS fallback)
                        window.AttendeeBackend.getUserProfile((profileErr, profile) => {
                            const userEmail = (!profileErr && profile && profile.email) ? profile.email : "attendee@example.com";
                            const userName = (!profileErr && profile) ? 
                                (profile.firstName && profile.lastName ? (profile.firstName + " " + profile.lastName).trim() : (profile.firstName || "Attendee")) 
                                : "Attendee";
                            
                            const qrPayload = `Ticket ID: ${ticketId}\nEvent: ${event.eventName || "Unnamed Event"}\nDate: ${event.date || "TBD"} at ${event.time || "TBD"}\nVenue: ${event.location || "TBA"}\nAttendee: ${userName}`;
                            const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(qrPayload)}&size=220`;

                            const emailPayload = {
                                type: 'ticket',
                                to_email: userEmail,
                                to_name: userName,
                                event_title: event.eventName || "Unnamed Event",
                                event_date: event.date || "TBD",
                                event_time: event.time || "TBD",
                                event_venue: event.location || "TBA",
                                ticket_id: ticketId,
                                quantity: qty,
                                price: event.price || 0,
                                qr_url: qrUrl
                            };

                            const apiEndpoint = (config.apiGatewayUrl || 'https://s3eg7kdaja.execute-api.ap-south-1.amazonaws.com/prod') + '/api/send-email';

                            // 1. Try sending via AWS SES via backend Lambda
                            fetch(apiEndpoint, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(emailPayload)
                            })
                            .then(res => res.json())
                            .then(data => {
                                if (data && data.success) {
                                    console.log('✅ Ticket email delivered via AWS SES (no-reply@eventpro24.online):', data);
                                } else {
                                    throw new Error(data && data.error ? data.error : 'SES response not successful');
                                }
                            })
                            .catch(sesErr => {
                                console.warn('AWS SES dispatch note, attempting EmailJS fallback:', sesErr.message || sesErr);
                                if (window.emailjs) {
                                    const templateParams = {
                                        to_email: userEmail,
                                        to_name: userName,
                                        event_title: event.eventName || "Unnamed Event",
                                        event_date: event.date || "TBD",
                                        event_venue: event.location || "TBA",
                                        ticket_id: ticketId,
                                        order_id: ticketId,
                                        qr_url: qrUrl
                                    };
                                    emailjs.send('service_w5mpz2s', 'template_cqxegxr', templateParams)
                                        .then(res => console.log('Email sent via EmailJS fallback!', res.status))
                                        .catch(e => console.warn('EmailJS fallback failed:', e));
                                }
                            });
                        });
                        
                        callback(null, ticketParams.Item);
                    });
                });
            });
        },
        
        getMyBookings: function(callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.ticketsTableName
                };
                
                docClient.scan(params, function(err, data) {
                    if (err) return callback(err);
                    
                    try {
                        // Gather any local passes saved in browser storage
                        const localPassIds = [];
                        try {
                            const cached = JSON.parse(localStorage.getItem('eventpro_my_passes') || '[]');
                            if (Array.isArray(cached)) {
                                cached.forEach(c => { if (c && c.ticketId) localPassIds.push(c.ticketId); });
                            }
                        } catch (e) {}

                        const emailLower = (currentUserEmail || '').toLowerCase();
                        const myTickets = (data.Items || []).filter(t => {
                            const isOwner = !!(t.attendeeId && currentUserSub && t.attendeeId === currentUserSub);
                            const isUser = !!(t.userId && currentUserSub && t.userId === currentUserSub);
                            const isEmail = !!(t.attendeeEmail && emailLower && t.attendeeEmail.toLowerCase() === emailLower);
                            const isLocalPass = !!(t.ticketId && localPassIds.includes(t.ticketId));
                            return isOwner || isUser || isEmail || isLocalPass;
                        });
                        callback(null, myTickets);
                    } catch (scanErr) {
                        console.error("getMyBookings error:", scanErr);
                        callback(scanErr);
                    }
                });
            });
        },

        cancelBooking: function(ticketId, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const getParams = {
                    TableName: config.ticketsTableName,
                    Key: { ticketId: ticketId }
                };

                docClient.get(getParams, function(getErr, data) {
                    if (getErr) return callback(getErr);
                    const ticket = data && data.Item;
                    if (!ticket) return callback(new Error("Ticket record not found"));

                    if (ticket.status === 'Cancelled') {
                        return callback(new Error("This ticket has already been cancelled."));
                    }
                    if (ticket.status === 'Used') {
                        return callback(new Error("Cannot cancel a ticket that has already been scanned/used at the gate."));
                    }

                    // Enforce 72-hour cancellation deadline prior to event start
                    const evaluateWindowAndProceed = (dateStr, timeStr) => {
                        const eventDate = getEventStartDateTime(dateStr, timeStr);
                        if (eventDate) {
                            const diffMs = eventDate.getTime() - Date.now();
                            const diffHours = diffMs / (1000 * 60 * 60);

                            if (diffHours < 0) {
                                return callback(new Error("Cannot cancel ticket. This event has already started or ended."));
                            }
                            if (diffHours < 72) {
                                const hoursLeft = Math.max(0, Math.floor(diffHours));
                                return callback(new Error(`Cancellation is disabled within 72 hours of the event start time. Only ${hoursLeft} hour(s) remaining until the event starts.`));
                            }
                        }

                        // Apply 2% deduction fee on cancellation
                        const originalPrice = parseFloat(ticket.perPersonAmount || ticket.price) || 0;
                        const cancellationFee = originalPrice > 0 ? (Math.round(originalPrice * 0.02 * 100) / 100) : 0;
                        const netRefundAmount = Math.max(0, Math.round((originalPrice - cancellationFee) * 100) / 100);
                        const depositRefunded = ticket.hasDeposit ? (parseFloat(ticket.depositAmount) || 0) : 0;
                        const paymentId = ticket.paymentId || null;
                        const now = new Date().toISOString();
                        const apiBase = config.apiGatewayUrl || 'https://s3eg7kdaja.execute-api.ap-south-1.amazonaws.com/prod';

                        const proceedWithCancellation = (gatewayNotice) => {
                            const depStatus = ticket.hasDeposit ? "Refunded (Cancelled)" : (ticket.depositStatus || "None");
                            const updateParams = {
                                TableName: config.ticketsTableName,
                                Key: { ticketId: ticketId },
                                UpdateExpression: "SET #s = :status, cancelledAt = :now, refundStatus = :refundStatus, refundAmount = :refAmt, originalPrice = :origPrice, cancellationFee = :fee, cancellationDeductionPercent = :deductPct, depositStatus = :depStatus",
                                ExpressionAttributeNames: { "#s": "status" },
                                ExpressionAttributeValues: {
                                    ":status": "Cancelled",
                                    ":now": now,
                                    ":refundStatus": netRefundAmount > 0 ? "Processed (2% fee deducted)" : "No Charge",
                                    ":refAmt": netRefundAmount,
                                    ":origPrice": originalPrice,
                                    ":fee": cancellationFee,
                                    ":deductPct": 2,
                                    ":depStatus": depStatus
                                },
                                ReturnValues: "ALL_NEW"
                            };

                            docClient.update(updateParams, function(updateErr, updateResult) {
                                if (updateErr) return callback(updateErr);

                                // Rollback Event Capacity & Revenue in DynamoDB
                                if (ticket.eventId) {
                                    const qty = parseInt(ticket.quantity, 10) || 1;
                                    const eventRollbackParams = {
                                        TableName: config.eventsTableName,
                                        Key: { eventId: ticket.eventId },
                                        UpdateExpression: "SET ticketsSold = if_not_exists(ticketsSold, :zero) - :qty, revenue = if_not_exists(revenue, :zero) - :price",
                                        ConditionExpression: "attribute_exists(eventId)",
                                        ExpressionAttributeValues: {
                                            ":qty": qty,
                                            ":price": netRefundAmount,
                                            ":zero": 0
                                        }
                                    };

                                    docClient.update(eventRollbackParams, function(evErr) {
                                        if (evErr) console.warn("Notice: could not rollback ticketsSold on event:", evErr.message);

                                        // District-style Waitlist Automation: Automatically re-allocate opening to priority waitlist
                                        if (window.AttendeeBackend && typeof window.AttendeeBackend.processWaitlistPromotion === 'function') {
                                            window.AttendeeBackend.processWaitlistPromotion(ticket.eventId, ticket.eventName);
                                        }
                                    });
                                }

                                // Send SES Cancellation & Refund Confirmation Email with 2% deduction details
                                const attendeeEmail = ticket.attendeeEmail || currentUserEmail;
                                if (attendeeEmail) {
                                    fetch(`${apiBase}/api/send-email`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            type: 'cancellation',
                                            to_email: attendeeEmail,
                                            to_name: ticket.attendeeName || 'Attendee',
                                            event_title: ticket.eventName || 'Event',
                                            ticket_id: ticket.ticketId,
                                            original_price: originalPrice,
                                            cancellation_fee: cancellationFee,
                                            refund_amount: netRefundAmount,
                                            deposit_refunded: depositRefunded
                                        })
                                    }).catch(emailErr => console.warn("Notice: cancellation email dispatch exception:", emailErr));
                                }

                                callback(null, {
                                    success: true,
                                    ticketId: ticketId,
                                    originalPrice: originalPrice,
                                    cancellationFee: cancellationFee,
                                    refundAmount: netRefundAmount,
                                    depositRefunded: depositRefunded,
                                    refundStatus: netRefundAmount > 0 ? "Processed (2% fee deducted)" : "No Charge",
                                    gatewayNotice: gatewayNotice,
                                    updatedTicket: updateResult ? updateResult.Attributes : ticket
                                });
                            });
                        };

                        // Trigger payment gateway partial refund for netRefundAmount
                        if (paymentId && netRefundAmount > 0) {
                            fetch(`${apiBase}/api/payment/refund`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    payment_id: paymentId,
                                    amount: netRefundAmount,
                                    notes: { 
                                        ticketId: ticket.ticketId, 
                                        eventId: ticket.eventId,
                                        originalPrice: originalPrice,
                                        cancellationFee: cancellationFee,
                                        deduction: "2%"
                                    }
                                })
                            })
                            .then(res => res.json())
                            .then(refRes => {
                                proceedWithCancellation(refRes && refRes.message);
                            })
                            .catch(refErr => {
                                console.warn("Gateway refund warning:", refErr);
                                proceedWithCancellation("Gateway notice: logged in ledger");
                            });
                        } else {
                            proceedWithCancellation(null);
                        }
                    };

                    // Check date/time from ticket, fallback to event record if missing/TBD
                    const hasValidDate = ticket.date && ticket.date !== 'TBD' && ticket.date !== 'TBA';
                    const hasValidTime = ticket.time && ticket.time !== 'TBD' && ticket.time !== 'TBA';

                    if (hasValidDate && hasValidTime) {
                        evaluateWindowAndProceed(ticket.date, ticket.time);
                    } else if (ticket.eventId) {
                        docClient.get({
                            TableName: config.eventsTableName,
                            Key: { eventId: ticket.eventId }
                        }, function(evErr, evData) {
                            const ev = evData && evData.Item;
                            const evDate = (ev && ev.date) || ticket.date;
                            const evTime = (ev && ev.time) || ticket.time;
                            evaluateWindowAndProceed(evDate, evTime);
                        });
                    } else {
                        evaluateWindowAndProceed(ticket.date, ticket.time);
                    }
                });
            });
        },

        getSplitTicket: function(ticketId, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                const params = {
                    TableName: config.ticketsTableName,
                    Key: { ticketId: ticketId }
                };
                docClient.get(params, function(getErr, data) {
                    if (getErr) return callback(getErr);
                    if (!data || !data.Item) return callback(new Error("Ticket record not found"));
                    callback(null, data.Item);
                });
            });
        },

        getTicketById: function(ticketId, callback) {
            return this.getSplitTicket(ticketId, callback);
        },

        updateSplitPayment: function(ticketId, memberIndex, payerNameOrCb, payerEmailOrCb, callback) {
            let payerName = null;
            let payerEmail = null;
            let cb = null;

            if (typeof payerNameOrCb === 'string') {
                payerName = payerNameOrCb;
            } else if (typeof payerNameOrCb === 'function') {
                cb = payerNameOrCb;
            }

            if (typeof payerEmailOrCb === 'string') {
                payerEmail = payerEmailOrCb;
                cb = callback;
            } else if (typeof payerEmailOrCb === 'function') {
                cb = payerEmailOrCb;
            }

            initAWS((err) => {
                if (err) return cb(err);
                const params = {
                    TableName: config.ticketsTableName,
                    Key: { ticketId: ticketId }
                };
                docClient.get(params, (getErr, data) => {
                    if (getErr || !data.Item) return cb(getErr || new Error("Ticket record not found"));
                    const t = data.Item;
                    if (!t.splitMembers || !t.splitMembers[memberIndex]) {
                        return cb(new Error("Split member not found"));
                    }

                    t.splitMembers[memberIndex].status = "Paid";
                    t.splitMembers[memberIndex].paidAt = new Date().toISOString();
                    if (payerName) {
                        t.splitMembers[memberIndex].name = payerName;
                    }
                    if (payerEmail) {
                        t.splitMembers[memberIndex].email = payerEmail;
                    }
                    const paidCount = t.splitMembers.filter(m => m.status === "Paid").length;
                    t.paidMembers = paidCount;
                    if (paidCount >= (t.totalSplitMembers || 2)) {
                        t.status = "Valid";
                        t.splitStatus = "Fully Settled";
                    }

                    const memberTicketId = `${ticketId}-M${memberIndex + 1}`;
                    t.splitMembers[memberIndex].memberTicketId = memberTicketId;

                    const subTicketItem = {
                        ticketId: memberTicketId,
                        parentTicketId: ticketId,
                        eventId: t.eventId,
                        eventName: t.eventName,
                        attendeeName: payerName || `Friend #${memberIndex + 1}`,
                        attendeeEmail: payerEmail || null,
                        attendeeId: currentUserSub || t.attendeeId,
                        status: "Valid",
                        date: t.date,
                        time: t.time,
                        location: t.location,
                        quantity: 1,
                        price: t.perPersonAmount || Math.round((t.price || 0) / (t.totalSplitMembers || 2)),
                        purchasedAt: new Date().toISOString(),
                        isGroupSplitMember: true,
                        memberIndex: memberIndex
                    };

                    docClient.put({ TableName: config.ticketsTableName, Item: subTicketItem }, (subErr) => {
                        if (subErr) console.warn("Could not save member sub-ticket:", subErr);
                    });

                    const updateParams = {
                        TableName: config.ticketsTableName,
                        Key: { ticketId: ticketId },
                        UpdateExpression: "SET splitMembers = :sm, paidMembers = :pm, #s = :st, splitStatus = :ss",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: {
                            ":sm": t.splitMembers,
                            ":pm": paidCount,
                            ":st": t.status,
                            ":ss": t.splitStatus || "Pending Friends"
                        },
                        ReturnValues: "ALL_NEW"
                    };

                    docClient.update(updateParams, (upErr, upData) => {
                        if (upErr) return cb(upErr);
                        const resultAttr = upData.Attributes || t;
                        resultAttr.activeMemberTicketId = memberTicketId;
                        cb(null, resultAttr);
                    });
                });
            });
        },
        
        getUserProfile: function(callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.dynamoDBTableName,
                    Key: { userId: currentUserSub }
                };
                
                docClient.get(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data.Item || {});
                });
            });
        },
        
        updateUserProfile: function(userData, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.dynamoDBTableName,
                    Key: { userId: currentUserSub },
                    UpdateExpression: "set firstName = :f, lastName = :l, email = :e",
                    ExpressionAttributeValues: {
                        ":f": userData.firstName,
                        ":l": userData.lastName,
                        ":e": userData.email
                    }
                };
                
                docClient.update(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data);
                });
            });
        },

        toggleSavedEvent: function(eventId, callback) {
            initAWS((err) => {
                if (err) return callback(err);

                // Fetch current user profile to get saved events array
                window.AttendeeBackend.getUserProfile((err, profile) => {
                    if (err) return callback(err);

                    let savedEvents = profile.savedEvents || [];
                    const index = savedEvents.indexOf(eventId);
                    let isSaved = false;

                    if (index > -1) {
                        savedEvents.splice(index, 1);
                    } else {
                        savedEvents.push(eventId);
                        isSaved = true;
                    }

                    const params = {
                        TableName: config.dynamoDBTableName,
                        Key: { userId: currentUserSub },
                        UpdateExpression: "set savedEvents = :s",
                        ExpressionAttributeValues: {
                            ":s": savedEvents
                        }
                    };
                    
                    docClient.update(params, function(err) {
                        if (err) callback(err);
                        else callback(null, { isSaved, savedEvents });
                    });
                });
            });
        },

        joinWaitlist: function(event, callback) {
            initAWS((err) => {
                if (err) return callback(err);

                window.AttendeeBackend.getUserProfile((pErr, profile) => {
                    const attendeeName = (profile && profile.firstName) ? (profile.firstName + " " + (profile.lastName || '')).trim() : 'Event Enthusiast';
                    const attendeeEmail = (profile && profile.email) || currentUserEmail || null;

                    const waitlistTicket = {
                        ticketId: "WTL-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
                        eventId: event.eventId,
                        eventName: event.eventName,
                        date: event.date,
                        time: event.time,
                        location: event.location,
                        userId: currentUserSub,
                        attendeeName: attendeeName,
                        attendeeEmail: attendeeEmail,
                        status: "Waitlisted",
                        price: event.price || 0,
                        purchaseDate: new Date().toISOString()
                    };

                    const params = {
                        TableName: config.ticketsTableName,
                        Item: waitlistTicket
                    };

                    docClient.put(params, function(err, data) {
                        if (err) callback(err);
                        else callback(null, waitlistTicket);
                    });
                });
            });
        },

        processWaitlistPromotion: function(eventId, eventName, callback) {
            if (!eventId) return;
            initAWS((err) => {
                if (err) return;

                const params = {
                    TableName: config.ticketsTableName,
                    FilterExpression: "eventId = :eid AND #s = :waitlisted",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: {
                        ":eid": eventId,
                        ":waitlisted": "Waitlisted"
                    }
                };

                docClient.scan(params, function(scanErr, data) {
                    if (scanErr || !data || !data.Items || data.Items.length === 0) return;

                    // Sort FIFO by registration / purchase date
                    const queue = data.Items.sort((a, b) => new Date(a.purchaseDate || 0) - new Date(b.purchaseDate || 0));
                    const nextInLine = queue[0];
                    if (!nextInLine || !nextInLine.ticketId) return;

                    // Unlock spot for next in line (24h window)
                    const updateParams = {
                        TableName: config.ticketsTableName,
                        Key: { ticketId: nextInLine.ticketId },
                        UpdateExpression: "SET #s = :offered, spotOfferedAt = :now, expiresAt = :exp",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: {
                            ":offered": "Spot_Offered",
                            ":now": new Date().toISOString(),
                            ":exp": new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
                        }
                    };

                    docClient.update(updateParams, function(upErr) {
                        if (upErr) console.warn("Could not promote waitlisted ticket:", upErr);

                        const targetEmail = nextInLine.attendeeEmail || nextInLine.userEmail;
                        const targetName = nextInLine.attendeeName || 'Event Enthusiast';
                        const apiBase = (config && config.apiGatewayUrl) ? config.apiGatewayUrl.replace(/\/+$/, '') : 'https://s3eg7kdaja.execute-api.ap-south-1.amazonaws.com/prod';

                        if (targetEmail) {
                            fetch(`${apiBase}/api/send-email`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    type: 'waitlist_promoted',
                                    to_email: targetEmail,
                                    to_name: targetName,
                                    event_title: eventName || nextInLine.eventName || 'Event',
                                    ticket_id: nextInLine.ticketId,
                                    claim_url: 'https://eventpro24.online/Attendee_Dashboard/Your_Booking.html'
                                })
                            }).catch(emailErr => console.warn("Waitlist notification email exception:", emailErr));
                        }

                        // Add high-priority real-time alert for this attendee
                        if (nextInLine.userId) {
                            const alertParams = {
                                TableName: config.alertsTableName || "EventProAlerts",
                                Item: {
                                    alertId: "ALT-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
                                    userId: nextInLine.userId,
                                    eventId: eventId,
                                    title: `🎉 Spot Unlocked: ${eventName || 'Event'}!`,
                                    message: `A ticket opened up via cancellation under our 72h policy! Your spot is reserved for 24 hours. Open My Bookings to claim your ticket.`,
                                    priority: "high",
                                    type: "waitlist_unlocked",
                                    timestamp: new Date().toISOString()
                                }
                            };
                            docClient.put(alertParams, () => {});
                        }

                        if (typeof callback === 'function') callback(null, nextInLine);
                    });
                });
            });
        },

        submitReview: function(eventId, rating, comment, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                window.AttendeeBackend.getUserProfile((profileErr, profile) => {
                    const userName = (!profileErr && profile) ? (profile.firstName + " " + profile.lastName) : "Anonymous Attendee";
                    
                    const params = {
                        TableName: config.reviewsTableName,
                        Item: {
                            reviewId: "REV-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
                            eventId: eventId,
                            userId: currentUserSub,
                            userName: userName,
                            rating: rating,
                            comment: comment,
                            timestamp: new Date().toISOString()
                        }
                    };
                    
                    docClient.put(params, function(err, data) {
                        if (err) callback(err);
                        else callback(null, params.Item);
                    });
                });
            });
        },

        getEventReviews: function(eventId, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.reviewsTableName,
                    FilterExpression: "eventId = :eid",
                    ExpressionAttributeValues: {
                        ":eid": eventId
                    }
                };
                
                docClient.scan(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data.Items);
                });
            });
        },

        getAttendeeAlerts: function(callback) {
            initAWS((err) => {
                if (err) return callback(err);

                this.getMyBookings((bookErr, tickets) => {
                    const myTickets = (tickets || []).filter(t => t.status !== 'Cancelled');
                    const myEventIds = myTickets.map(t => t.eventId).filter(Boolean);

                    const readList = JSON.parse(localStorage.getItem('eventpro_read_alerts_' + (currentUserSub || 'anon')) || '[]');

                    // 1. Gather DynamoDB / stored broadcast alerts
                    const fetchStoredAlerts = (done) => {
                        const params = {
                            TableName: config.alertsTableName || "EventProAlerts"
                        };

                        docClient.scan(params, (scanErr, data) => {
                            let rawAlerts = [];
                            if (!scanErr && data && data.Items) {
                                rawAlerts = data.Items;
                            }
                            // Merge with local persistent broadcast pool
                            try {
                                const localPool = JSON.parse(localStorage.getItem('eventpro_broadcast_alerts') || '[]');
                                localPool.forEach(lp => {
                                    if (!rawAlerts.some(ra => ra.alertId === lp.alertId)) {
                                        rawAlerts.push(lp);
                                    }
                                });
                            } catch(e) {}
                            done(rawAlerts);
                        });
                    };

                    fetchStoredAlerts((allAlerts) => {
                        // Filter for alerts matching the attendee's booked events
                        let relevantAlerts = allAlerts.filter(a => myEventIds.includes(a.eventId) || a.eventId === 'ALL');

                        // 2. Automated Smart Reminders for upcoming events
                        const now = new Date();
                        myTickets.forEach(ticket => {
                            if (ticket.date && ticket.date !== 'TBD' && ticket.date !== 'TBA') {
                                const eventDate = getEventStartDateTime(ticket.date, ticket.time);
                                if (eventDate) {
                                    const diffHours = (eventDate - now) / (1000 * 60 * 60);
                                    // Event happening within the next 48 hours or today
                                    if (diffHours >= -6 && diffHours <= 48) {
                                        const reminderId = `REM-${ticket.ticketId}`;
                                        if (!relevantAlerts.some(a => a.alertId === reminderId)) {
                                            relevantAlerts.push({
                                                alertId: reminderId,
                                                eventId: ticket.eventId,
                                                eventName: ticket.eventName,
                                                title: `⏰ Event Reminder: ${ticket.eventName}`,
                                                message: `Your event is scheduled for ${ticket.date} at ${ticket.time || 'TBD'} (${ticket.location || 'TBA'}). Keep your ticket QR pass ready for check-in!`,
                                                priority: "important",
                                                type: "reminder",
                                                createdAt: new Date().toISOString()
                                            });
                                        }
                                    }
                                }
                            }
                        });

                        // Tag read state
                        relevantAlerts.forEach(a => {
                            a.isRead = readList.includes(a.alertId);
                        });

                        // Sort by createdAt descending
                        relevantAlerts.sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

                        const unreadCount = relevantAlerts.filter(a => !a.isRead).length;
                        callback(null, relevantAlerts, unreadCount);
                    });
                });
            });
        },

        markAlertAsRead: function(alertId, callback) {
            try {
                const key = 'eventpro_read_alerts_' + (currentUserSub || 'anon');
                const readList = JSON.parse(localStorage.getItem(key) || '[]');
                if (!readList.includes(alertId)) {
                    readList.push(alertId);
                    localStorage.setItem(key, JSON.stringify(readList));
                }
                if (callback) callback(null);
            } catch(e) {
                if (callback) callback(e);
            }
        },

        markAllAlertsAsRead: function(alertIds, callback) {
            try {
                const key = 'eventpro_read_alerts_' + (currentUserSub || 'anon');
                let readList = JSON.parse(localStorage.getItem(key) || '[]');
                (alertIds || []).forEach(id => {
                    if (!readList.includes(id)) readList.push(id);
                });
                localStorage.setItem(key, JSON.stringify(readList));
                if (callback) callback(null);
            } catch(e) {
                if (callback) callback(e);
            }
        }
    };
})();
