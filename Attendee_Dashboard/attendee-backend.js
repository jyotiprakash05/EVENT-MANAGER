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
        if (!dlString || typeof dlString !== 'string') return null;
        dlString = dlString.trim();
        if (!dlString) return null;

        // Try native Date parse
        let d = new Date(dlString);
        if (!isNaN(d.getTime())) return d;

        // Parse format "YYYY-MM-DD [HH:MM] [AM|PM]"
        const match = dlString.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?)?/i);
        if (match) {
            const year = parseInt(match[1], 10);
            const month = parseInt(match[2], 10) - 1;
            const day = parseInt(match[3], 10);
            let hour = match[4] !== undefined ? parseInt(match[4], 10) : 23;
            let min = match[5] !== undefined ? parseInt(match[5], 10) : 59;
            const ampm = match[6] ? match[6].toUpperCase() : null;

            if (ampm === 'PM' && hour < 12) hour += 12;
            if (ampm === 'AM' && hour === 12) hour = 0;

            return new Date(year, month, day, hour, min, 59);
        }
        return null;
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
            const deadline = parseDeadline(dl);
            if (deadline && new Date() > deadline) {
                return true; // Sales deadline has passed
            }
        }
        return false;
    }

    window.AttendeeBackend = {
        isEventSalesClosed: isEventSalesClosed,
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
                        
                        if (window.emailjs) {
                            window.AttendeeBackend.getUserProfile((profileErr, profile) => {
                                const userEmail = (!profileErr && profile && profile.email) ? profile.email : "attendee@example.com";
                                const userName = (!profileErr && profile) ? 
                                    (profile.firstName && profile.lastName ? (profile.firstName + " " + profile.lastName).trim() : (profile.firstName || "Attendee")) 
                                    : "Attendee";
                                
                                const qrPayload = `Ticket ID: ${ticketId}\nEvent: ${event.eventName || "Unnamed Event"}\nDate: ${event.date || "TBD"} at ${event.time || "TBD"}\nVenue: ${event.location || "TBA"}\nAttendee: ${userName}`;

                                const templateParams = {
                                    to_email: userEmail,
                                    to_name: userName,
                                    event_title: event.eventName || "Unnamed Event",
                                    event_date: event.date || "TBD",
                                    event_venue: event.location || "TBA",
                                    ticket_id: ticketId,
                                    order_id: ticketId,
                                    // Use quickchart or put data first so that if & is escaped to &amp; by EmailJS, the QR code still generates
                                    qr_url: `https://quickchart.io/qr?text=${encodeURIComponent(qrPayload)}&size=200`
                                };
                                
                                emailjs.send('service_w5mpz2s', 'template_cqxegxr', templateParams)
                                    .then(function(response) {
                                        console.log('Email sent!', response.status, response.text);
                                    }, function(error) {
                                        console.log('Failed to send email...', error);
                                    });
                            });
                        }
                        
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
                
                const params = {
                    TableName: config.ticketsTableName,
                    Key: { ticketId: ticketId },
                    UpdateExpression: "set #s = :status",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: { ":status": "Cancelled" }
                };
                
                docClient.update(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data);
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

                const waitlistTicket = {
                    ticketId: "WTL-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
                    eventId: event.eventId,
                    eventName: event.eventName,
                    date: event.date,
                    time: event.time,
                    location: event.location,
                    userId: currentUserSub,
                    status: "Waitlisted",
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
                            if (ticket.date && ticket.date !== 'TBD') {
                                const eventDate = new Date(ticket.date);
                                if (!isNaN(eventDate.getTime())) {
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
